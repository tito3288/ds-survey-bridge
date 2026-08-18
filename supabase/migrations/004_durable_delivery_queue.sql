-- 004_durable_delivery_queue.sql
-- Persist outbound survey SMS and private-feedback email work so provider
-- outages and process restarts cannot silently lose a delivery.

create type public.delivery_job_kind as enum (
  'survey_sms',
  'private_feedback_email'
);

create type public.delivery_job_status as enum (
  'pending',
  'processing',
  'sent',
  'dead',
  'unknown'
);

create table public.delivery_jobs (
  id uuid primary key default gen_random_uuid(),
  survey_id uuid not null references public.surveys (id) on delete cascade,
  kind public.delivery_job_kind not null,
  status public.delivery_job_status not null default 'pending',
  scheduled_at timestamptz not null,
  next_attempt_at timestamptz not null,
  attempt_count smallint not null default 0,
  claimed_by_run_id uuid,
  lease_token uuid,
  lease_expires_at timestamptz,
  first_provider_call_started_at timestamptz,
  provider_call_started_at timestamptz,
  provider_message_id text,
  accepted_at timestamptz,
  last_error_category text,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint delivery_jobs_survey_kind_key unique (survey_id, kind),
  constraint delivery_jobs_attempt_count_range
    check (attempt_count between 0 and 6),
  constraint delivery_jobs_lease_all_or_none
    check ((lease_token is null) = (lease_expires_at is null)),
  constraint delivery_jobs_processing_has_lease
    check (
      (status = 'processing' and lease_token is not null and claimed_by_run_id is not null)
      or
      (status <> 'processing' and lease_token is null and lease_expires_at is null and claimed_by_run_id is null)
    ),
  constraint delivery_jobs_sent_has_acceptance
    check (
      (status = 'sent' and accepted_at is not null)
      or
      (status <> 'sent' and accepted_at is null)
    ),
  constraint delivery_jobs_provider_start_has_first
    check (
      provider_call_started_at is null
      or first_provider_call_started_at is not null
    ),
  constraint delivery_jobs_error_category_length
    check (last_error_category is null or char_length(last_error_category) <= 64),
  constraint delivery_jobs_error_code_length
    check (last_error_code is null or char_length(last_error_code) <= 128)
);

create index delivery_jobs_due_idx
  on public.delivery_jobs (next_attempt_at, created_at)
  where status in ('pending', 'processing');

alter table public.delivery_jobs enable row level security;

revoke all privileges on public.delivery_jobs from public, anon, authenticated;
grant select, insert, update, delete on public.delivery_jobs to service_role;

comment on table public.delivery_jobs is
  'Service-role-only queue metadata. Customer contact details and message bodies remain on the related survey or in application configuration.';

comment on column public.delivery_jobs.attempt_count is
  'Number of processing attempts started, capped at six. Provider-start and pre-provider failures each count once.';

comment on column public.delivery_jobs.provider_call_started_at is
  'Set immediately before a provider call. An expired SMS lease after this point is terminally unknown to prevent duplicate texts.';

comment on column public.delivery_jobs.first_provider_call_started_at is
  'Immutable first provider-call time used to keep Resend retries inside its 24-hour idempotency window.';

create function public.preserve_delivery_job_first_provider_call()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.first_provider_call_started_at is not null
    and new.first_provider_call_started_at is distinct from old.first_provider_call_started_at then
    raise exception using
      errcode = '23000',
      message = 'first provider call time is immutable';
  end if;

  return new;
end;
$$;

create trigger delivery_jobs_preserve_first_provider_call
before update of first_provider_call_started_at on public.delivery_jobs
for each row
execute function public.preserve_delivery_job_first_provider_call();

revoke all on function public.preserve_delivery_job_first_provider_call()
  from public, anon, authenticated;

create function public.create_survey_with_sms_job(
  p_order_id text,
  p_location_id text,
  p_customer_phone text,
  p_customer_name text,
  p_services jsonb,
  p_scheduled_at timestamptz
)
returns table (
  created boolean,
  survey_id uuid,
  survey_token uuid,
  delivery_job_id uuid
)
language plpgsql
set search_path = ''
as $$
declare
  v_survey_id uuid;
  v_survey_token uuid;
  v_job_id uuid;
