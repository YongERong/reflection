create type public.telegram_pending_batch_status as enum ('pending', 'processing', 'processed', 'cancelled');

create table public.telegram_pending_batches (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.student_profiles (id) on delete cascade,
  reflection_id uuid not null references public.reflections (id) on delete cascade,
  telegram_chat_id text,
  messages jsonb not null default '[]'::jsonb,
  message_count integer not null default 0 check (message_count >= 0),
  first_message_at timestamptz not null,
  last_message_at timestamptz not null,
  flush_after timestamptz not null,
  status public.telegram_pending_batch_status not null default 'pending',
  stale boolean not null default false,
  processing_expires_at timestamptz,
  cancellation_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index telegram_pending_batches_one_pending_per_reflection
  on public.telegram_pending_batches (student_id, reflection_id)
  where status = 'pending';

create index telegram_pending_batches_ready_idx
  on public.telegram_pending_batches (flush_after)
  where status = 'pending';

create index telegram_pending_batches_processing_expiry_idx
  on public.telegram_pending_batches (processing_expires_at)
  where status = 'processing';

alter table public.telegram_pending_batches enable row level security;

create policy "admins read telegram pending batches"
  on public.telegram_pending_batches for select
  using (public.is_admin());

create or replace function public.append_telegram_pending_batch(
  p_student_id uuid,
  p_reflection_id uuid,
  p_telegram_chat_id text,
  p_text text,
  p_received_at timestamptz,
  p_delay_seconds integer,
  p_stale_after_seconds integer
)
returns public.telegram_pending_batches
language plpgsql
set search_path = public
as $$
declare
  v_batch public.telegram_pending_batches;
  v_message jsonb := jsonb_build_object('text', p_text, 'receivedAt', p_received_at);
begin
  loop
    update public.telegram_pending_batches
    set
      telegram_chat_id = coalesce(p_telegram_chat_id, telegram_chat_id),
      messages = messages || jsonb_build_array(v_message),
      message_count = message_count + 1,
      last_message_at = p_received_at,
      flush_after = p_received_at + make_interval(secs => p_delay_seconds),
      stale = stale or (p_received_at - first_message_at > make_interval(secs => p_stale_after_seconds)),
      updated_at = now()
    where student_id = p_student_id
      and reflection_id = p_reflection_id
      and status = 'pending'
    returning * into v_batch;

    if found then
      return v_batch;
    end if;

    begin
      insert into public.telegram_pending_batches (
        student_id,
        reflection_id,
        telegram_chat_id,
        messages,
        message_count,
        first_message_at,
        last_message_at,
        flush_after,
        stale
      )
      values (
        p_student_id,
        p_reflection_id,
        p_telegram_chat_id,
        jsonb_build_array(v_message),
        1,
        p_received_at,
        p_received_at,
        p_received_at + make_interval(secs => p_delay_seconds),
        now() - p_received_at > make_interval(secs => p_stale_after_seconds)
      )
      returning * into v_batch;

      return v_batch;
    exception
      when unique_violation then
        -- Another worker inserted the pending row first; loop and update it.
    end;
  end loop;
end;
$$;

create or replace function public.claim_ready_telegram_pending_batches(
  p_ready_at timestamptz,
  p_now timestamptz,
  p_stale_after_seconds integer,
  p_processing_lease_seconds integer,
  p_limit integer
)
returns setof public.telegram_pending_batches
language sql
set search_path = public
as $$
  update public.telegram_pending_batches
  set
    status = 'processing',
    stale = stale or (p_now - last_message_at > make_interval(secs => p_stale_after_seconds)),
    processing_expires_at = p_now + make_interval(secs => p_processing_lease_seconds),
    updated_at = now()
  where id in (
    select id
    from public.telegram_pending_batches
    where (
        status = 'pending'
        and flush_after <= p_ready_at
      )
      or (
        status = 'processing'
        and processing_expires_at <= p_now
      )
    order by flush_after asc
    limit p_limit
    for update skip locked
  )
  returning *;
$$;
