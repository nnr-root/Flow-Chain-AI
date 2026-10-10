-- A plan paid for by the year (phase 6 spec §14). One invoice pays for twelve months, and the credit comes a
-- month at a time, as it does for a plan paid by the month: the invoice grants the first month's, and the worker
-- grants each of the others when its day comes. What is left of a month expires when the next one is granted.
--
-- This is the one place where credit is granted without a Stripe event of its own. What keeps it from being a
-- second way of making credit: a month can only be granted against a row that a paid invoice wrote, for a
-- subscription that is still live, when its day has come, and no more often than the months that were paid for
-- and not refunded. The count is kept in the row and moved under the user's lock, so asking twice grants once.

create table public.plan_years (
  -- one subscription per user, so one year at a time
  user_id uuid primary key references public.users (id) on delete cascade,
  subscription_id text not null,
  -- the invoice that paid for the year: its refunds decide how many months are still owed
  invoice_id text not null references public.payments (id) on delete restrict,
  plan text not null,
  -- one month's credit
  credit_usd numeric(12, 4) not null check (credit_usd > 0 and credit_usd <> 'NaN'),
  months integer not null check (months between 2 and 12),
  -- how many of them are still to come (the invoice itself granted the first)
  months_left integer not null check (months_left >= 0),
  period_end timestamptz not null,
  updated_at timestamptz not null default now(),
  check (months_left < months)
);
alter table public.plan_years enable row level security;
-- a user may see when their next month comes; nothing else of it is anyone's but the worker's to read
create policy "own row" on public.plan_years for select to studio_web using (user_id = (select auth.uid()));
revoke all on public.plan_years from public, studio_web, studio_worker;
grant select on public.plan_years to studio_web, studio_worker;

-- A paid invoice for a plan, by the month (`p_months` 1) or for several months at once. It is `fulfil_plan_invoice`
-- with the rest of the months written down in the same transaction: there is no moment at which a year was paid
-- for and its months are not owed. `p_credit_usd` is one month's credit either way.
create function public.fulfil_plan_period(
  p_event_id text, p_user_id uuid, p_invoice_id text, p_subscription_id text, p_plan text, p_price_id text,
  p_paid_usd numeric, p_credit_usd numeric, p_period_end timestamptz, p_months integer,
  p_charge_id text default null, p_invoice_url text default null
) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_outcome text;
begin
  if p_months is null or p_months < 1 or p_months > 12 then raise exception 'invalid_months'; end if;
  if p_months > 1 and p_period_end is null then raise exception 'invalid_period'; end if;
  -- (the user's row first, as everywhere: the order in which rows are locked is the same in every function)
  perform 1 from public.users where id = p_user_id for update;
  if not found then raise exception 'not_found'; end if;
  v_outcome := public.fulfil_plan_invoice(p_event_id, p_user_id, p_invoice_id, p_subscription_id, p_plan, p_price_id,
    p_paid_usd, p_credit_usd, p_period_end, p_charge_id, p_invoice_url);
  -- Only a payment that became the user's plan owes months. A second subscription beside a live one grants what
  -- its invoice grants and no more (its outcome says so, for the owner to put right by hand).
  if v_outcome = 'fulfilled' then
    if p_months > 1 then
      insert into public.plan_years (user_id, subscription_id, invoice_id, plan, credit_usd, months, months_left, period_end)
        values (p_user_id, p_subscription_id, p_invoice_id, p_plan, round(p_credit_usd, 4), p_months, p_months - 1, p_period_end)
        on conflict (user_id) do update
          set subscription_id = excluded.subscription_id, invoice_id = excluded.invoice_id, plan = excluded.plan, credit_usd = excluded.credit_usd,
              months = excluded.months, months_left = excluded.months_left, period_end = excluded.period_end, updated_at = now();
    else
      -- a plan by the month after one by the year: the year's remaining months are not this plan's
      delete from public.plan_years where user_id = p_user_id;
    end if;
  end if;
  return v_outcome;
end $$;

-- The next month of a year that was paid for, when its day has come: last month's unused credit expires and this
-- month's is granted, exactly as at a monthly renewal. Safe to ask at any time and any number of times; says why
-- when it grants nothing. A worker that was away for several months is owed them one call at a time, and each
-- but the last expires with the next, as it would have.
create function public.grant_plan_month(p_user_id uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare
  y public.plan_years%rowtype;
  p public.payments%rowtype;
  v_balance numeric(12, 4);
  v_period integer;
begin
  perform 1 from public.users where id = p_user_id for update;
  if not found then raise exception 'not_found'; end if;
  select * into y from public.plan_years where user_id = p_user_id for update;
  if not found then return 'none'; end if;
  if y.months_left = 0 then return 'done'; end if;
  -- the months are counted back from the end of what was paid for: the second begins a month after the first
  if now() < y.period_end - make_interval(months => y.months_left) then return 'not_due'; end if;
  -- (a plan set to end with its year is still live until then: the year was paid for)
  if not exists (select 1 from public.subscriptions
      where user_id = p_user_id and stripe_subscription_id = y.subscription_id and status in ('active', 'trialing', 'past_due')) then
    return 'not_live';
  end if;
  select * into p from public.payments where id = y.invoice_id for update;
  -- A refund takes months off the end: of twelve months half refunded, six are owed. Months already granted stay
  -- as they are (what a refund takes back of them is `refund_payment`'s to do).
  if p.paid_usd > 0 and (y.months - y.months_left) >= floor(y.months * (1 - p.refunded_usd / p.paid_usd)) then return 'refunded'; end if;
  perform public.expire_plan_credit(p_user_id, 'the month ended');
  -- (a balance below zero is a debt that the new month pays first, as in `fulfil_plan_invoice`)
  update public.users
    set balance_usd = balance_usd + y.credit_usd,
        plan_credit_usd = greatest(least(plan_credit_usd + y.credit_usd, balance_usd + y.credit_usd), 0)
    where id = p_user_id returning balance_usd, plan_period into v_balance, v_period;
  -- The payment's credit is now this month's: a refund from here on takes from this month, as it would from the
  -- month of a payment by the month, and what is out with jobs is noted against it.
  update public.payments set plan_period = v_period where id = y.invoice_id;
  insert into public.ledger (user_id, kind, amount_usd, balance_after_usd, note) values (p_user_id, 'plan', y.credit_usd, v_balance, y.plan);
  update public.plan_years set months_left = months_left - 1, updated_at = now() where user_id = p_user_id;
  return 'granted';
end $$;

revoke execute on function
  public.fulfil_plan_period(text, uuid, text, text, text, text, numeric, numeric, timestamptz, integer, text, text),
  public.grant_plan_month(uuid)
  from public, studio_web;
grant execute on function
  public.fulfil_plan_period(text, uuid, text, text, text, text, numeric, numeric, timestamptz, integer, text, text),
  public.grant_plan_month(uuid)
  to studio_worker;