begin
  if p_order_id is null or btrim(p_order_id) = ''
    or p_location_id is null or btrim(p_location_id) = ''
    or p_customer_phone is null or btrim(p_customer_phone) = ''
    or p_scheduled_at is null then
    raise exception using
      errcode = '22023',
      message = 'survey delivery inputs are invalid';
  end if;

  insert into public.surveys (
    order_id,
    location_id,
    customer_phone,
    customer_name,
    services
  ) values (
    p_order_id,
    p_location_id,
    p_customer_phone,
    nullif(btrim(p_customer_name), ''),
    coalesce(p_services, '[]'::jsonb)
  )
  on conflict (order_id) do nothing
  returning id, surveys.survey_token
  into v_survey_id, v_survey_token;

  if v_survey_id is null then
    return query
      select false, null::uuid, null::uuid, null::uuid;
    return;
  end if;

  insert into public.delivery_jobs (
    survey_id,
    kind,
    scheduled_at,
    next_attempt_at
  ) values (
    v_survey_id,
    'survey_sms',
    p_scheduled_at,
    p_scheduled_at
  )
  returning id into v_job_id;

  return query
    select true, v_survey_id, v_survey_token, v_job_id;
end;
$$;

create function public.complete_questionnaire_with_email_job(
  p_survey_id uuid,
  p_private_rating_maximum smallint,
  p_wait_time_score smallint,
  p_service_speed_score smallint,
  p_vehicle_cleanliness_score smallint,
  p_additional_services_experience_score smallint,
  p_value_score smallint,
  p_team_friendliness_score smallint,
  p_questionnaire_version smallint,
  p_comment text,
  p_completed_at timestamptz
)
returns table (
  outcome text,
  survey_id uuid,
  order_id text,
  rating integer,
  location_id text,
  delivery_job_id uuid
)
language plpgsql
set search_path = ''
as $$
declare
  v_survey public.surveys%rowtype;
  v_job_id uuid;
begin
  if p_survey_id is null
    or p_private_rating_maximum is null
    or p_private_rating_maximum not between 0 and 4
    or p_questionnaire_version is null
    or p_completed_at is null
    or char_length(btrim(coalesce(p_comment, ''))) > 2000 then
    raise exception using
      errcode = '22023',
      message = 'questionnaire delivery inputs are invalid';
  end if;

  select survey.*
  into v_survey
  from public.surveys as survey
  where survey.id = p_survey_id
  for update;

  if not found then
    return query
      select 'not_found'::text, null::uuid, null::text, null::integer, null::text, null::uuid;
    return;
  end if;

  if v_survey.questionnaire_submitted_at is not null then
    return query
      select
        'already_completed'::text,
        v_survey.id,
        v_survey.order_id,
        v_survey.rating,
        v_survey.location_id,
        (
          select job.id
          from public.delivery_jobs as job
          where job.survey_id = v_survey.id
            and job.kind = 'private_feedback_email'
        );
    return;
  end if;

  if v_survey.rating is null then
    return query
      select 'rating_missing'::text, v_survey.id, v_survey.order_id, null::integer, v_survey.location_id, null::uuid;
    return;
  end if;

  if v_survey.rating > p_private_rating_maximum then
    return query
      select 'not_private'::text, v_survey.id, v_survey.order_id, v_survey.rating, v_survey.location_id, null::uuid;
    return;
  end if;

  update public.surveys as survey
  set
    wait_time_score = p_wait_time_score,
    service_speed_score = p_service_speed_score,
    vehicle_cleanliness_score = p_vehicle_cleanliness_score,
    additional_services_experience_score = p_additional_services_experience_score,
    value_score = p_value_score,
    team_friendliness_score = p_team_friendliness_score,
    questionnaire_version = p_questionnaire_version,
    questionnaire_submitted_at = p_completed_at,
    comment = nullif(btrim(p_comment), '')
  where survey.id = v_survey.id;

  insert into public.delivery_jobs (
    survey_id,
    kind,
    scheduled_at,
    next_attempt_at
  ) values (
    v_survey.id,
    'private_feedback_email',
    p_completed_at,
    p_completed_at
  )
  on conflict on constraint delivery_jobs_survey_kind_key do nothing
  returning id into v_job_id;

  if v_job_id is null then
    select job.id
    into v_job_id
    from public.delivery_jobs as job
    where job.survey_id = v_survey.id
      and job.kind = 'private_feedback_email';
  end if;

  return query
    select
      'completed'::text,
      v_survey.id,
      v_survey.order_id,
      v_survey.rating,
      v_survey.location_id,
      v_job_id;
end;
$$;

