-- 005_verified_delivery_tracking.sql
-- Retain privacy-minimal, verified provider callback evidence separately from
-- the outbound queue lifecycle. delivery_jobs.status continues to mean that a
-- provider accepted a message; downstream_status describes later delivery.

create type public.delivery_provider as enum (
  'twilio',
  'resend'
);

create type public.delivery_event_type as enum (
  'accepted',
  'delivered',
  'delayed',
  'failed',
  'complained'
);

create type public.delivery_downstream_status as enum (
  'delivered',
  'delayed',
  'failed',
  'mixed',
  'complained'
);

alter table public.delivery_jobs
  add column downstream_status public.delivery_downstream_status,
  add column downstream_status_at timestamptz,
  add column delivered_at timestamptz,
  add column delayed_at timestamptz,
  add column failed_at timestamptz,
  add column complained_at timestamptz,
  add column last_reconciled_at timestamptz,
  add constraint delivery_jobs_downstream_status_time
    check ((downstream_status is null) = (downstream_status_at is null)),
  add constraint delivery_jobs_downstream_kind
    check (
      kind = 'private_feedback_email'
      or downstream_status is null
      or downstream_status in ('delivered', 'delayed', 'failed')
    );

create unique index delivery_jobs_provider_message_id_key
  on public.delivery_jobs (kind, provider_message_id)
  where provider_message_id is not null;

create index delivery_jobs_twilio_reconciliation_idx
  on public.delivery_jobs (
    (coalesce(last_reconciled_at, accepted_at, first_provider_call_started_at)),
    id
  )
  where kind = 'survey_sms' and provider_message_id is not null;

comment on column public.delivery_jobs.downstream_status is
  'Privacy-minimal aggregate of verified delivery evidence. Queue status still means provider acceptance.';
comment on column public.delivery_jobs.downstream_status_at is
  'Time the aggregate downstream status last changed; not a provider acceptance time.';
comment on column public.delivery_jobs.last_reconciled_at is
  'Last time an operator reconciliation run claimed this opaque provider message for a status lookup.';

create table public.delivery_events (
  id uuid primary key default gen_random_uuid(),
  delivery_job_id uuid not null references public.delivery_jobs (id) on delete cascade,
  provider public.delivery_provider not null,
  provider_message_id text not null,
  provider_event_key text not null,
  event_type public.delivery_event_type not null,
  occurred_at timestamptz not null,
  received_at timestamptz not null,
  provider_code text,
  constraint delivery_events_provider_event_key_unique
    unique (provider, provider_event_key),
  constraint delivery_events_provider_message_id_length
    check (char_length(provider_message_id) between 1 and 255),
  constraint delivery_events_provider_event_key_length
    check (char_length(provider_event_key) between 1 and 255),
  constraint delivery_events_provider_code_length
    check (provider_code is null or char_length(provider_code) <= 128)
);

create index delivery_events_job_received_idx
  on public.delivery_events (delivery_job_id, received_at);
create index delivery_events_retention_idx
  on public.delivery_events (received_at, id);

alter table public.delivery_events enable row level security;

revoke all privileges on public.delivery_events
  from public, anon, authenticated, service_role;
grant select on public.delivery_events to service_role;

comment on table public.delivery_events is
  'Append-only, service-role-only verified callback receipts. Contains no raw payloads, recipients, message bodies, answers, comments, or recipient fingerprints.';
comment on column public.delivery_events.provider_event_key is
  'Opaque provider receipt ID or deterministic reconciliation key used only for deduplication.';
comment on column public.delivery_events.provider_code is
  'Sanitized provider status or error code, limited to 128 characters.';

create or replace function public.mark_delivery_job_sent(
  p_job_id uuid,
  p_lease_token uuid,
  p_provider_message_id text,
  p_accepted_at timestamptz
)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_survey_id uuid;
  v_kind public.delivery_job_kind;
  v_status public.delivery_job_status;
  v_existing_provider_message_id text;
  v_provider_message_id text := nullif(btrim(p_provider_message_id), '');
