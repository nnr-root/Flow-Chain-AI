-- A series that makes its videos by itself (phase 6 spec §4–5): the schedule, the budget the user approved once,
-- and the functions with which the worker, and only the worker, spends inside that budget.
--
-- Nothing here does arithmetic on a balance. Credit is held by reserve_credit and given back by settle, exactly
-- as for a job a user clicked for: what is new is who may ask (the worker, for a series) and what is checked
-- first (the series is the user's own standing approval, and the amount is inside it).

alter table public.series
  -- how often it is due: only when asked, three times a week, daily, twice a day
  add column cadence text not null default 'manual' check (cadence in ('manual', 'weekly3', 'daily', 'daily2')),
  -- the standing approval: the most one video may hold, and the most the videos of one calendar month may
  add column per_video_cap_usd numeric(12, 4) check (per_video_cap_usd > 0 and per_video_cap_usd <= 100),
  add column monthly_budget_usd numeric(12, 4) check (monthly_budget_usd > 0 and monthly_budget_usd <= 10000),
  add column status text not null default 'active' check (status in ('active', 'paused')),
  -- why it stands still, when it was not the user who stopped it: 'credit', 'budget', 'cap', 'failed'
  add column paused_reason text check (paused_reason in ('user', 'credit', 'budget', 'cap', 'failed')),
  add column next_due_at timestamptz,
  -- the video it is making now, and how far that has got ('draft': the script; 'generate': the rest)
  add column current_run text references public.runs (id) on delete set null,
  add column current_step text check (current_step in ('draft', 'generate')),
  -- a schedule has its approval; a step belongs to a run
  add constraint scheduled_series_has_a_budget check (cadence = 'manual' or (per_video_cap_usd is not null and monthly_budget_usd is not null)),
  add constraint a_step_has_a_run check (current_run is not null or current_step is null);

-- the worker reads which series are due and what each is making; it writes only through the functions below
grant select on public.series to studio_worker;

create function public.series_interval(p_cadence text) returns interval
language sql immutable set search_path = '' as $$
  select case p_cadence when 'weekly3' then interval '56 hours' when 'daily' then interval '24 hours' when 'daily2' then interval '12 hours' end
$$;

-- What a series has spent in the current calendar month, with what it is holding right now.
create function public.series_month_usd(p_series_id uuid) returns numeric
language sql stable security definer set search_path = '' as $$
  select coalesce((select sum(r.charged_usd) from public.runs r
                   where r.series_id = p_series_id and r.created_at >= date_trunc('month', now())), 0)
       + coalesce((select sum(v.cap_usd) from public.reservations v join public.runs r on r.id = v.run_id
                   where r.series_id = p_series_id and v.status = 'open'), 0)
$$;

-- The user sets, or takes away, a series' schedule and its budget. Setting one makes the series active and due.
create function public.set_series_schedule(p_id uuid, p_cadence text, p_per_video_cap_usd numeric, p_monthly_budget_usd numeric) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_cadence is null or p_cadence not in ('manual', 'weekly3', 'daily', 'daily2') then raise exception 'invalid_schedule'; end if;
  if p_cadence <> 'manual' and (p_per_video_cap_usd is null or p_per_video_cap_usd = 'NaN' or p_per_video_cap_usd <= 0 or p_per_video_cap_usd > 100
       or p_monthly_budget_usd is null or p_monthly_budget_usd = 'NaN' or p_monthly_budget_usd <= 0 or p_monthly_budget_usd > 10000
       or p_monthly_budget_usd < p_per_video_cap_usd) then
    raise exception 'invalid_schedule';
  end if;
  update public.series set
      cadence = p_cadence,
      per_video_cap_usd = case when p_cadence = 'manual' then null else round(p_per_video_cap_usd, 4) end,
      monthly_budget_usd = case when p_cadence = 'manual' then null else round(p_monthly_budget_usd, 4) end,
      status = 'active', paused_reason = null,
      next_due_at = case when p_cadence = 'manual' then null else now() end
    where id = p_id and user_id = auth.uid();
  -- someone else's series does not exist
  if not found then raise exception 'not_found'; end if;
end $$;

-- The user stops a series, or lets it go on. Going on makes it due at once: whatever stopped it has been seen to.
create function public.set_series_status(p_id uuid, p_active boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.series set
      status = case when p_active then 'active' else 'paused' end,
      paused_reason = case when p_active then null else 'user' end,
      next_due_at = case when p_active and cadence <> 'manual' then now() else next_due_at end
    where id = p_id and user_id = auth.uid();
  if not found then raise exception 'not_found'; end if;
end $$;

-- ---------------------------------------------------------------------------------------------------------
-- For the worker only.

-- Holds credit for a series' own job, inside the series' standing approval. Called by the two functions below,
-- which have locked the series' row: two of them at once cannot both fit under one budget. The amount is held
-- by reserve_credit itself, asked in the series' owner's name for this one call.
create function public.hold_for_series(p_series public.series, p_run_id text, p_kind text, p_cap_usd numeric) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_cap numeric(12, 4) := round(p_cap_usd, 4);
  v_asking text := current_setting('app.user_id', true);
  v_id uuid;
begin
  if v_cap is null or v_cap = 'NaN' or v_cap < 0 then raise exception 'invalid_amount'; end if;
  if p_series.status <> 'active' or p_series.cadence = 'manual' then raise exception 'not_active'; end if;
  if v_cap > p_series.per_video_cap_usd then raise exception 'over_cap'; end if;
  if public.series_month_usd(p_series.id) + v_cap > p_series.monthly_budget_usd then raise exception 'over_budget'; end if;
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

-- Begins a series' next video: registers the run as its owner's, ties it to the series, holds the script's cost.
-- Refused when the series is not due, is making one already, or the approval or the credit does not cover it.
create function public.start_series_episode(p_series_id uuid, p_run_id text, p_topic text, p_draft_cap_usd numeric) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  s public.series%rowtype;
  v_asking text := current_setting('app.user_id', true);
  v_id uuid;
begin
  select * into s from public.series where id = p_series_id for update;
  if not found then raise exception 'not_found'; end if;
  if s.status <> 'active' or s.cadence = 'manual' then raise exception 'not_active'; end if;
  if s.current_run is not null then raise exception 'busy'; end if;
  if s.next_due_at is null or s.next_due_at > now() then raise exception 'not_due'; end if;
  perform set_config('app.user_id', s.user_id::text, true);
  begin
    perform public.create_run(p_run_id, p_topic);
  exception when others then
    perform set_config('app.user_id', coalesce(v_asking, ''), true);
    raise;
  end;
  perform set_config('app.user_id', coalesce(v_asking, ''), true);
  update public.runs set series_id = s.id where id = p_run_id;
  v_id := public.hold_for_series(s, p_run_id, 'draft', p_draft_cap_usd);
  -- the next one is due one interval from now, not from when this one was: a series that stood still for a
  -- week does not make a week's videos at once
  update public.series set current_run = p_run_id, current_step = 'draft', next_due_at = now() + public.series_interval(s.cadence) where id = s.id;
  return v_id;
end $$;

-- Holds credit for the rest of the video a series is making (its script is written and has been priced).
create function public.reserve_for_series(p_series_id uuid, p_run_id text, p_cap_usd numeric) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  s public.series%rowtype;
  v_id uuid;
begin
  select * into s from public.series where id = p_series_id for update;
  if not found then raise exception 'not_found'; end if;
  -- only for the video the series is making, and only once its script is there
  if s.current_run is distinct from p_run_id or s.current_step <> 'draft' then raise exception 'not_current'; end if;
  v_id := public.hold_for_series(s, p_run_id, 'generate', p_cap_usd);
  update public.series set current_step = 'generate' where id = s.id;
  return v_id;
end $$;

-- The video a series was making is finished with (made, failed, or left to the user). `p_pause`: the series
-- stops as well, for this reason, until its owner lets it go on.
create function public.finish_series_episode(p_series_id uuid, p_run_id text, p_pause text default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_pause is not null and p_pause not in ('credit', 'budget', 'cap', 'failed') then raise exception 'invalid_reason'; end if;
  update public.series set
      current_run = case when current_run is not distinct from p_run_id then null else current_run end,
      current_step = case when current_run is not distinct from p_run_id then null else current_step end,
      status = case when p_pause is null then status else 'paused' end,
      paused_reason = case when p_pause is null then paused_reason else p_pause end
    where id = p_series_id;
  if not found then raise exception 'not_found'; end if;
end $$;

revoke execute on function
  public.series_interval(text), public.series_month_usd(uuid), public.set_series_schedule(uuid, text, numeric, numeric),
  public.set_series_status(uuid, boolean), public.hold_for_series(public.series, text, text, numeric),
  public.start_series_episode(uuid, text, text, numeric), public.reserve_for_series(uuid, text, numeric),
  public.finish_series_episode(uuid, text, text)
  from public;
grant execute on function public.set_series_schedule(uuid, text, numeric, numeric), public.set_series_status(uuid, boolean), public.series_month_usd(uuid) to studio_web;
grant execute on function
  public.start_series_episode(uuid, text, text, numeric), public.reserve_for_series(uuid, text, numeric),
  public.finish_series_episode(uuid, text, text), public.series_month_usd(uuid)
  to studio_worker;
