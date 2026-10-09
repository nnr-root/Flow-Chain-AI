-- Flow Chain studio: its own accounts and sessions, in its own database (phase 5 spec §4).
--
-- Who may do what, in one place:
--   * the owner of the database (whoever runs these files) owns every table and function, and no running
--     service connects as it;
--   * `studio_web` is what the web app connects as. It can read a user's own rows through row-level security,
--     run the functions a user may run, and run the sign-in functions below. It cannot write a table, and it
--     cannot run a function that grants, settles or fulfils;
--   * `studio_worker` is what the worker connects as. It alone runs the functions that move money.
--
-- The web app tells this database who the visitor is (`app.user_id`, set for one transaction at a time, after it
-- has checked the session with `auth.whose_session`). So this database is safe against a visitor, and against
-- the web app for everything that creates or moves credit; it is NOT safe against a web app that lies about who
-- is asking (spec §4.3, accepted by the owner).

do $$
begin
  -- roles belong to the whole server, not to one database: made once, never given a password here (the setup
  -- command sets them, so no secret is ever in a migration)
  if not exists (select from pg_roles where rolname = 'studio_web') then create role studio_web nologin noinherit; end if;
  if not exists (select from pg_roles where rolname = 'studio_worker') then create role studio_worker nologin noinherit bypassrls; end if;
end $$;

-- Closed by default: whatever this file or a later one creates starts with no access for anyone but its owner.
revoke all on schema public from public;
grant usage on schema public to studio_web, studio_worker;
alter default privileges in schema public revoke all on tables from public;
alter default privileges in schema public revoke all on sequences from public;
alter default privileges revoke execute on functions from public;

create schema auth;
grant usage on schema auth to studio_web, studio_worker;