begin
  if p_job_id is null
    or p_lease_token is null
    or v_provider_message_id is null
    or char_length(v_provider_message_id) > 255
    or p_accepted_at is null then
    return false;
  end if;

  begin
    update public.delivery_jobs as job
    set
      status = 'sent',
      provider_message_id = v_provider_message_id,
      accepted_at = p_accepted_at,
      claimed_by_run_id = null,
      lease_token = null,
      lease_expires_at = null,
      last_error_category = null,
      last_error_code = null,
      updated_at = p_accepted_at
    where job.id = p_job_id
      and job.status = 'processing'
      and job.lease_token = p_lease_token
      and job.provider_call_started_at is not null
      and (
        job.provider_message_id is null
        or job.provider_message_id = v_provider_message_id
      )
    returning job.survey_id, job.kind
    into v_survey_id, v_kind;
  exception when unique_violation then
    return false;
  end;

  if v_survey_id is null then
    select job.survey_id, job.kind, job.status, job.provider_message_id
    into v_survey_id, v_kind, v_status, v_existing_provider_message_id
    from public.delivery_jobs as job
    where job.id = p_job_id;

    -- A verified callback can win the race with the worker response. Treat the
    -- worker's later save of that same provider ID as an idempotent success.
    if not found
      or v_status <> 'sent'
      or v_existing_provider_message_id is distinct from v_provider_message_id then
      return false;
    end if;

    return true;
  end if;

  if v_kind = 'survey_sms' then
    update public.surveys as survey
    set sent_at = coalesce(survey.sent_at, p_accepted_at)
    where survey.id = v_survey_id;
  end if;

  return true;
end;
$$;

