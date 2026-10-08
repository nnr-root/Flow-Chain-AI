-- Flow Chain studio: who owns what, and how much credit each user has (3.3 spec §4).
--
-- One rule for everything below: a signed-in user can call this database directly with their own token, so it
-- must be safe on its own. Users can only READ their own rows. Every write goes through a function that checks
-- who is calling; the functions that settle or grant money can only be run with the service role (the worker).

create table public.users (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  -- what the user may still spend; a reservation takes its cap out, settling puts the unused part back
  balance_usd numeric(12, 4) not null default 0 check (balance_usd <> 'NaN'),
  created_at timestamptz not null default now()
);
-- credit is granted by address: an address names one account
create unique index users_one_per_email on public.users (lower(email)) where email <> '';

create table public.runs (
  -- the pipeline's run id; the run's manifest on disk stays the truth about the run itself
  id text primary key check (id ~ '^[0-9]{8}-[0-9]{6}-[0-9a-f]{6}$'),
  user_id uuid not null references public.users (id) on delete cascade,
  topic text not null default '',
  -- a cache for the list page, written by the worker
  state text not null default 'creating',
  -- how much of the run's spend has been taken from the balance so far
  charged_usd numeric(12, 4) not null default 0 check (charged_usd >= 0 and charged_usd <> 'NaN'),
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
  cap_usd numeric(12, 4) not null check (cap_usd >= 0 and cap_usd <> 'NaN'),
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
  -- the record of what was paid for is not erased with an account: an account with a history cannot be deleted
  user_id uuid not null references public.users (id) on delete restrict,
  run_id text,
  reservation_id uuid,
  kind text not null check (kind in ('grant', 'reserve', 'settle')),
  -- the change to the balance: negative when credit is held, positive when it is granted or returned
  amount_usd numeric(12, 4) not null check (amount_usd <> 'NaN'),
  balance_after_usd numeric(12, 4) not null check (balance_after_usd <> 'NaN'),
  note text not null default '',
  created_at timestamptz not null default now()
);
create index ledger_by_user on public.ledger (user_id, id desc);
-- the day's welcome credit is added up on every sign-up and for every visitor of the landing page
create index ledger_welcome on public.ledger (created_at) where kind = 'grant' and note = 'welcome';

