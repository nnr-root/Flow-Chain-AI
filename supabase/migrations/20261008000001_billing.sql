-- Flow Chain studio: paying for credit (3.4 spec §4).
--
-- Two kinds of credit share one balance. `plan_credit_usd` is the part of `balance_usd` that came from the
-- current subscription month: it is spent first and expires when the month ends. Everything else — a top-up,
-- credit granted by hand — never expires. Every function that turns a Stripe event into credit records the
-- event's id in the same transaction, so the same event can never be fulfilled twice. As in the first
-- migration, users only read their own rows; everything here that writes is for the worker's key alone.

alter table public.users
  add column stripe_customer_id text unique,
  -- how much of the balance expires with the current subscription month
  add column plan_credit_usd numeric(12, 4) not null default 0 check (plan_credit_usd >= 0 and plan_credit_usd <> 'NaN'),
  -- goes up by one whenever a subscription month ends: credit held by a job in an earlier month is not returned
  add column plan_period integer not null default 0;

-- What can expire is never more than what is there. Credit leaves the balance in ways that know nothing of
-- plans — a refund of a top-up that was spent, credit taken back by hand, a job settled above its cap — and
-- without this the next expiry would take the same money a second time. So the rule is kept where no function
-- can forget it: on every write of the row.
create function public.plan_credit_within_balance() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.plan_credit_usd := greatest(least(new.plan_credit_usd, new.balance_usd), 0);
  return new;
end $$;
create trigger plan_credit_within_balance before insert or update on public.users
  for each row execute function public.plan_credit_within_balance();

alter table public.reservations
  -- how much of the cap was plan credit, and of which month
  add column plan_part_usd numeric(12, 4) not null default 0 check (plan_part_usd >= 0 and plan_part_usd <> 'NaN'),
  add column plan_period integer not null default 0;

alter table public.ledger drop constraint ledger_kind_check;
alter table public.ledger add constraint ledger_kind_check
  check (kind in ('grant', 'reserve', 'settle', 'purchase', 'plan', 'expire', 'refund'));

create table public.subscriptions (
  -- one subscription per user
  user_id uuid primary key references public.users (id) on delete cascade,
  stripe_subscription_id text not null unique,
  plan text not null,
  price_id text not null,
  status text not null,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  updated_at timestamptz not null default now()
);

create table public.payments (
  -- the Stripe invoice (a subscription month) or Checkout session (a top-up) that was paid
  id text primary key,
  user_id uuid not null references public.users (id) on delete restrict,
  kind text not null check (kind in ('topup', 'plan')),
  plan text,
  paid_usd numeric(12, 4) not null check (paid_usd >= 0 and paid_usd <> 'NaN'),
  credit_usd numeric(12, 4) not null check (credit_usd >= 0 and credit_usd <> 'NaN'),
  refunded_usd numeric(12, 4) not null default 0 check (refunded_usd >= 0 and refunded_usd <> 'NaN'),
  -- how much of the credit has been taken back for refunds so far
  taken_back_usd numeric(12, 4) not null default 0 check (taken_back_usd >= 0 and taken_back_usd <> 'NaN'),
  -- the subscription month this payment's credit belongs to (plan payments)
  plan_period integer,
  charge_id text,
  invoice_url text,
  created_at timestamptz not null default now()
);
create index payments_by_user on public.payments (user_id, created_at desc);
create unique index payments_by_charge on public.payments (charge_id) where charge_id is not null;

create table public.stripe_events (
  id text primary key,
  type text not null,
  user_id uuid,
  outcome text not null default 'fulfilled',
  created_at timestamptz not null default now()
);

alter table public.subscriptions enable row level security;
alter table public.payments enable row level security;
alter table public.stripe_events enable row level security;
create policy "own row" on public.subscriptions for select to authenticated using (user_id = (select auth.uid()));
create policy "own rows" on public.payments for select to authenticated using (user_id = (select auth.uid()));
-- (said outright, whichever role applies this file: nothing but reading their own rows, and nothing of the events)
revoke all on public.subscriptions, public.payments, public.stripe_events from public, anon, authenticated;
-- stripe_events: no policy, so nobody but the service role reads it
grant select on public.subscriptions, public.payments to authenticated;

-- ---------------------------------------------------------------------------------------------------------
-- Holding and settling credit, now of two kinds.

-- The cap is taken from plan credit first. How much of it was plan credit, and of which month, is recorded on
-- the reservation: that part is only ever returned to the month it came from.
create or replace function public.reserve_credit(p_run_id text, p_kind text, p_cap_usd numeric) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_cap numeric(12, 4) := round(p_cap_usd, 4);
  v_balance numeric(12, 4);
  v_plan numeric(12, 4);
  v_period integer;
  v_part numeric(12, 4);
  v_id uuid;
