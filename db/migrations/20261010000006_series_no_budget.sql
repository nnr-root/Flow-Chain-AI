-- A series with a schedule no longer has a limit for one video or a budget for the month (phase 6 spec §15, the
-- owner's direction). Its owner's approval is the schedule itself; what it can spend is the credit they have,
-- and it stops, and says why, when that does not cover its next video.
--
-- What does not change: only the worker can begin a series' video or hold credit for one; the series must be
-- its owner's, active and on a schedule; the credit is held by reserve_credit in the owner's name, which is
-- what refuses when there is not enough.

-- Series that had been stopped by a limit keep standing still until their owner lets them go on: taking the
-- limit away is not a reason to begin spending again without them. They are shown as stopped by their owner.
update public.series set paused_reason = 'user' where paused_reason in ('budget', 'cap');

alter table public.series
  drop constraint scheduled_series_has_a_budget,
  drop constraint series_paused_reason_check,
  add constraint series_paused_reason_check check (paused_reason in ('user', 'credit', 'failed'));

-- The schedule, without amounts. Setting one makes the series active and due.
drop function public.set_series_schedule(uuid, text, numeric, numeric);
create function public.set_series_schedule(p_id uuid, p_cadence text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_cadence is null or p_cadence not in ('manual', 'weekly3', 'daily', 'daily2') then raise exception 'invalid_schedule'; end if;
  update public.series set
      cadence = p_cadence, status = 'active', paused_reason = null,
      next_due_at = case when p_cadence = 'manual' then null else now() end
    where id = p_id and user_id = auth.uid();
  -- someone else's series does not exist
  if not found then raise exception 'not_found'; end if;
end $$;

-- Holds credit for a series' own job. Called by start_series_episode and reserve_for_series, which have locked
-- the series' row. The amount is held by reserve_credit itself, asked in the series' owner's name for this one
-- call: an owner without the credit is refused there ('insufficient_credit'), as for a job they clicked for.
create or replace function public.hold_for_series(p_series public.series, p_run_id text, p_kind text, p_cap_usd numeric) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_cap numeric(12, 4) := round(p_cap_usd, 4);
  v_asking text := current_setting('app.user_id', true);
  v_id uuid;
begin
  if v_cap is null or v_cap = 'NaN' or v_cap < 0 then raise exception 'invalid_amount'; end if;
  if p_series.status <> 'active' or p_series.cadence = 'manual' then raise exception 'not_active'; end if;
  perform set_config('app.user_id', p_series.user_id::text, true);
  begin
    v_id := public.reserve_credit(p_run_id, p_kind, v_cap);
  exception when others then
    perform set_config('app.user_id', coalesce(v_asking, ''), true);
    raise;
  end;
  perform set_config('app.user_id', coalesce(v_asking, ''), true);
  return v_id;
end $$;

-- (the reasons a worker may stop a series with are now two)
create or replace function public.finish_series_episode(p_series_id uuid, p_run_id text, p_pause text default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_pause is not null and p_pause not in ('credit', 'failed') then raise exception 'invalid_reason'; end if;
  update public.series set
      current_run = case when current_run is not distinct from p_run_id then null else current_run end,
      current_step = case when current_run is not distinct from p_run_id then null else current_step end,
      status = case when p_pause is null then status else 'paused' end,
      paused_reason = case when p_pause is null then paused_reason else p_pause end
    where id = p_series_id;
  if not found then raise exception 'not_found'; end if;
end $$;

-- nothing asks what a series has used in a month any more to decide anything (its page adds it up from the
-- user's own rows, to show)
drop function public.series_month_usd(uuid);

alter table public.series drop column per_video_cap_usd, drop column monthly_budget_usd;

revoke execute on function public.set_series_schedule(uuid, text) from public;
grant execute on function public.set_series_schedule(uuid, text) to studio_web;