create function public.claim_delivery_jobs(
  p_run_id uuid,
  p_limit integer,
  p_lease_seconds integer,
  p_now timestamptz
)
returns table (
  id uuid,
  survey_id uuid,
  kind public.delivery_job_kind,
  status public.delivery_job_status,
  scheduled_at timestamptz,
  next_attempt_at timestamptz,
  attempt_count smallint,
  lease_token uuid,
  lease_expires_at timestamptz
)
language plpgsql
set search_path = ''
as $$
begin
  if p_run_id is null or p_now is null
    or p_limit is null or p_limit not between 1 and 100
    or p_lease_seconds is null or p_lease_seconds not between 1 and 3600 then
    raise exception using
      errcode = '22023',
      message = 'delivery claim inputs are invalid';
  end if;

  -- A text provider might have accepted a request after provider-start. Never
  -- reclaim that SMS because doing so could send a duplicate customer text.
  update public.delivery_jobs as job
  set
    status = 'unknown',
    claimed_by_run_id = null,
    lease_token = null,
    lease_expires_at = null,
    last_error_category = 'uncertain_provider_outcome',
    last_error_code = 'lease_expired_after_provider_call',
    updated_at = p_now
  where job.status = 'processing'
    and job.kind = 'survey_sms'
    and job.lease_expires_at <= p_now
    and job.provider_call_started_at is not null;

  -- A worker that disappears before recording a provider call still consumed a
  -- processing attempt. Count the expired lease before safely reclaiming it so
  -- repeated pre-provider crashes cannot loop forever.
  update public.delivery_jobs as job
  set
    status = case when job.attempt_count + 1 >= 6 then 'dead'::public.delivery_job_status else 'pending'::public.delivery_job_status end,
    attempt_count = (job.attempt_count + 1)::smallint,
    next_attempt_at = p_now,
    claimed_by_run_id = null,
    lease_token = null,
    lease_expires_at = null,
    last_error_category = 'worker_lease_expired',
    last_error_code = case when job.attempt_count + 1 >= 6 then 'attempts_exhausted' else 'safe_pre_provider_retry' end,
    updated_at = p_now
  where job.status = 'processing'
    and job.lease_expires_at <= p_now
    and job.provider_call_started_at is null;

  -- Resend receives a stable idempotency key, so an expired post-call lease is
  -- safe to retry until the six-attempt limit is reached.
  update public.delivery_jobs as job
  set
    status = case
      when job.attempt_count >= 6
        or p_now >= job.first_provider_call_started_at + interval '24 hours'
        then 'dead'::public.delivery_job_status
      else 'pending'::public.delivery_job_status
    end,
    next_attempt_at = p_now,
    claimed_by_run_id = null,
    lease_token = null,
    lease_expires_at = null,
    provider_call_started_at = null,
    last_error_category = case
      when p_now >= job.first_provider_call_started_at + interval '24 hours'
        then 'idempotency_safety'
      else 'uncertain_provider_outcome'
    end,
    last_error_code = case
      when p_now >= job.first_provider_call_started_at + interval '24 hours'
        then 'idempotency_window_expired'
      when job.attempt_count >= 6 then 'attempts_exhausted'
      else 'retry_with_idempotency_key'
    end,
    updated_at = p_now
  where job.status = 'processing'
    and job.kind = 'private_feedback_email'
    and job.lease_expires_at <= p_now
    and job.provider_call_started_at is not null;

  -- A delayed cron run must never retry an email after Resend's idempotency
  -- guarantee has expired, even when the nominal retry gaps fit within a day.
  update public.delivery_jobs as job
  set
    status = 'dead',
    last_error_category = 'idempotency_safety',
    last_error_code = 'idempotency_window_expired',
    updated_at = p_now
  where job.status = 'pending'
    and job.kind = 'private_feedback_email'
    and job.first_provider_call_started_at is not null
    and p_now >= job.first_provider_call_started_at + interval '24 hours';

  update public.delivery_jobs as job
  set
    status = 'dead',
    last_error_category = 'retry_exhausted',
    last_error_code = 'attempts_exhausted',
    updated_at = p_now
  where job.status = 'pending'
    and job.attempt_count >= 6;

  return query
  with candidates as (
    select job.id
    from public.delivery_jobs as job
    where job.status = 'pending'
      and job.next_attempt_at <= p_now
      and job.attempt_count < 6
    order by job.next_attempt_at, job.created_at, job.id
    for update skip locked
    limit p_limit
  ), claimed as (
    update public.delivery_jobs as job
    set
      status = 'processing',
      claimed_by_run_id = p_run_id,
      lease_token = gen_random_uuid(),
      lease_expires_at = p_now + make_interval(secs => p_lease_seconds),
      provider_call_started_at = null,
      updated_at = p_now
    from candidates
    where job.id = candidates.id
    returning job.*
  )
  select
    claimed.id,
    claimed.survey_id,
    claimed.kind,
    claimed.status,
    claimed.scheduled_at,
    claimed.next_attempt_at,
    claimed.attempt_count,
    claimed.lease_token,
    claimed.lease_expires_at
  from claimed
  order by claimed.next_attempt_at, claimed.created_at, claimed.id;
