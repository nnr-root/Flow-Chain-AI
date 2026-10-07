-- Flow Chain studio: who owns what, and how much credit each user has (3.3 spec §4).
--
-- One rule for everything below: a signed-in user can call this database directly with their own token, so it
-- must be safe on its own. Users can only READ their own rows. Every write goes through a function that checks
-- who is calling; the functions that settle or grant money can only be run with the service role (the worker).

create table public.users (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  -- what the user may still spend; a reservation takes its cap out, settling puts the unused part back
  balance_usd numeric(12, 4) not null default 0,
  created_at timestamptz not null default now()
);

create table public.runs (
  -- the pipeline's run id; the run's manifest on disk stays the truth about the run itself
  id text primary key check (id ~ '^[0-9]{8}-[0-9]{6}-[0-9a-f]{6}$'),
  user_id uuid not null references public.users (id) on delete cascade,
  topic text not null default '',
  -- a cache for the list page, written by the worker
  state text not null default 'creating',
  -- how much of the run's spend has been taken from the balance so far
  charged_usd numeric(12, 4) not null default 0,
  stored_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index runs_by_user on public.runs (user_id, created_at desc);

create table public.reservations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  run_id text not null references public.runs (id) on delete cascade,
  kind text not null check (kind in ('draft', 'generate', 'reroll')),
  cap_usd numeric(12, 4) not null check (cap_usd >= 0),
  status text not null default 'open' check (status in ('open', 'settled')),
  charged_usd numeric(12, 4),
  created_at timestamptz not null default now(),
  settled_at timestamptz
);
-- the database itself refuses a second paid job on a run
create unique index reservations_one_open_per_run on public.reservations (run_id) where status = 'open';
create index reservations_open_by_user on public.reservations (user_id) where status = 'open';

create table public.ledger (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.users (id) on delete cascade,
  run_id text,
  reservation_id uuid,
  kind text not null check (kind in ('grant', 'reserve', 'settle')),
  -- the change to the balance: negative when credit is held, positive when it is granted or returned
  amount_usd numeric(12, 4) not null,
  balance_after_usd numeric(12, 4) not null,
  note text not null default '',
  created_at timestamptz not null default now()
);
create index ledger_by_user on public.ledger (user_id, id desc);

create table public.brand_kits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  slug text not null check (slug ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  name text not null,
  created_at timestamptz not null default now(),
  unique (user_id, slug)
);