create table public.brand_kits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  slug text not null check (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
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
  max_user_jobs integer not null default 2 check (max_user_jobs >= 1),
  -- how much one user may register: runs a day that never got further than being created, brand kits, music tracks
  max_unstarted_runs integer not null default 20 check (max_unstarted_runs >= 1),
  max_brand_kits integer not null default 20 check (max_brand_kits >= 1),
  max_music_tracks integer not null default 50 check (max_music_tracks >= 1),
  -- Credit a new account starts with, once its address is confirmed: enough for a first script draft or two,
  -- too little for a clip. 0 = none (the default). And the most that may be given away like this in a day, to
  -- all new accounts together: a flood of sign-ups cannot cost more than this.
  welcome_credit_usd numeric(12, 4) not null default 0 check (welcome_credit_usd >= 0 and welcome_credit_usd <= 5 and welcome_credit_usd <> 'NaN'),
  welcome_daily_cap_usd numeric(12, 4) not null default 5 check (welcome_daily_cap_usd >= 0 and welcome_daily_cap_usd <> 'NaN')
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

-- Privileges, closed by default. Supabase grants everything in `public` to `anon` and `authenticated` as it is
-- created, and Postgres lets everyone execute a new function; row-level security alone would then be the only
-- wall. Here both walls stand: a user's role may select from the six tables and nothing else, and whatever a
-- LATER migration adds starts with no access at all until that migration grants it.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
grant select on public.users, public.runs, public.reservations, public.ledger, public.brand_kits, public.music_tracks to authenticated;
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke execute on functions from anon, authenticated;
alter default privileges for role postgres revoke execute on functions from public;

-- ---------------------------------------------------------------------------------------------------------
-- A new account gets its row, with nothing to spend — or, where the owner has set one, a small welcome credit
-- once its address is confirmed (an address nobody confirmed is nobody's, and gets nothing).

-- The welcome credit itself: `p_amount` to this account, once, unless that would take what was given away in
-- the last day past `p_cap`. Returns what was granted (0 when nothing was). Its two amounts are parameters so
-- that it can be tested without changing a setting every other account shares.
create function public.grant_welcome_credit(p_user_id uuid, p_amount numeric, p_cap numeric) returns numeric
language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare
  v_amount numeric(12, 4) := round(p_amount, 4);
  v_given numeric(12, 4);
  v_balance numeric(12, 4);
begin
  if v_amount is null or v_amount = 'NaN' or v_amount <= 0 or v_amount > 5 or p_cap is null or p_cap = 'NaN' then return 0; end if;
  -- One grant at a time (the settings row is the lock): the day's total cannot be raced past. A sign-up never
  -- waits long for it (this function's own lock_timeout): if the row is held, this fails, and the account is
  -- made without a welcome.
  perform 1 from public.settings for update;
  perform 1 from public.users where id = p_user_id for update;
  if not found then return 0; end if;
  if exists (select 1 from public.ledger where user_id = p_user_id and kind = 'grant' and note = 'welcome') then return 0; end if;
  select coalesce(sum(amount_usd), 0) into v_given from public.ledger
    where kind = 'grant' and note = 'welcome' and created_at > now() - interval '1 day';
  if v_given + v_amount > p_cap then return 0; end if;
  update public.users set balance_usd = balance_usd + v_amount where id = p_user_id returning balance_usd into v_balance;
  insert into public.ledger (user_id, kind, amount_usd, balance_after_usd, note) values (p_user_id, 'grant', v_amount, v_balance, 'welcome');
  return v_amount;
end $$;

-- What a new account would be given right now: 0 when welcome credit is off or the day's cap is reached. The
-- landing page asks this, to promise a free draft only when there is one. It tells nobody anything else.
create function public.welcome_offer() returns numeric
language sql stable security definer set search_path = '' as $$
  select case
    when s.welcome_credit_usd > 0 and (
      select coalesce(sum(l.amount_usd), 0) from public.ledger l
      where l.kind = 'grant' and l.note = 'welcome' and l.created_at > now() - interval '1 day'
    ) + s.welcome_credit_usd <= s.welcome_daily_cap_usd then s.welcome_credit_usd
    else 0::numeric end
  from public.settings s;
$$;

create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.users (id, email) values (new.id, coalesce(new.email, ''));
  if new.email_confirmed_at is not null then
    -- a welcome that cannot be given must never stand in the way of the account itself
    begin
      perform public.grant_welcome_credit(new.id, s.welcome_credit_usd, s.welcome_daily_cap_usd) from public.settings s;
    exception when others then
      raise warning 'welcome credit could not be given to %: %', new.id, sqlerrm;
    end;
  end if;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- the address is confirmed later, by the emailed link: the welcome comes then
create function public.handle_user_confirmed() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  begin
    perform public.grant_welcome_credit(new.id, s.welcome_credit_usd, s.welcome_daily_cap_usd) from public.settings s;
  exception when others then
    raise warning 'welcome credit could not be given to %: %', new.id, sqlerrm;
  end;
  return new;
end $$;
create trigger on_auth_user_confirmed after update of email_confirmed_at on auth.users
  for each row when (old.email_confirmed_at is null and new.email_confirmed_at is not null) execute function public.handle_user_confirmed();

-- credit is granted by address, so the address here follows the one the account signs in with
create function public.handle_user_email() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.users set email = coalesce(new.email, '') where id = new.id;
  return new;
end $$;
create trigger on_auth_user_email after update of email on auth.users
  for each row when (old.email is distinct from new.email) execute function public.handle_user_email();

-- accounts that existed before this migration
insert into public.users (id, email) select id, coalesce(email, '') from auth.users on conflict (id) do nothing;

-- ---------------------------------------------------------------------------------------------------------
-- What a user may do (always as themselves: auth.uid()).

create function public.create_run(p_id text, p_topic text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then raise exception 'unauthenticated'; end if;
  -- the caller's row is locked, so the count below cannot be raced past
  perform 1 from public.users where id = v_user for update;
  if not found then raise exception 'unauthenticated'; end if;
  -- Anyone signed in can call this directly, with or without credit: registering runs is not free to do without
  -- end. Only today's count: a run that never started must not shut its owner out for good.
  if (select count(*) from public.runs
      where user_id = v_user and state = 'creating' and charged_usd = 0 and created_at > now() - interval '1 day')
     >= (select max_unstarted_runs from public.settings) then
    raise exception 'too_many_runs';
  end if;
  begin
    insert into public.runs (id, user_id, topic) values (p_id, v_user, left(coalesce(p_topic, ''), 500));
  exception when unique_violation then
    raise exception 'run_exists';
  end;
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
  -- NaN compares greater than every number, so the upper bound refuses it too; said outright all the same
  if v_cap is null or v_cap = 'NaN' or v_cap < 0 or v_cap > 1000 then raise exception 'invalid_amount'; end if;
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
  perform 1 from public.users where id = v_user for update;
  if not exists (select 1 from public.brand_kits where user_id = v_user and slug = p_slug)
     and (select count(*) from public.brand_kits where user_id = v_user) >= (select max_brand_kits from public.settings) then
    raise exception 'too_many_brand_kits';
  end if;
  insert into public.brand_kits (user_id, slug, name) values (v_user, p_slug, left(coalesce(p_name, p_slug), 120))
    on conflict (user_id, slug) do update set name = excluded.name
    returning id into v_id;
  return v_id;
end $$;

-- Whether the caller may register one more kit or track. The registering functions enforce the limit; this lets
-- the studio ask before it accepts an upload.
create function public.library_room(p_what text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then raise exception 'unauthenticated'; end if;
  if p_what = 'brand_kits' then
    return (select count(*) from public.brand_kits where user_id = v_user) < (select max_brand_kits from public.settings);
  elsif p_what = 'music_tracks' then
    return (select count(*) from public.music_tracks where user_id = v_user) < (select max_music_tracks from public.settings);
  end if;
  raise exception 'invalid_kind';
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
  perform 1 from public.users where id = auth.uid() for update;
  if not exists (select 1 from public.music_tracks where user_id = auth.uid() and id = p_id)
     and (select count(*) from public.music_tracks where user_id = auth.uid()) >= (select max_music_tracks from public.settings) then
    raise exception 'too_many_tracks';
  end if;
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
  v_total numeric(12, 4);
  v_already numeric(12, 4);
  v_charge numeric(12, 4);
  v_balance numeric(12, 4);
begin
  -- A total that is missing or impossible is refused, never read as "nothing was spent": the reservation
  -- stays open and is settled when the worker knows the real figure.
  if p_run_total_usd is null or p_run_total_usd = 'NaN' or p_run_total_usd < 0 or p_run_total_usd > 100000 then
    raise exception 'invalid_amount';
  end if;
  v_total := round(p_run_total_usd, 4);
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
  if v_amount is null or v_amount = 'NaN' or v_amount = 0 or abs(v_amount) > 100000 then raise exception 'invalid_amount'; end if;
  if p_email is null or btrim(p_email) = '' then raise exception 'not_found'; end if;
  select id into v_user from public.users where lower(email) = lower(btrim(p_email)) for update;
  if not found then raise exception 'not_found'; end if;
  update public.users set balance_usd = balance_usd + v_amount where id = v_user returning balance_usd into v_balance;
  insert into public.ledger (user_id, kind, amount_usd, balance_after_usd, note) values (v_user, 'grant', v_amount, v_balance, coalesce(p_note, ''));
  return v_balance;
end $$;

-- Functions are executable by everyone unless told otherwise: say exactly who may run what. (The default
-- privileges above were changed before these functions were created, but only for what comes later in the
-- same role's name; this makes it certain for the ones here.)
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function
  public.create_run(text, text), public.reserve_credit(text, text, numeric),
  public.register_brand_kit(text, text), public.remove_brand_kit(text), public.library_room(text),
  public.register_track(text, text, bigint), public.remove_track(text)
  to authenticated;
grant execute on function
  public.settle(uuid, numeric), public.set_run_state(text, text, timestamptz), public.grant_credit(text, numeric, text),
  public.grant_welcome_credit(uuid, numeric, numeric)
  to service_role;
-- anyone, signed in or not: it says only whether a new account would be given something
grant execute on function public.welcome_offer() to anon, authenticated;