end;
$$;

create function public.mark_delivery_job_provider_started(
  p_job_id uuid,
  p_lease_token uuid,
  p_started_at timestamptz
)
returns table (
  started boolean,
  attempt_count smallint
)
language plpgsql
set search_path = ''
as $$
declare
  v_attempt_count smallint;
  v_expired_id uuid;
begin
  if p_started_at is null then
    return query select false, null::smallint;
    return;
  end if;

  update public.delivery_jobs as job
  set
    status = 'dead',
    claimed_by_run_id = null,
    lease_token = null,
    lease_expires_at = null,
    provider_call_started_at = null,
    last_error_category = 'idempotency_safety',
    last_error_code = 'idempotency_window_expired',
    updated_at = p_started_at
  where job.id = p_job_id
    and job.kind = 'private_feedback_email'
    and job.status = 'processing'
    and job.lease_token = p_lease_token
    and job.first_provider_call_started_at is not null
    and p_started_at >= job.first_provider_call_started_at + interval '24 hours'
  returning job.id into v_expired_id;

  if v_expired_id is not null then
    return query select false, null::smallint;
    return;
  end if;

  update public.delivery_jobs as job
  set
    attempt_count = (job.attempt_count + 1)::smallint,
    first_provider_call_started_at = coalesce(job.first_provider_call_started_at, p_started_at),
    provider_call_started_at = p_started_at,
    updated_at = p_started_at
  where job.id = p_job_id
    and job.status = 'processing'
    and job.lease_token = p_lease_token
    and job.provider_call_started_at is null
    and job.attempt_count < 6
  returning job.attempt_count into v_attempt_count;

  if v_attempt_count is null then
    return query select false, null::smallint;
  else
    return query select true, v_attempt_count;
  end if;
end;
$$;

