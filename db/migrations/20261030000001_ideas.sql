-- Topic ideas (phase 13 spec §5, plan ruling 1). A request for ideas is held and settled like any paid job, with the
-- machinery that is already proven (two kinds of credit, months that end, refunds in flight): it is a run row that no
-- list shows, a reservation of kind 'ideas' for its price, settled at the price when ideas came and at 0 when none did.

alter table public.reservations drop constraint reservations_kind_check;
alter table public.reservations add constraint reservations_kind_check check (kind in ('draft', 'generate', 'reroll', 'ideas'));

-- The caller's request for ideas: a run row in state 'ideas'. Not counted among unstarted videos (that count reads
-- 'creating'), so asking for ideas never shuts anyone out of making a video; the limits that apply are the credit and
-- the number of jobs a user may have open (both enforced by reserve_credit).
create function public.create_idea_request(p_id text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then raise exception 'unauthenticated'; end if;
  perform 1 from public.users where id = v_user for update;
  if not found then raise exception 'unauthenticated'; end if;
  begin
    insert into public.runs (id, user_id, topic, state) values (p_id, v_user, '', 'ideas');
  exception when unique_violation then
    raise exception 'run_exists';
  end;
end $$;

-- reserve_credit as the billing migration made it, with one kind more: nothing else in it changes.
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
  if p_kind is null or p_kind not in ('draft', 'generate', 'reroll', 'ideas') then raise exception 'invalid_kind'; end if;
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

-- (a new function starts with no access for anyone; `create or replace` kept reserve_credit's)
grant execute on function public.create_idea_request(text) to studio_web;