create table public.music_tracks (
  id text not null check (id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  user_id uuid not null references public.users (id) on delete cascade,
  name text not null,
  bytes bigint not null check (bytes >= 0),
  created_at timestamptz not null default now(),
  primary key (user_id, id)
);

-- one row of settings that only the owner of the database changes
create table public.settings (
  only_row boolean primary key default true check (only_row),
  -- how many paid jobs one user may have waiting or running
  max_user_jobs integer not null default 2 check (max_user_jobs >= 1)
);
insert into public.settings default values;

-- ---------------------------------------------------------------------------------------------------------
-- Row-level security: read your own rows; no direct writes at all.

alter table public.users enable row level security;
alter table public.runs enable row level security;
alter table public.reservations enable row level security;
alter table public.ledger enable row level security;
alter table public.brand_kits enable row level security;
alter table public.music_tracks enable row level security;
alter table public.settings enable row level security;

create policy "own row" on public.users for select to authenticated using (id = (select auth.uid()));
create policy "own rows" on public.runs for select to authenticated using (user_id = (select auth.uid()));
create policy "own rows" on public.reservations for select to authenticated using (user_id = (select auth.uid()));
create policy "own rows" on public.ledger for select to authenticated using (user_id = (select auth.uid()));
create policy "own rows" on public.brand_kits for select to authenticated using (user_id = (select auth.uid()));
create policy "own rows" on public.music_tracks for select to authenticated using (user_id = (select auth.uid()));
-- settings: no policy, so nobody but the service role reads it

-- belt and braces: even a policy added by mistake later could not let a user write
revoke insert, update, delete, truncate on all tables in schema public from anon, authenticated;
revoke all on all tables in schema public from anon;

-- ---------------------------------------------------------------------------------------------------------
-- A new account gets its row, with nothing to spend.

create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.users (id, email) values (new.id, coalesce(new.email, ''));
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------------------------------------
-- What a user may do (always as themselves: auth.uid()).

create function public.create_run(p_id text, p_topic text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then raise exception 'unauthenticated'; end if;
  insert into public.runs (id, user_id, topic) values (p_id, v_user, left(coalesce(p_topic, ''), 500));
exception when unique_violation then
  raise exception 'run_exists';
end $$;

-- Holds the approved cap of one paid job. The lock on the caller's row makes concurrent calls take turns, so
-- two tabs cannot both spend the same credit.
create function public.reserve_credit(p_run_id text, p_kind text, p_cap_usd numeric) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_cap numeric(12, 4) := round(p_cap_usd, 4);
  v_balance numeric(12, 4);
  v_id uuid;
begin
  if v_user is null then raise exception 'unauthenticated'; end if;
  if v_cap is null or v_cap < 0 or v_cap > 1000 then raise exception 'invalid_amount'; end if;
  if p_kind is null or p_kind not in ('draft', 'generate', 'reroll') then raise exception 'invalid_kind'; end if;
  select balance_usd into v_balance from public.users where id = v_user for update;
  if not found then raise exception 'unauthenticated'; end if;
  if not exists (select 1 from public.runs where id = p_run_id and user_id = v_user) then raise exception 'not_found'; end if;
  if exists (select 1 from public.reservations where run_id = p_run_id and status = 'open') then raise exception 'job_active'; end if;
  if (select count(*) from public.reservations where user_id = v_user and status = 'open')
     >= (select max_user_jobs from public.settings) then
    raise exception 'too_many_jobs';
  end if;
  if v_balance < v_cap then raise exception 'insufficient_credit'; end if;

  update public.users set balance_usd = balance_usd - v_cap where id = v_user returning balance_usd into v_balance;
  insert into public.reservations (user_id, run_id, kind, cap_usd) values (v_user, p_run_id, p_kind, v_cap) returning id into v_id;
  insert into public.ledger (user_id, run_id, reservation_id, kind, amount_usd, balance_after_usd, note)
    values (v_user, p_run_id, v_id, 'reserve', -v_cap, v_balance, p_kind);
  return v_id;
end $$;

create function public.register_brand_kit(p_slug text, p_name text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_id uuid;
begin
  if v_user is null then raise exception 'unauthenticated'; end if;
  insert into public.brand_kits (user_id, slug, name) values (v_user, p_slug, left(coalesce(p_name, p_slug), 120))
    on conflict (user_id, slug) do update set name = excluded.name
    returning id into v_id;
  return v_id;
end $$;

create function public.remove_brand_kit(p_slug text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'unauthenticated'; end if;
  delete from public.brand_kits where user_id = auth.uid() and slug = p_slug;
end $$;

create function public.register_track(p_id text, p_name text, p_bytes bigint) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'unauthenticated'; end if;
  insert into public.music_tracks (id, user_id, name, bytes) values (p_id, auth.uid(), left(coalesce(p_name, p_id), 200), p_bytes)
    on conflict (user_id, id) do update set name = excluded.name, bytes = excluded.bytes;
end $$;

create function public.remove_track(p_id text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'unauthenticated'; end if;
  delete from public.music_tracks where user_id = auth.uid() and id = p_id;
end $$;

-- ---------------------------------------------------------------------------------------------------------
-- What only the worker (service role) may do.

-- Closes a reservation at what its job really cost. The charge is the run's total spend, as its manifest
-- records it, minus what was already charged for that run: nothing a user sends enters the sum, and calling
-- this twice charges nothing twice.
create function public.settle(p_reservation_id uuid, p_run_total_usd numeric) returns numeric
language plpgsql security definer set search_path = '' as $$
declare
  r public.reservations%rowtype;
  v_total numeric(12, 4) := round(greatest(coalesce(p_run_total_usd, 0), 0), 4);
  v_already numeric(12, 4);
  v_charge numeric(12, 4);
  v_balance numeric(12, 4);
begin
  select * into r from public.reservations where id = p_reservation_id for update;
  if not found then raise exception 'not_found'; end if;
  if r.status <> 'open' then return r.charged_usd; end if;
  select charged_usd into v_already from public.runs where id = r.run_id for update;
  v_charge := greatest(v_total - v_already, 0);
  update public.users set balance_usd = balance_usd + r.cap_usd - v_charge where id = r.user_id returning balance_usd into v_balance;
  update public.runs set charged_usd = greatest(charged_usd, v_total), updated_at = now() where id = r.run_id;
  update public.reservations set status = 'settled', charged_usd = v_charge, settled_at = now() where id = r.id;
  insert into public.ledger (user_id, run_id, reservation_id, kind, amount_usd, balance_after_usd, note)
    values (r.user_id, r.run_id, r.id, 'settle', r.cap_usd - v_charge, v_balance, 'charged ' || v_charge || ' of ' || r.cap_usd);
  return v_charge;
end $$;

create function public.set_run_state(p_run_id text, p_state text, p_stored_at timestamptz default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.runs
    set state = coalesce(p_state, state), stored_at = coalesce(p_stored_at, stored_at), updated_at = now()
    where id = p_run_id;
end $$;

create function public.grant_credit(p_email text, p_amount_usd numeric, p_note text default '') returns numeric
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid;
  v_amount numeric(12, 4) := round(p_amount_usd, 4);
  v_balance numeric(12, 4);
begin
  if v_amount is null or v_amount = 0 then raise exception 'invalid_amount'; end if;
  select id into v_user from public.users where lower(email) = lower(p_email) for update;
  if not found then raise exception 'not_found'; end if;
  update public.users set balance_usd = balance_usd + v_amount where id = v_user returning balance_usd into v_balance;
  insert into public.ledger (user_id, kind, amount_usd, balance_after_usd, note) values (v_user, 'grant', v_amount, v_balance, coalesce(p_note, ''));
  return v_balance;
end $$;

-- Functions are executable by everyone unless told otherwise: say exactly who may run what.
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function
  public.create_run(text, text), public.reserve_credit(text, text, numeric),
  public.register_brand_kit(text, text), public.remove_brand_kit(text),
  public.register_track(text, text, bigint), public.remove_track(text)
  to authenticated;
grant execute on function
  public.settle(uuid, numeric), public.set_run_state(text, text, timestamptz), public.grant_credit(text, numeric, text)
  to service_role;