create function public.mark_delivery_job_sent(
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
begin
  update public.delivery_jobs as job
  set
    status = 'sent',
    provider_message_id = nullif(btrim(p_provider_message_id), ''),
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
  returning job.survey_id, job.kind into v_survey_id, v_kind;

  if v_survey_id is null then
    return false;
  end if;

  if v_kind = 'survey_sms' then
    update public.surveys as survey
    set sent_at = p_accepted_at
    where survey.id = v_survey_id;
  end if;

  return true;
end;
$$;

create function public.mark_delivery_job_retry(
  p_job_id uuid,
  p_lease_token uuid,
  p_error_category text,
  p_error_code text,
  p_failed_at timestamptz
)
returns table (
  status public.delivery_job_status,
  next_attempt_at timestamptz,
  attempt_count smallint
)
language plpgsql
set search_path = ''
as $$
declare
  v_job public.delivery_jobs%rowtype;
  v_attempt smallint;
  v_delay_minutes integer;
  v_status public.delivery_job_status;
  v_next_attempt_at timestamptz;
  v_idempotency_expired boolean := false;
begin
  select job.*
  into v_job
  from public.delivery_jobs as job
  where job.id = p_job_id
    and job.status = 'processing'
    and job.lease_token = p_lease_token
  for update;

  if not found then
    return;
  end if;

  v_attempt := v_job.attempt_count;
  if v_job.provider_call_started_at is null then
    v_attempt := (v_attempt + 1)::smallint;
  end if;

  if v_attempt >= 6 then
    v_status := 'dead';
    v_next_attempt_at := v_job.next_attempt_at;
  else
    v_status := 'pending';
    v_delay_minutes := case v_attempt
      when 1 then 5
      when 2 then 15
      when 3 then 60
      when 4 then 240
      when 5 then 720
    end;
    v_next_attempt_at := p_failed_at + make_interval(mins => v_delay_minutes);

    if v_job.kind = 'private_feedback_email'
      and v_job.first_provider_call_started_at is not null
      and v_next_attempt_at >= v_job.first_provider_call_started_at + interval '24 hours' then
      v_idempotency_expired := true;
      v_status := 'dead';
      v_next_attempt_at := v_job.next_attempt_at;
    end if;
  end if;

  if v_job.kind = 'private_feedback_email'
    and v_job.first_provider_call_started_at is not null
    and p_failed_at >= v_job.first_provider_call_started_at + interval '24 hours' then
    v_idempotency_expired := true;
    v_status := 'dead';
    v_next_attempt_at := v_job.next_attempt_at;
  end if;

  update public.delivery_jobs as job
  set
    status = v_status,
    attempt_count = v_attempt,
    next_attempt_at = v_next_attempt_at,
    claimed_by_run_id = null,
    lease_token = null,
    lease_expires_at = null,
    provider_call_started_at = null,
    last_error_category = case
      when v_idempotency_expired then 'idempotency_safety'
      else left(coalesce(nullif(btrim(p_error_category), ''), 'unspecified'), 64)
    end,
    last_error_code = case
      when v_idempotency_expired then 'idempotency_window_expired'
      else left(coalesce(nullif(btrim(p_error_code), ''), 'unspecified'), 128)
    end,
    updated_at = p_failed_at
  where job.id = v_job.id;

  return query select v_status, v_next_attempt_at, v_attempt;
end;
$$;

create function public.mark_delivery_job_dead(
  p_job_id uuid,
  p_lease_token uuid,
  p_error_category text,
  p_error_code text,
  p_failed_at timestamptz
)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_updated_id uuid;
begin
  update public.delivery_jobs as job
  set
    status = 'dead',
    attempt_count = case
      when job.provider_call_started_at is null and job.attempt_count < 6
        then (job.attempt_count + 1)::smallint
      else job.attempt_count
    end,
    claimed_by_run_id = null,
    lease_token = null,
    lease_expires_at = null,
    provider_call_started_at = null,
    last_error_category = left(coalesce(nullif(btrim(p_error_category), ''), 'unspecified'), 64),
    last_error_code = left(coalesce(nullif(btrim(p_error_code), ''), 'unspecified'), 128),
    updated_at = p_failed_at
  where job.id = p_job_id
    and job.status = 'processing'
    and job.lease_token = p_lease_token
  returning job.id into v_updated_id;

  return v_updated_id is not null;
end;
$$;

create function public.mark_delivery_job_unknown(
  p_job_id uuid,
  p_lease_token uuid,
  p_error_category text,
  p_error_code text,
  p_failed_at timestamptz
)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_updated_id uuid;
begin
  update public.delivery_jobs as job
  set
    status = 'unknown',
    claimed_by_run_id = null,
    lease_token = null,
    lease_expires_at = null,
    last_error_category = left(coalesce(nullif(btrim(p_error_category), ''), 'unspecified'), 64),
    last_error_code = left(coalesce(nullif(btrim(p_error_code), ''), 'unspecified'), 128),
    updated_at = p_failed_at
  where job.id = p_job_id
    and job.kind = 'survey_sms'
    and job.status = 'processing'
    and job.lease_token = p_lease_token
    and job.provider_call_started_at is not null
  returning job.id into v_updated_id;

  return v_updated_id is not null;
end;
$$;

revoke all on function public.create_survey_with_sms_job(text, text, text, text, jsonb, timestamptz)
  from public, anon, authenticated;
revoke all on function public.complete_questionnaire_with_email_job(uuid, smallint, smallint, smallint, smallint, smallint, smallint, smallint, smallint, text, timestamptz)
  from public, anon, authenticated;
revoke all on function public.claim_delivery_jobs(uuid, integer, integer, timestamptz)
  from public, anon, authenticated;
revoke all on function public.mark_delivery_job_provider_started(uuid, uuid, timestamptz)
  from public, anon, authenticated;
revoke all on function public.mark_delivery_job_sent(uuid, uuid, text, timestamptz)
  from public, anon, authenticated;
revoke all on function public.mark_delivery_job_retry(uuid, uuid, text, text, timestamptz)
  from public, anon, authenticated;
revoke all on function public.mark_delivery_job_dead(uuid, uuid, text, text, timestamptz)
  from public, anon, authenticated;
revoke all on function public.mark_delivery_job_unknown(uuid, uuid, text, text, timestamptz)
  from public, anon, authenticated;

grant execute on function public.create_survey_with_sms_job(text, text, text, text, jsonb, timestamptz)
  to service_role;
grant execute on function public.complete_questionnaire_with_email_job(uuid, smallint, smallint, smallint, smallint, smallint, smallint, smallint, smallint, text, timestamptz)
  to service_role;
grant execute on function public.claim_delivery_jobs(uuid, integer, integer, timestamptz)
  to service_role;
grant execute on function public.mark_delivery_job_provider_started(uuid, uuid, timestamptz)
  to service_role;
grant execute on function public.mark_delivery_job_sent(uuid, uuid, text, timestamptz)
  to service_role;
grant execute on function public.mark_delivery_job_retry(uuid, uuid, text, text, timestamptz)
  to service_role;
grant execute on function public.mark_delivery_job_dead(uuid, uuid, text, text, timestamptz)
  to service_role;
grant execute on function public.mark_delivery_job_unknown(uuid, uuid, text, text, timestamptz)
  to service_role;
