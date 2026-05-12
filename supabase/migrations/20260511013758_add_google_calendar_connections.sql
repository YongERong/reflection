create type public.google_calendar_connection_status as enum ('active', 'needs_reauth', 'disconnected');
create type public.google_calendar_event_status as enum ('active', 'cancelled', 'sync_failed');

create table public.telegram_google_auth_links (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.student_profiles (id) on delete cascade,
  telegram_user_id text not null,
  telegram_chat_id text,
  token_hash text not null unique,
  state text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create index telegram_google_auth_links_token_hash_idx
  on public.telegram_google_auth_links (token_hash)
  where used_at is null;

create index telegram_google_auth_links_state_idx
  on public.telegram_google_auth_links (state)
  where used_at is null;

create index telegram_google_auth_links_expiry_idx
  on public.telegram_google_auth_links (expires_at)
  where used_at is null;

create table public.student_google_calendar_connections (
  student_id uuid primary key references public.student_profiles (id) on delete cascade,
  google_sub text not null,
  google_email text not null,
  scopes text[] not null default '{}',
  encrypted_refresh_token text,
  calendar_id text not null default 'primary',
  status public.google_calendar_connection_status not null default 'active',
  connected_at timestamptz not null default now(),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index student_google_calendar_connections_active_google_sub_idx
  on public.student_google_calendar_connections (google_sub)
  where status = 'active';

create table public.student_calendar_events (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.student_profiles (id) on delete cascade,
  google_event_id text not null,
  calendar_id text not null default 'primary',
  source_kind text not null,
  source_id text,
  last_synced_payload jsonb not null default '{}'::jsonb,
  status public.google_calendar_event_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (student_id, calendar_id, google_event_id)
);

alter table public.telegram_google_auth_links enable row level security;
alter table public.student_google_calendar_connections enable row level security;
alter table public.student_calendar_events enable row level security;

create policy "admins read telegram google auth links"
  on public.telegram_google_auth_links for select
  using (public.is_admin());

create policy "teachers read assigned calendar connections"
  on public.student_google_calendar_connections for select
  using (public.can_view_student(student_id));

create policy "teachers read assigned calendar events"
  on public.student_calendar_events for select
  using (public.can_view_student(student_id));