begin
  if v_user is null then raise exception 'unauthenticated'; end if;
  if v_cap is null or v_cap = 'NaN' or v_cap < 0 or v_cap > 1000 then raise exception 'invalid_amount'; end if;
  if p_kind is null or p_kind not in ('draft', 'generate', 'reroll') then raise exception 'invalid_kind'; end if;
  select balance_usd, plan_credit_usd, plan_period into v_balance, v_plan, v_period from public.users where id = v_user for update;
  if not found then raise exception 'unauthenticated'; end if;
  if not exists (select 1 from public.runs where id = p_run_id and user_id = v_user) then raise exception 'not_found'; end if;
  if exists (select 1 from public.reservations where run_id = p_run_id and status = 'open') then raise exception 'job_active'; end if;
  if (select count(*) from public.reservations where user_id = v_user and status = 'open')
     >= (select max_user_jobs from public.settings) then
    raise exception 'too_many_jobs';
  end if;
  if v_balance < v_cap then raise exception 'insufficient_credit'; end if;

  v_part := least(v_cap, v_plan);
  update public.users set balance_usd = balance_usd - v_cap, plan_credit_usd = plan_credit_usd - v_part
    where id = v_user returning balance_usd into v_balance;
  insert into public.reservations (user_id, run_id, kind, cap_usd, plan_part_usd, plan_period)
    values (v_user, p_run_id, p_kind, v_cap, v_part, v_period) returning id into v_id;
  insert into public.ledger (user_id, run_id, reservation_id, kind, amount_usd, balance_after_usd, note)
    values (v_user, p_run_id, v_id, 'reserve', -v_cap, v_balance, p_kind);
  return v_id;
end $$;

-- The charge consumes the reservation's plan part first. What is left of that part goes back to plan credit
-- when its month is still the current one; after a renewal it has expired with its month and is not returned.
create or replace function public.settle(p_reservation_id uuid, p_run_total_usd numeric) returns numeric
language plpgsql security definer set search_path = '' as $$
declare
  r public.reservations%rowtype;
  v_total numeric(12, 4);
  v_already numeric(12, 4);
  v_charge numeric(12, 4);
  v_balance numeric(12, 4);
  v_period integer;
  v_plan_left numeric(12, 4);
begin
  if p_run_total_usd is null or p_run_total_usd = 'NaN' or p_run_total_usd < 0 or p_run_total_usd > 100000 then
    raise exception 'invalid_amount';
  end if;
  v_total := round(p_run_total_usd, 4);
  select * into r from public.reservations where id = p_reservation_id for update;
  if not found then raise exception 'not_found'; end if;
  if r.status <> 'open' then return r.charged_usd; end if;
  select charged_usd into v_already from public.runs where id = r.run_id for update;
  v_charge := greatest(v_total - v_already, 0);
  select plan_period into v_period from public.users where id = r.user_id for update;
  v_plan_left := r.plan_part_usd - least(v_charge, r.plan_part_usd);

  if v_period = r.plan_period then
    update public.users set balance_usd = balance_usd + r.cap_usd - v_charge, plan_credit_usd = plan_credit_usd + v_plan_left
      where id = r.user_id returning balance_usd into v_balance;
  else
    update public.users set balance_usd = balance_usd + r.cap_usd - v_charge - v_plan_left
      where id = r.user_id returning balance_usd into v_balance;
  end if;
  update public.runs set charged_usd = greatest(charged_usd, v_total), updated_at = now() where id = r.run_id;
  update public.reservations set status = 'settled', charged_usd = v_charge, settled_at = now() where id = r.id;
  insert into public.ledger (user_id, run_id, reservation_id, kind, amount_usd, balance_after_usd, note)
    values (r.user_id, r.run_id, r.id, 'settle', r.cap_usd - v_charge,
            case when v_period = r.plan_period then v_balance else v_balance + v_plan_left end,
            'charged ' || v_charge || ' of ' || r.cap_usd);
  if v_period <> r.plan_period and v_plan_left > 0 then
    insert into public.ledger (user_id, run_id, reservation_id, kind, amount_usd, balance_after_usd, note)
      values (r.user_id, r.run_id, r.id, 'expire', -v_plan_left, v_balance, 'held from a month that has ended');
  end if;
  return v_charge;
end $$;

-- ---------------------------------------------------------------------------------------------------------
-- Stripe: who a customer is, and what its payments grant. For the worker's key only.

