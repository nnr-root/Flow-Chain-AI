-- Series (phase 6 spec §3, §8): a recipe for videos of one kind, kept so that the next one is a click.
-- Nothing here moves money: a series' video is registered and paid for exactly as any other run is.

create table public.series (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  -- what its videos are about, in a sentence: every episode's topic is built from it
  premise text not null check (char_length(btrim(premise)) between 1 and 300),
  -- the new-video form's choices, as the web app's own schema validated them; the database only bounds its size
  recipe jsonb not null check (jsonb_typeof(recipe) = 'object' and pg_column_size(recipe) <= 8192),
  created_at timestamptz not null default now()
);
create index series_by_user on public.series (user_id, created_at desc);

-- a run made from a series says so; a series that is removed leaves its videos, no longer in a series
alter table public.runs add column series_id uuid references public.series (id) on delete set null;
create index runs_by_series on public.runs (series_id, created_at) where series_id is not null;

alter table public.series enable row level security;
create policy "own rows" on public.series for select to studio_web using (user_id = (select auth.uid()));
grant select on public.series to studio_web;

create function public.create_series(p_name text, p_premise text, p_recipe jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_id uuid;
begin
  if v_user is null then raise exception 'unauthenticated'; end if;
  -- the caller's row is locked, so the count below cannot be raced past
  perform 1 from public.users where id = v_user for update;
  if not found then raise exception 'unauthenticated'; end if;
  -- anyone signed in can call this directly: rows are not free to make without end
  if (select count(*) from public.series where user_id = v_user) >= 20 then raise exception 'too_many_series'; end if;
  begin
    insert into public.series (user_id, name, premise, recipe)
      values (v_user, btrim(coalesce(p_name, '')), btrim(coalesce(p_premise, '')), p_recipe)
      returning id into v_id;
  exception when check_violation or not_null_violation then
    raise exception 'invalid_series';
  end;
  return v_id;
end $$;

create function public.remove_series(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.series where id = p_id and user_id = auth.uid();
  -- someone else's series does not exist
  if not found then raise exception 'not_found'; end if;
end $$;

-- Registers a run as create_run does (with its limits), and ties it to one of the caller's own series.
create function public.create_series_run(p_series_id uuid, p_id text, p_topic text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.series where id = p_series_id and user_id = auth.uid()) then raise exception 'not_found'; end if;
  perform public.create_run(p_id, p_topic);
  update public.runs set series_id = p_series_id where id = p_id and user_id = auth.uid();
end $$;

revoke execute on function public.create_series(text, text, jsonb), public.remove_series(uuid), public.create_series_run(uuid, text, text) from public;
grant execute on function public.create_series(text, text, jsonb), public.remove_series(uuid), public.create_series_run(uuid, text, text) to studio_web;