create table auth.users (
  id uuid primary key default gen_random_uuid(),
  -- always lower case and trimmed: the sign-in functions write it that way, and this refuses anything else
  email text not null check (email <> '' and email = lower(btrim(email)) and length(email) <= 254),
  -- scrypt, made and checked by the web app; null for an account that only signs in with Google
  password_hash text check (password_hash is null or length(password_hash) between 20 and 400),
  google_sub text unique,
  -- an address nobody confirmed is nobody's: such an account cannot sign in, and is given nothing
  email_confirmed_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index users_by_email on auth.users (email);

-- A session is a random secret in the visitor's cookie. Only its SHA-256 is kept: a copy of this table signs nobody in.
create table auth.sessions (
  token_hash bytea primary key check (octet_length(token_hash) = 32),
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index sessions_by_user on auth.sessions (user_id);
create index sessions_by_expiry on auth.sessions (expires_at);

-- The secret in an emailed link (confirming an address, choosing a new password), kept the same way, used once.
create table auth.email_tokens (
  token_hash bytea primary key check (octet_length(token_hash) = 32),
  user_id uuid not null references auth.users (id) on delete cascade,
  purpose text not null check (purpose in ('confirm', 'reset')),
  -- The SHA-256 of a second secret, kept in a cookie of the browser that asked for the link. A link signs a
  -- visitor in only in that browser: a link made by one person cannot sign another into the maker's account.
  browser_hash bytea not null check (octet_length(browser_hash) = 32),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);
create index email_tokens_by_user on auth.email_tokens (user_id);

-- What was tried, and when: sign-ins per address, emails per address, attempts per network address.
create table auth.attempts (
  key text not null check (length(key) between 1 and 300),
  at timestamptz not null default now()
);
create index attempts_by_key on auth.attempts (key, at);

alter table auth.users enable row level security;
alter table auth.sessions enable row level security;
alter table auth.email_tokens enable row level security;
alter table auth.attempts enable row level security;
-- no policy and no grant on any of the four: they are reached only through the functions below

-- Who the caller is. The web app sets `app.user_id` for the length of one transaction; anything else (a
-- connection that set nothing, a value that is no id) is nobody.
create function auth.uid() returns uuid
language plpgsql stable set search_path = '' as $$
declare
  v text := current_setting('app.user_id', true);
begin
  if v is null or v !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return null; end if;
  return v::uuid;
end $$;

-- Counts one attempt under `p_key` and says whether it is still within `p_max` per `p_window`. An attempt that
-- is refused is counted too: hammering does not get a turn back sooner.
create function auth.allow(p_key text, p_max integer, p_window interval) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_seen integer;
begin
  if p_key is null or p_key = '' or p_max is null or p_max < 1 or p_window is null then return false; end if;
  -- one key at a time, so two requests cannot both be the last one allowed
  perform pg_advisory_xact_lock(hashtextextended(p_key, 0));
  delete from auth.attempts where key = left(p_key, 300) and at < now() - p_window;
  select count(*) into v_seen from auth.attempts where key = left(p_key, 300);
  insert into auth.attempts (key) values (left(p_key, 300));
  return v_seen < p_max;
end $$;

-- A new account, or a new link for one that never confirmed its address. Returns:
--   'new'      an account was made; the caller emails the link (or, where `p_confirmed`, signs the visitor in)
--   'pending'  the address had an unconfirmed account: it now has this password and this link
--   'exists'   the address has a confirmed account: nothing was changed, and the caller tells the visitor
--              exactly what it tells them for 'new' (whether an address has an account is nobody's business)
-- `p_confirmed`: the studio sends no email (no mail server is set up), so an address is taken at its word.
create function auth.sign_up(p_email text, p_password_hash text, p_token_hash bytea, p_browser_hash bytea, p_confirmed boolean)
returns table (outcome text, user_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  u auth.users%rowtype;
begin
  if v_email = '' or p_password_hash is null then raise exception 'invalid_account'; end if;
  -- two sign-ups with one address take turns
  perform pg_advisory_xact_lock(hashtextextended('signup:' || v_email, 0));
  select * into u from auth.users where email = v_email;
  if found and u.email_confirmed_at is not null then
    return query select 'exists'::text, null::uuid;
    return;
  end if;
  if found then
    -- Someone made this account and never proved the address was theirs. Whoever signs up now may be its real
    -- owner: the password becomes theirs, every older link dies, and only the mailbox can finish it.
    update auth.users set password_hash = p_password_hash, email_confirmed_at = case when p_confirmed then now() end where id = u.id;
    delete from auth.email_tokens where email_tokens.user_id = u.id;
    delete from auth.sessions where sessions.user_id = u.id;
    if not p_confirmed then
      insert into auth.email_tokens (token_hash, user_id, purpose, browser_hash, expires_at) values (p_token_hash, u.id, 'confirm', p_browser_hash, now() + interval '1 day');
    end if;
    return query select 'pending'::text, u.id;
    return;
  end if;
  insert into auth.users (email, password_hash, email_confirmed_at) values (v_email, p_password_hash, case when p_confirmed then now() end) returning * into u;
  if not p_confirmed then
    insert into auth.email_tokens (token_hash, user_id, purpose, browser_hash, expires_at) values (p_token_hash, u.id, 'confirm', p_browser_hash, now() + interval '1 day');
  end if;
  return query select 'new'::text, u.id;
end $$;

-- What the web app needs to check a password: the account's id and hash. An address without an account, or one
-- that only signs in with Google, gives no row.
create function auth.credentials(p_email text)
returns table (user_id uuid, password_hash text, confirmed boolean)
language sql stable security definer set search_path = '' as $$
  select u.id, u.password_hash, u.email_confirmed_at is not null from auth.users u
  where u.email = lower(btrim(coalesce(p_email, ''))) and u.password_hash is not null;
$$;

create function auth.open_session(p_user_id uuid, p_token_hash bytea, p_days integer) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_days is null or p_days < 1 or p_days > 90 then raise exception 'invalid_session'; end if;
  -- only for an account that exists and whose address is confirmed
  if not exists (select 1 from auth.users where id = p_user_id and email_confirmed_at is not null) then raise exception 'invalid_session'; end if;
  insert into auth.sessions (token_hash, user_id, expires_at) values (p_token_hash, p_user_id, now() + make_interval(days => p_days));
  -- tidy as we go: what has run out is of no use to anyone
  delete from auth.sessions where expires_at < now() - interval '1 day';
  delete from auth.email_tokens where expires_at < now() - interval '7 days';
  delete from auth.attempts where at < now() - interval '1 day';
end $$;

-- Whose session this is, or no row. This is the one place a cookie becomes a user.
create function auth.whose_session(p_token_hash bytea)
returns table (user_id uuid, email text)
language sql stable security definer set search_path = '' as $$
  select u.id, u.email from auth.sessions s join auth.users u on u.id = s.user_id
  where s.token_hash = p_token_hash and s.expires_at > now() and u.email_confirmed_at is not null;
$$;

create function auth.close_session(p_token_hash bytea) returns void
language sql security definer set search_path = '' as $$
  delete from auth.sessions where token_hash = p_token_hash;
$$;

-- Uses an emailed link. Confirming works in any browser (the address is proven either way); `same_browser`
-- says whether the visitor may also be signed in here. A link to choose a new password works only in the
-- browser that asked for it, and is not used up anywhere else.
create function auth.use_link(p_token_hash bytea, p_browser_hash bytea)
returns table (user_id uuid, purpose text, same_browser boolean)
language plpgsql security definer set search_path = '' as $$
declare
  t auth.email_tokens%rowtype;
  v_same boolean;
begin
  select * into t from auth.email_tokens where token_hash = p_token_hash for update;
  if not found or t.used_at is not null or t.expires_at <= now() then return; end if;
  v_same := p_browser_hash is not null and t.browser_hash = p_browser_hash;
  if t.purpose = 'reset' and not v_same then return; end if;
  update auth.email_tokens set used_at = now() where token_hash = p_token_hash;
  -- either kind of link proves the mailbox is the visitor's
  update auth.users set email_confirmed_at = coalesce(email_confirmed_at, now()) where id = t.user_id;
  return query select t.user_id, t.purpose, v_same;
end $$;

-- Asks for a link to choose a new password. Returns whether there is an account to send it to; the caller
-- answers the visitor the same either way.
create function auth.request_reset(p_email text, p_token_hash bytea, p_browser_hash bytea) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid;
begin
  select id into v_user from auth.users where email = lower(btrim(coalesce(p_email, '')));
  if not found then return false; end if;
  delete from auth.email_tokens where user_id = v_user and purpose = 'reset';
  insert into auth.email_tokens (token_hash, user_id, purpose, browser_hash, expires_at) values (p_token_hash, v_user, 'reset', p_browser_hash, now() + interval '1 hour');
  return true;
end $$;

-- The signed-in user chooses a new password. Every other session of theirs ends: whoever else was signed in
-- with the old one is out.
create function auth.set_password(p_password_hash text, p_keep_session bytea) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then raise exception 'unauthenticated'; end if;
  if p_password_hash is null then raise exception 'invalid_account'; end if;
  update auth.users set password_hash = p_password_hash where id = v_user;
  if not found then raise exception 'unauthenticated'; end if;
  delete from auth.sessions where user_id = v_user and (p_keep_session is null or token_hash <> p_keep_session);
  delete from auth.email_tokens where user_id = v_user;
end $$;

-- A visitor Google vouches for. `p_email` must be one Google says it verified (the web app checks that before
-- it calls this). Returns the account: the one already tied to this Google identity, else the one with this
-- address, else a new one.
create function auth.google(p_sub text, p_email text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  u auth.users%rowtype;
begin
  if p_sub is null or p_sub = '' or v_email = '' then raise exception 'invalid_account'; end if;
  perform pg_advisory_xact_lock(hashtextextended('signup:' || v_email, 0));
  select * into u from auth.users where google_sub = p_sub;
  if found then return u.id; end if;
  select * into u from auth.users where email = v_email;
  if found then
    -- An account with this address that never confirmed it may have been made by someone else: its password
    -- and sessions go, and it becomes the mailbox owner's. A confirmed one simply gains this way in.
    if u.email_confirmed_at is null then
      update auth.users set password_hash = null where id = u.id;
      delete from auth.sessions where user_id = u.id;
      delete from auth.email_tokens where user_id = u.id;
    end if;
    update auth.users set google_sub = p_sub, email_confirmed_at = coalesce(email_confirmed_at, now()) where id = u.id;
    return u.id;
  end if;
  insert into auth.users (email, google_sub, email_confirmed_at) values (v_email, p_sub, now()) returning * into u;
  return u.id;
end $$;

revoke execute on all functions in schema auth from public;
grant execute on function auth.uid() to studio_web, studio_worker;
grant execute on function
  auth.allow(text, integer, interval), auth.sign_up(text, text, bytea, bytea, boolean), auth.credentials(text),
  auth.open_session(uuid, bytea, integer), auth.whose_session(bytea), auth.close_session(bytea),
  auth.use_link(bytea, bytea), auth.request_reset(text, bytea, bytea), auth.set_password(text, bytea),
  auth.google(text, text)
  to studio_web;
