alter table public.telegram_pending_batches
  add column if not exists processing_expires_at timestamptz;

create index if not exists telegram_pending_batches_processing_expiry_idx
  on public.telegram_pending_batches (processing_expires_at)
  where status = 'processing';

-- Rows claimed by the pre-lease worker have no expiry and would otherwise be stranded.
update public.telegram_pending_batches
set
  status = 'pending',
  processing_expires_at = null,
  updated_at = now()
where status = 'processing'
  and processing_expires_at is null;

drop function if exists public.claim_ready_telegram_pending_batches(timestamptz, integer);

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

notify pgrst, 'reload schema';