create function public.link_stripe_customer(p_user_id uuid, p_customer_id text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_current text;
begin
  if p_customer_id is null or p_customer_id !~ '^cus_[A-Za-z0-9_]+$' then raise exception 'invalid_customer'; end if;
  select stripe_customer_id into v_current from public.users where id = p_user_id for update;
  if not found then raise exception 'not_found'; end if;
  if v_current = p_customer_id then return; end if;
  if v_current is not null then raise exception 'already_linked'; end if;
  begin
    update public.users set stripe_customer_id = p_customer_id where id = p_user_id;
  exception when unique_violation then
    raise exception 'customer_taken';
  end;
end $$;

-- Records an event as being dealt with. False when it already was: the caller then does nothing.
create function public.claim_stripe_event(p_event_id text, p_type text, p_user_id uuid, p_outcome text default 'fulfilled') returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if p_event_id is null or p_event_id = '' then raise exception 'invalid_event'; end if;
  insert into public.stripe_events (id, type, user_id, outcome) values (p_event_id, p_type, p_user_id, p_outcome)
    on conflict (id) do nothing;
  return found;
end $$;

create function public.valid_amount(p numeric) returns boolean
language sql immutable set search_path = '' as $$
  select p is not null and p <> 'NaN' and p >= 0 and p <= 100000
$$;

-- A one-off purchase: permanent credit.
create function public.fulfil_topup(
  p_event_id text, p_user_id uuid, p_payment_id text, p_paid_usd numeric, p_credit_usd numeric,
  p_charge_id text default null, p_invoice_url text default null
) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_credit numeric(12, 4) := round(p_credit_usd, 4);
  v_balance numeric(12, 4);
begin
  if not public.valid_amount(p_paid_usd) or not public.valid_amount(p_credit_usd) then raise exception 'invalid_amount'; end if;
  perform 1 from public.users where id = p_user_id for update;
  if not found then raise exception 'not_found'; end if;
  if not public.claim_stripe_event(p_event_id, 'topup', p_user_id) then return 'duplicate'; end if;
  -- another event for a payment that was fulfilled already (Stripe has several that mean "paid")
  if exists (select 1 from public.payments where id = p_payment_id) then
    update public.stripe_events set outcome = 'duplicate_payment' where id = p_event_id;
    return 'duplicate_payment';
  end if;
  update public.users set balance_usd = balance_usd + v_credit where id = p_user_id returning balance_usd into v_balance;
  insert into public.payments (id, user_id, kind, paid_usd, credit_usd, charge_id, invoice_url)
    values (p_payment_id, p_user_id, 'topup', round(p_paid_usd, 4), v_credit, p_charge_id, p_invoice_url);
  insert into public.ledger (user_id, kind, amount_usd, balance_after_usd, note) values (p_user_id, 'purchase', v_credit, v_balance, p_payment_id);
  return 'fulfilled';
end $$;

-- What is left of the month's credit goes; the month counter moves on. Returns the balance afterwards.
create function public.expire_plan_credit(p_user_id uuid, p_note text) returns numeric
language plpgsql security definer set search_path = '' as $$
declare
  v_left numeric(12, 4);
  v_balance numeric(12, 4);
begin
  select plan_credit_usd into v_left from public.users where id = p_user_id for update;
  update public.users set balance_usd = balance_usd - v_left, plan_credit_usd = 0, plan_period = plan_period + 1
    where id = p_user_id returning balance_usd into v_balance;
  if v_left > 0 then
    insert into public.ledger (user_id, kind, amount_usd, balance_after_usd, note) values (p_user_id, 'expire', -v_left, v_balance, p_note);
  end if;
  return v_balance;
end $$;

-- A subscription month that was paid for: last month's unused credit expires, this month's is granted.
create function public.fulfil_plan_invoice(
  p_event_id text, p_user_id uuid, p_invoice_id text, p_subscription_id text, p_plan text, p_price_id text,
  p_paid_usd numeric, p_credit_usd numeric, p_period_end timestamptz,
  p_charge_id text default null, p_invoice_url text default null
) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_credit numeric(12, 4) := round(p_credit_usd, 4);
  v_balance numeric(12, 4);
  v_period integer;
  v_second boolean;
begin
  if not public.valid_amount(p_paid_usd) or not public.valid_amount(p_credit_usd) then raise exception 'invalid_amount'; end if;
  perform 1 from public.users where id = p_user_id for update;
  if not found then raise exception 'not_found'; end if;
  if not public.claim_stripe_event(p_event_id, 'plan', p_user_id) then return 'duplicate'; end if;
  if exists (select 1 from public.payments where id = p_invoice_id) then
    update public.stripe_events set outcome = 'duplicate_payment' where id = p_event_id;
    return 'duplicate_payment';
  end if;
  -- A second subscription beside a live one (two checkouts paid at once: the studio refuses to open one, but
  -- cannot stop two that are already open). It was paid for, so it grants; it is not a new month of the first,
  -- so it expires nothing and the row keeps describing the first. The outcome says so, for the owner to see.
  v_second := exists (select 1 from public.subscriptions
    where user_id = p_user_id and stripe_subscription_id <> p_subscription_id and status in ('active', 'trialing', 'past_due'));
  if not v_second then perform public.expire_plan_credit(p_user_id, 'the month ended'); end if;
  -- A balance that is below zero is a debt, and the new month's credit pays it first: only what is left of the
  -- grant after that is credit that can expire.
  update public.users
    set balance_usd = balance_usd + v_credit,
        plan_credit_usd = greatest(least(plan_credit_usd + v_credit, balance_usd + v_credit), 0)
    where id = p_user_id returning balance_usd, plan_period into v_balance, v_period;
  insert into public.payments (id, user_id, kind, plan, paid_usd, credit_usd, plan_period, charge_id, invoice_url)
    values (p_invoice_id, p_user_id, 'plan', p_plan, round(p_paid_usd, 4), v_credit, v_period, p_charge_id, p_invoice_url);
  insert into public.ledger (user_id, kind, amount_usd, balance_after_usd, note) values (p_user_id, 'plan', v_credit, v_balance, p_plan);
  if v_second then
    update public.stripe_events set outcome = 'second_subscription' where id = p_event_id;
    return 'second_subscription';
  end if;
  insert into public.subscriptions (user_id, stripe_subscription_id, plan, price_id, status, current_period_end, cancel_at_period_end)
    values (p_user_id, p_subscription_id, p_plan, p_price_id, 'active', p_period_end, false)
    on conflict (user_id) do update
      set stripe_subscription_id = excluded.stripe_subscription_id, plan = excluded.plan, price_id = excluded.price_id,
          status = 'active', current_period_end = excluded.current_period_end, updated_at = now();
  return 'fulfilled';
end $$;

-- Mirrors what Stripe says of a subscription now. Grants nothing.
create function public.sync_subscription(
  p_event_id text, p_user_id uuid, p_subscription_id text, p_plan text, p_price_id text, p_status text,
  p_period_end timestamptz, p_cancel_at_period_end boolean
) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_other text;
begin
  perform 1 from public.users where id = p_user_id for update;
  if not found then raise exception 'not_found'; end if;
  if not public.claim_stripe_event(p_event_id, 'subscription', p_user_id) then return 'duplicate'; end if;
  select stripe_subscription_id into v_other from public.subscriptions
    where user_id = p_user_id and stripe_subscription_id <> p_subscription_id and status in ('active', 'trialing', 'past_due');
  if found then
    -- a second subscription beside a live one: the row keeps describing the first
    update public.stripe_events set outcome = 'other_subscription' where id = p_event_id;
    return 'other_subscription';
  end if;
  insert into public.subscriptions (user_id, stripe_subscription_id, plan, price_id, status, current_period_end, cancel_at_period_end)
    values (p_user_id, p_subscription_id, p_plan, p_price_id, p_status, p_period_end, coalesce(p_cancel_at_period_end, false))
    on conflict (user_id) do update
      set stripe_subscription_id = excluded.stripe_subscription_id, plan = excluded.plan, price_id = excluded.price_id,
          status = excluded.status, current_period_end = excluded.current_period_end,
          cancel_at_period_end = excluded.cancel_at_period_end, updated_at = now();
  return 'fulfilled';
end $$;

-- The subscription is over: what is left of its month's credit expires.
create function public.end_subscription(p_event_id text, p_user_id uuid, p_subscription_id text) returns text
language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.users where id = p_user_id for update;
  if not found then raise exception 'not_found'; end if;
  if not public.claim_stripe_event(p_event_id, 'subscription_ended', p_user_id) then return 'duplicate'; end if;
  if not exists (select 1 from public.subscriptions where user_id = p_user_id and stripe_subscription_id = p_subscription_id) then
    update public.stripe_events set outcome = 'other_subscription' where id = p_event_id;
    return 'other_subscription';
  end if;
  -- a second event for a subscription that has already ended ends nothing again
  if exists (select 1 from public.subscriptions where user_id = p_user_id and status = 'canceled') then
    update public.stripe_events set outcome = 'already_ended' where id = p_event_id;
    return 'already_ended';
  end if;
  perform public.expire_plan_credit(p_user_id, 'the subscription ended');
  update public.subscriptions set status = 'canceled', cancel_at_period_end = false, updated_at = now() where user_id = p_user_id;
  return 'fulfilled';
end $$;

-- A refund (or a dispute) takes back the share of the credit its payment granted. `p_refunded_usd` is the total
-- refunded of that payment so far, so the same refund reported twice takes nothing twice.
create function public.refund_payment(p_event_id text, p_charge_id text, p_refunded_usd numeric) returns text
language plpgsql security definer set search_path = '' as $$
declare
  p public.payments%rowtype;
  v_refunded numeric(12, 4);
  v_target numeric(12, 4);
  v_take numeric(12, 4);
  v_balance numeric(12, 4);
  v_period integer;
  v_plan numeric(12, 4);
  v_rest numeric(12, 4);
  r record;
begin
  if not public.valid_amount(p_refunded_usd) then raise exception 'invalid_amount'; end if;
  select * into p from public.payments where charge_id = p_charge_id;
  if not found then
    -- No payment with this charge — yet, perhaps: a payment whose fulfilment is still failing (a price that does
    -- not say what it grants) can be refunded before it is recorded. So the event is NOT recorded as done: the
    -- worker's catch-up offers it again, and it takes effect once the payment is there.
    if exists (select 1 from public.stripe_events where id = p_event_id) then return 'duplicate'; end if;
    return 'unknown_payment';
  end if;
  select plan_period, plan_credit_usd into v_period, v_plan from public.users where id = p.user_id for update;
  select * into p from public.payments where id = p.id for update;
  if not public.claim_stripe_event(p_event_id, 'refund', p.user_id) then return 'duplicate'; end if;
  v_refunded := least(greatest(round(p_refunded_usd, 4), p.refunded_usd), p.paid_usd);
  v_target := case when p.paid_usd > 0 then round(p.credit_usd * v_refunded / p.paid_usd, 4) else 0 end;
  v_take := greatest(v_target - p.taken_back_usd, 0);
  update public.payments set refunded_usd = v_refunded, taken_back_usd = taken_back_usd + v_take where id = p.id;
  if v_take > 0 then
    update public.users
      set balance_usd = balance_usd - v_take,
          -- credit of the current month that is taken back is no longer there to expire
          plan_credit_usd = case when p.kind = 'plan' and p.plan_period = v_period then greatest(plan_credit_usd - v_take, 0) else plan_credit_usd end
      where id = p.user_id returning balance_usd into v_balance;
    insert into public.ledger (user_id, kind, amount_usd, balance_after_usd, note) values (p.user_id, 'refund', -v_take, v_balance, p.id);
    -- The month's credit may be out with a job (held by a reservation, where the row above does not see it).
    -- What the refund took beyond the credit that was at hand comes off what those jobs hold as plan credit: it
    -- is taken back already, and must not be taken again as "expired" if the month ends before they settle.
    -- (This locks reservations after the user, the other way round from `settle`: should the two ever meet,
    -- Postgres ends one of them and it is tried again — the event by Stripe, the settling by the worker.)
    if p.kind = 'plan' and p.plan_period = v_period then
      v_rest := v_take - least(v_take, v_plan);
      for r in select id, plan_part_usd from public.reservations
        where user_id = p.user_id and status = 'open' and plan_period = v_period and plan_part_usd > 0 order by created_at for update
      loop
        exit when v_rest <= 0;
        update public.reservations set plan_part_usd = plan_part_usd - least(r.plan_part_usd, v_rest) where id = r.id;
        v_rest := v_rest - least(r.plan_part_usd, v_rest);
      end loop;
    end if;
  end if;
  return 'fulfilled';
end $$;

-- Default privileges already keep users away from everything above (first migration). Said outright all the
-- same for the functions, since two of them replace ones users may call:
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function
  public.create_run(text, text), public.reserve_credit(text, text, numeric), public.library_room(text),
  public.register_brand_kit(text, text), public.remove_brand_kit(text),
  public.register_track(text, text, bigint), public.remove_track(text)
  to authenticated;
grant execute on function
  public.settle(uuid, numeric), public.set_run_state(text, text, timestamptz), public.grant_credit(text, numeric, text),
  public.link_stripe_customer(uuid, text), public.claim_stripe_event(text, text, uuid, text),
  public.fulfil_topup(text, uuid, text, numeric, numeric, text, text),
  public.fulfil_plan_invoice(text, uuid, text, text, text, text, numeric, numeric, timestamptz, text, text),
  public.sync_subscription(text, uuid, text, text, text, text, timestamptz, boolean),
  public.end_subscription(text, uuid, text),
  public.refund_payment(text, text, numeric)
  to service_role;
