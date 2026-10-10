-- Publishing to a user's own channel (phase 6 spec §6, §10). A user connects their channel through the
-- platform's own consent page; what comes back lets the studio upload to that channel in the user's name.
--
-- That token is as dangerous as a password for the channel. It is kept encrypted with a key that only the
-- worker has, in a table the web role cannot read at all: the web app learns that a channel is connected and
-- what it is called, through a function, and never holds what could post to it.

create table public.channels (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  provider text not null check (provider in ('youtube')),
  -- the channel as the platform names it, and what it is called there
  external_id text not null check (char_length(external_id) between 1 and 200),
  title text not null default '' check (char_length(title) <= 200),
  -- the refresh token, sealed by the worker (AES-256-GCM: nonce, tag, ciphertext)
  token bytea not null check (octet_length(token) between 29 and 8192),
  created_at timestamptz not null default now(),
  unique (user_id, provider, external_id)
);

-- A video published, or to be, on a channel.
create table public.posts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  run_id text not null references public.runs (id) on delete cascade,
  channel_id uuid not null references public.channels (id) on delete cascade,
  status text not null default 'queued' check (status in ('queued', 'posted', 'failed')),
  -- where it is, once it is there
  external_id text,
  url text check (url is null or url ~ '^https://'),
  -- our own words for what went wrong, never the platform's raw answer
  error text check (error is null or char_length(error) <= 300),
  created_at timestamptz not null default now(),
  posted_at timestamptz,
  -- a video is on a channel once
  unique (run_id, channel_id)
);
create index posts_by_user on public.posts (user_id, created_at desc);

alter table public.series
  -- where its videos go, and whether its owner sees each one first (D3; the default is to be shown)
  add column channel_id uuid references public.channels (id) on delete set null,
  add column review_first boolean not null default true;

alter table public.channels enable row level security;
alter table public.posts enable row level security;
-- (no policy on channels for the web role, and no grant: it cannot read the table. It may read a user's own posts.)
create policy "own rows" on public.posts for select to studio_web using (user_id = (select auth.uid()));
grant select on public.posts to studio_web;
grant select on public.channels, public.posts to studio_worker;

-- A user's own channels, without what could post to them.
create function public.my_channels() returns table (id uuid, provider text, title text, created_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select c.id, c.provider, c.title, c.created_at from public.channels c where c.user_id = auth.uid() order by c.created_at
$$;

create function public.unlink_channel(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.channels where id = p_id and user_id = auth.uid();
  -- someone else's channel does not exist
  if not found then raise exception 'not_found'; end if;
end $$;

-- A user asks for one of their finished videos to go to one of their channels. Returns the post to carry out.
-- Asked again for a video that could not be posted, the same post is tried again; one that is there stays there.
create function public.request_post(p_run_id text, p_channel_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_id uuid;
  v_status text;
begin
  if v_user is null then raise exception 'unauthenticated'; end if;
  if not exists (select 1 from public.runs where id = p_run_id and user_id = v_user) then raise exception 'not_found'; end if;
  if not exists (select 1 from public.channels where id = p_channel_id and user_id = v_user) then raise exception 'not_found'; end if;
  select id, status into v_id, v_status from public.posts where run_id = p_run_id and channel_id = p_channel_id for update;
  if found then
    if v_status = 'posted' then raise exception 'already_posted'; end if;
    if v_status = 'queued' then raise exception 'post_pending'; end if;
    update public.posts set status = 'queued', error = null where id = v_id;
    return v_id;
  end if;
  insert into public.posts (user_id, run_id, channel_id) values (v_user, p_run_id, p_channel_id) returning id into v_id;
  return v_id;
end $$;

-- Where a series' videos go, and whether each is shown to its owner first. Only to a channel of the owner's own.
create function public.set_series_publishing(p_id uuid, p_channel_id uuid, p_review_first boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_channel_id is not null and not exists (select 1 from public.channels where id = p_channel_id and user_id = auth.uid()) then raise exception 'not_found'; end if;
  update public.series set channel_id = p_channel_id, review_first = coalesce(p_review_first, true) where id = p_id and user_id = auth.uid();
  if not found then raise exception 'not_found'; end if;
end $$;

-- ---------------------------------------------------------------------------------------------------------
-- For the worker only.

-- Keeps a channel a user has just connected, with its sealed token. Connected again, its token is replaced.
create function public.link_channel(p_user_id uuid, p_provider text, p_external_id text, p_title text, p_token bytea) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  perform 1 from public.users where id = p_user_id for update;
  if not found then raise exception 'not_found'; end if;
  -- rows are not free to make without end
  if (select count(*) from public.channels where user_id = p_user_id) >= 5
     and not exists (select 1 from public.channels where user_id = p_user_id and provider = p_provider and external_id = p_external_id) then
    raise exception 'too_many_channels';
  end if;
  insert into public.channels (user_id, provider, external_id, title, token)
    values (p_user_id, p_provider, p_external_id, left(coalesce(p_title, ''), 200), p_token)
    on conflict (user_id, provider, external_id) do update set token = excluded.token, title = excluded.title
    returning id into v_id;
  return v_id;
end $$;

-- A series whose owner does not ask to see each video first has its finished video posted: the post for it.
-- Nothing when the series has no channel, asks to be shown first, or the video is not the series' own.
create function public.post_for_series(p_series_id uuid, p_run_id text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  s public.series%rowtype;
  v_id uuid;
begin
  select * into s from public.series where id = p_series_id;
  if not found or s.channel_id is null or s.review_first then return null; end if;
  if not exists (select 1 from public.runs where id = p_run_id and series_id = s.id and user_id = s.user_id) then return null; end if;
  insert into public.posts (user_id, run_id, channel_id) values (s.user_id, p_run_id, s.channel_id)
    on conflict (run_id, channel_id) do nothing returning id into v_id;
  return v_id;
end $$;

-- What became of a post. A post that is there is not changed again.
create function public.record_post(p_id uuid, p_status text, p_external_id text default null, p_url text default null, p_error text default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_status not in ('posted', 'failed') then raise exception 'invalid_status'; end if;
  update public.posts set
      status = p_status, external_id = p_external_id, url = p_url, error = left(p_error, 300),
      posted_at = case when p_status = 'posted' then now() else null end
    where id = p_id and status <> 'posted';
end $$;

revoke execute on function
  public.my_channels(), public.unlink_channel(uuid), public.request_post(text, uuid), public.set_series_publishing(uuid, uuid, boolean),
  public.link_channel(uuid, text, text, text, bytea), public.post_for_series(uuid, text), public.record_post(uuid, text, text, text, text)
  from public;
grant execute on function public.my_channels(), public.unlink_channel(uuid), public.request_post(text, uuid), public.set_series_publishing(uuid, uuid, boolean) to studio_web;
grant execute on function public.link_channel(uuid, text, text, text, bytea), public.post_for_series(uuid, text), public.record_post(uuid, text, text, text, text) to studio_worker;