create function public.record_delivery_event(
  p_delivery_job_id uuid,
  p_provider public.delivery_provider,
  p_provider_message_id text,
  p_provider_event_key text,
  p_event_type public.delivery_event_type,
  p_occurred_at timestamptz,
  p_received_at timestamptz,
  p_provider_code text
)
returns table (
  outcome text,
  job_status public.delivery_job_status,
  downstream_status public.delivery_downstream_status
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.delivery_jobs%rowtype;
  v_existing_event public.delivery_events%rowtype;
  v_event_id uuid;
  v_provider_message_id text := nullif(btrim(p_provider_message_id), '');
  v_provider_event_key text := nullif(btrim(p_provider_event_key), '');
  v_provider_code text := case
    when nullif(btrim(p_provider_code), '') ~ '^[A-Za-z0-9_.:-]{1,128}$'
      then btrim(p_provider_code)
    else null
  end;
  v_accepted_at timestamptz;
  v_delivered_at timestamptz;
  v_delayed_at timestamptz;
  v_failed_at timestamptz;
  v_complained_at timestamptz;
  v_downstream_status public.delivery_downstream_status;
begin
  if p_delivery_job_id is null
    or p_provider is null
    or v_provider_message_id is null
    or char_length(v_provider_message_id) > 255
    or v_provider_event_key is null
    or char_length(v_provider_event_key) > 255
    or p_event_type is null
    or p_occurred_at is null
    or p_received_at is null then
    raise exception using
      errcode = '22023',
      message = 'delivery event inputs are invalid';
  end if;

  select job.*
  into v_job
  from public.delivery_jobs as job
  where job.id = p_delivery_job_id
  for update;

  if not found then
    return query
      select 'not_found'::text, null::public.delivery_job_status, null::public.delivery_downstream_status;
    return;
  end if;

  if (p_provider = 'twilio' and v_job.kind <> 'survey_sms')
    or (p_provider = 'resend' and v_job.kind <> 'private_feedback_email') then
    return query
      select 'provider_kind_mismatch'::text, v_job.status, v_job.downstream_status;
    return;
  end if;

  if p_provider = 'twilio' and p_event_type = 'complained' then
    return query
      select 'event_type_mismatch'::text, v_job.status, v_job.downstream_status;
    return;
  end if;

  if v_job.provider_message_id is not null
    and v_job.provider_message_id <> v_provider_message_id then
    return query
      select 'provider_message_mismatch'::text, v_job.status, v_job.downstream_status;
    return;
  end if;

  select event.*
  into v_existing_event
  from public.delivery_events as event
  where event.provider = p_provider
    and event.provider_event_key = v_provider_event_key;

  if found then
    if v_existing_event.delivery_job_id = p_delivery_job_id
      and v_existing_event.provider_message_id = v_provider_message_id
      and v_existing_event.event_type = p_event_type then
      return query
        select 'duplicate'::text, v_job.status, v_job.downstream_status;
    else
      return query
        select 'event_key_conflict'::text, v_job.status, v_job.downstream_status;
    end if;
    return;
  end if;

  begin
    insert into public.delivery_events (
      delivery_job_id,
      provider,
      provider_message_id,
      provider_event_key,
      event_type,
      occurred_at,
      received_at,
      provider_code
    ) values (
      p_delivery_job_id,
      p_provider,
      v_provider_message_id,
      v_provider_event_key,
      p_event_type,
      p_occurred_at,
      p_received_at,
      v_provider_code
    )
    on conflict (provider, provider_event_key) do nothing
    returning id into v_event_id;

    if v_event_id is null then
      select event.*
      into v_existing_event
      from public.delivery_events as event
      where event.provider = p_provider
        and event.provider_event_key = v_provider_event_key;

      if v_existing_event.delivery_job_id = p_delivery_job_id
        and v_existing_event.provider_message_id = v_provider_message_id
        and v_existing_event.event_type = p_event_type then
        return query
          select 'duplicate'::text, v_job.status, v_job.downstream_status;
      else
        return query
          select 'event_key_conflict'::text, v_job.status, v_job.downstream_status;
      end if;
      return;
    end if;

    v_accepted_at := coalesce(
      v_job.accepted_at,
      v_job.provider_call_started_at,
      v_job.first_provider_call_started_at,
      p_received_at
    );

    update public.delivery_jobs as job
    set
      provider_message_id = coalesce(job.provider_message_id, v_provider_message_id),
      status = case
        when job.status in ('pending', 'processing', 'dead', 'unknown') then 'sent'::public.delivery_job_status
        else job.status
      end,
      accepted_at = case
        when job.status in ('pending', 'processing', 'dead', 'unknown') then coalesce(job.accepted_at, v_accepted_at)
        else job.accepted_at
      end,
      claimed_by_run_id = case
        when job.status in ('pending', 'processing', 'dead', 'unknown') then null
        else job.claimed_by_run_id
      end,
      lease_token = case
        when job.status in ('pending', 'processing', 'dead', 'unknown') then null
        else job.lease_token
      end,
      lease_expires_at = case
        when job.status in ('pending', 'processing', 'dead', 'unknown') then null
        else job.lease_expires_at
      end,
      last_error_category = case
        when job.status in ('pending', 'processing', 'dead', 'unknown') then null
        else job.last_error_category
      end,
      last_error_code = case
        when job.status in ('pending', 'processing', 'dead', 'unknown') then null
        else job.last_error_code
      end,
      updated_at = greatest(job.updated_at, p_received_at)
    where job.id = p_delivery_job_id
    returning job.* into v_job;
  exception when unique_violation then
    return query
      select 'provider_message_conflict'::text, v_job.status, v_job.downstream_status;
    return;
  end;

  v_delivered_at := v_job.delivered_at;
  v_delayed_at := v_job.delayed_at;
  v_failed_at := v_job.failed_at;
  v_complained_at := v_job.complained_at;

  if p_event_type = 'delivered' then
    v_delivered_at := case
      when v_delivered_at is null then p_occurred_at
      else least(v_delivered_at, p_occurred_at)
    end;
  elsif p_event_type = 'delayed' then
    v_delayed_at := case
      when v_delayed_at is null then p_occurred_at
      else least(v_delayed_at, p_occurred_at)
    end;
  elsif p_event_type = 'failed' then
    v_failed_at := case
      when v_failed_at is null then p_occurred_at
      else least(v_failed_at, p_occurred_at)
    end;
  elsif p_event_type = 'complained' then
    v_complained_at := case
      when v_complained_at is null then p_occurred_at
      else least(v_complained_at, p_occurred_at)
    end;
  end if;

  if v_job.kind = 'survey_sms' then
    v_downstream_status := case
      when v_delivered_at is not null then 'delivered'::public.delivery_downstream_status
      when v_failed_at is not null then 'failed'::public.delivery_downstream_status
      when v_delayed_at is not null then 'delayed'::public.delivery_downstream_status
      else null::public.delivery_downstream_status
    end;
  else
    v_downstream_status := case
      when v_complained_at is not null then 'complained'::public.delivery_downstream_status
      when v_delivered_at is not null and v_failed_at is not null then 'mixed'::public.delivery_downstream_status
      when v_delivered_at is not null then 'delivered'::public.delivery_downstream_status
      when v_failed_at is not null then 'failed'::public.delivery_downstream_status
      when v_delayed_at is not null then 'delayed'::public.delivery_downstream_status
      else null::public.delivery_downstream_status
    end;
  end if;

  update public.delivery_jobs as job
  set
    downstream_status = v_downstream_status,
    downstream_status_at = case
      when job.downstream_status is distinct from v_downstream_status then p_received_at
      else job.downstream_status_at
    end,
    delivered_at = v_delivered_at,
    delayed_at = v_delayed_at,
    failed_at = v_failed_at,
    complained_at = v_complained_at,
    updated_at = greatest(job.updated_at, p_received_at)
  where job.id = p_delivery_job_id
  returning job.* into v_job;

  if v_job.kind = 'survey_sms' and v_job.status = 'sent' then
    update public.surveys as survey
    set sent_at = coalesce(survey.sent_at, v_job.accepted_at)
    where survey.id = v_job.survey_id;
  end if;

  return query select 'recorded'::text, v_job.status, v_job.downstream_status;
end;
$$;

create function public.get_delivery_health_summary(
  p_now timestamptz
)
returns table (
  overdue_count bigint,
  stale_count bigint,
  dead_count bigint,
  unknown_count bigint,
  failed_count bigint,
  mixed_count bigint,
  complained_count bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    count(*) filter (
      where job.status = 'pending'
        and job.next_attempt_at <= p_now - interval '15 minutes'
    )::bigint as overdue_count,
    count(*) filter (
      where job.status = 'processing' and job.lease_expires_at <= p_now
    )::bigint as stale_count,
    count(*) filter (where job.status = 'dead')::bigint as dead_count,
    count(*) filter (where job.status = 'unknown')::bigint as unknown_count,
    count(*) filter (where job.downstream_status = 'failed')::bigint as failed_count,
    count(*) filter (where job.downstream_status = 'mixed')::bigint as mixed_count,
    count(*) filter (where job.downstream_status = 'complained')::bigint as complained_count
  from public.delivery_jobs as job
  where p_now is not null;
$$;

create function public.get_twilio_reconciliation_candidates(
  p_now timestamptz,
  p_limit integer
)
returns table (
  delivery_job_id uuid,
  provider_message_id text
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_now is null or p_limit is null or p_limit not between 1 and 1000 then
    raise exception using
      errcode = '22023',
      message = 'reconciliation inputs are invalid';
  end if;

  return query
    with candidates as (
      select job.id
      from public.delivery_jobs as job
      where job.kind = 'survey_sms'
        and job.status in ('sent', 'unknown')
        and job.provider_message_id is not null
        and coalesce(job.accepted_at, job.first_provider_call_started_at) <= p_now - interval '12 hours'
        and (job.downstream_status is null or job.downstream_status = 'delayed')
        and (
          job.last_reconciled_at is null
          or job.last_reconciled_at <= p_now - interval '12 hours'
        )
      order by
        coalesce(
          job.last_reconciled_at,
          job.accepted_at,
          job.first_provider_call_started_at
        ),
        job.id
      for update skip locked
      limit p_limit
    ), marked as (
      update public.delivery_jobs as job
      set
        last_reconciled_at = p_now,
        updated_at = greatest(job.updated_at, p_now)
      from candidates
      where job.id = candidates.id
      returning job.id, job.provider_message_id, job.last_reconciled_at
    )
    select marked.id, marked.provider_message_id
    from marked
    order by marked.last_reconciled_at, marked.id;
end;
$$;

create function public.purge_delivery_events(
  p_now timestamptz,
  p_limit integer
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted_count integer;
begin
  if p_now is null or p_limit is null or p_limit not between 1 and 10000 then
    raise exception using
      errcode = '22023',
      message = 'delivery event cleanup inputs are invalid';
  end if;

  -- A caller-supplied clock makes local tests deterministic, but it must not
  -- permit an accidental future date to erase receipts still inside retention.
  if p_now > clock_timestamp() + interval '5 minutes' then
    raise exception using
      errcode = '22023',
      message = 'delivery event cleanup time is invalid';
  end if;

  with victims as (
    select event.id
    from public.delivery_events as event
    where event.received_at < p_now - interval '90 days'
    order by event.received_at, event.id
    for update skip locked
    limit p_limit
  )
  delete from public.delivery_events as event
  using victims
  where event.id = victims.id;

  get diagnostics v_deleted_count = row_count;
  return v_deleted_count;
end;
$$;

revoke all on function public.record_delivery_event(uuid, public.delivery_provider, text, text, public.delivery_event_type, timestamptz, timestamptz, text)
  from public, anon, authenticated;
revoke all on function public.get_delivery_health_summary(timestamptz)
  from public, anon, authenticated;
revoke all on function public.get_twilio_reconciliation_candidates(timestamptz, integer)
  from public, anon, authenticated;
revoke all on function public.purge_delivery_events(timestamptz, integer)
  from public, anon, authenticated;

grant execute on function public.record_delivery_event(uuid, public.delivery_provider, text, text, public.delivery_event_type, timestamptz, timestamptz, text)
  to service_role;
grant execute on function public.get_delivery_health_summary(timestamptz)
  to service_role;
grant execute on function public.get_twilio_reconciliation_candidates(timestamptz, integer)
  to service_role;
grant execute on function public.purge_delivery_events(timestamptz, integer)
  to service_role;
