begin;

create schema if not exists extensions;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select no_plan();

select has_table('public', 'delivery_jobs', 'durable delivery-job table exists');
select has_column('public', 'delivery_jobs', 'survey_id', 'delivery jobs reference their survey');
select has_column('public', 'delivery_jobs', 'kind', 'delivery jobs store their channel kind');
select has_column('public', 'delivery_jobs', 'status', 'delivery jobs store lifecycle status');
select has_column('public', 'delivery_jobs', 'scheduled_at', 'delivery jobs retain original schedule time');
select has_column('public', 'delivery_jobs', 'next_attempt_at', 'delivery jobs retain next-attempt time');
select has_column('public', 'delivery_jobs', 'attempt_count', 'delivery jobs count attempts');
select has_column('public', 'delivery_jobs', 'lease_token', 'delivery jobs use lease tokens');
select has_column('public', 'delivery_jobs', 'first_provider_call_started_at', 'delivery jobs retain the first provider-call time');
select has_column('public', 'delivery_jobs', 'provider_call_started_at', 'delivery jobs mark provider-call start');
select has_column('public', 'delivery_jobs', 'provider_message_id', 'delivery jobs retain provider acceptance identifiers');
select has_column('public', 'delivery_jobs', 'accepted_at', 'delivery jobs retain provider acceptance time');
select has_column('public', 'delivery_jobs', 'last_error_category', 'delivery jobs retain sanitized error categories');
select has_column('public', 'delivery_jobs', 'last_error_code', 'delivery jobs retain sanitized error codes');

select enum_has_labels(
  'public',
  'delivery_job_kind',
  array['survey_sms', 'private_feedback_email'],
  'delivery-job kinds are intentionally limited'
);

select enum_has_labels(
  'public',
  'delivery_job_status',
  array['pending', 'processing', 'sent', 'dead', 'unknown'],
  'delivery-job lifecycle statuses are intentionally limited'
);

select is(
  (
    select relrowsecurity
    from pg_catalog.pg_class
    where oid = 'public.delivery_jobs'::regclass
  ),
  true,
  'RLS is enabled on delivery jobs'
);

select is(
  (
    select count(*)::integer
    from pg_catalog.pg_policies
    where schemaname = 'public' and tablename = 'delivery_jobs'
  ),
  0,
  'delivery jobs expose no client-facing RLS policies'
);

select is(
  (
    select count(*)::integer
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'delivery_jobs'
      and column_name ~ '(phone|customer|message_body|body|answer|comment)'
  ),
  0,
  'delivery jobs duplicate no customer contact, answer, comment, or message-body fields'
);

select is(
  (select count(*) from public.delivery_jobs),
  0::bigint,
  'fictional seed surveys do not receive historical delivery jobs'
);

create temporary table created_sms as
select *
from public.create_survey_with_sms_job(
  'FAKE-QUEUE-ORDER-001',
  'FAKE-LOC-001',
  '+13175550201',
  'Fake Queue Customer',
  '[{"name":"Fake Oil Change"}]'::jsonb,
  '2099-01-01T12:00:00Z'::timestamptz
);

select is((select created from created_sms), true, 'survey and SMS job are created atomically');
select ok((select survey_id is not null from created_sms), 'atomic create returns the survey id');
select ok((select survey_token is not null from created_sms), 'atomic create returns the private survey token');
select ok((select delivery_job_id is not null from created_sms), 'atomic create returns the SMS job id');

select is(
  (
    select row(job.kind, job.status, job.scheduled_at, job.next_attempt_at, job.attempt_count)
    from public.delivery_jobs as job
    where job.id = (select delivery_job_id from created_sms)
  ),
  row(
    'survey_sms'::public.delivery_job_kind,
    'pending'::public.delivery_job_status,
    '2099-01-01T12:00:00Z'::timestamptz,
    '2099-01-01T12:00:00Z'::timestamptz,
    0::smallint
  ),
  'new SMS jobs are pending and eligible at their original schedule time'
);

create temporary table duplicate_sms as
select *
from public.create_survey_with_sms_job(
  'FAKE-QUEUE-ORDER-001',
  'DIFFERENT-LOCATION-MUST-NOT-WIN',
  '+13175550999',
  'Different Fake Customer',
  '[{"name":"Fake Oil Change"}]'::jsonb,
  '2099-01-02T12:00:00Z'::timestamptz
);

select is((select created from duplicate_sms), false, 'a duplicate order returns a safe duplicate outcome');
select ok(
  (
    select survey_id is null and survey_token is null and delivery_job_id is null
    from duplicate_sms
  ),
  'a duplicate order exposes no newly created identifiers'
);
select is(
  (select count(*) from public.surveys where order_id = 'FAKE-QUEUE-ORDER-001'),
  1::bigint,
  'duplicate order processing preserves one survey'
);
select is(
  (
    select count(*)
    from public.delivery_jobs as job
    join public.surveys as survey on survey.id = job.survey_id
    where survey.order_id = 'FAKE-QUEUE-ORDER-001' and job.kind = 'survey_sms'
  ),
  1::bigint,
  'duplicate order processing preserves one SMS job'
);

insert into public.surveys (
  id,
  order_id,
  location_id,
  customer_phone,
  customer_name,
  services,
  rating,
  responded_at
)
values (
  '10000000-0000-4000-8000-000000000001',
  'FAKE-QUESTIONNAIRE-QUEUE-001',
  'FAKE-LOC-001',
  '+13175550202',
  'Fake Private Feedback Customer',
  '[{"name":"Fake Oil Change"}]'::jsonb,
  2,
  '2099-01-02T12:00:00Z'
);

create temporary table completed_questionnaire as
select *
from public.complete_questionnaire_with_email_job(
  '10000000-0000-4000-8000-000000000001',
  3::smallint,
  1::smallint,
  2::smallint,
  3::smallint,
  4::smallint,
  5::smallint,
  4::smallint,
  1::smallint,
  'Fictional private feedback.',
  '2099-01-02T12:05:00Z'::timestamptz
);

select is((select outcome from completed_questionnaire), 'completed', 'first questionnaire completion succeeds');
select ok((select delivery_job_id is not null from completed_questionnaire), 'questionnaire completion returns its email job');
select is(
  (
    select row(
      wait_time_score,
      service_speed_score,
      vehicle_cleanliness_score,
      additional_services_experience_score,
      value_score,
      team_friendliness_score,
      questionnaire_version,
      questionnaire_submitted_at,
      comment
    )
    from public.surveys
    where id = '10000000-0000-4000-8000-000000000001'
  ),
  row(
    1::smallint,
    2::smallint,
    3::smallint,
    4::smallint,
    5::smallint,
    4::smallint,
    1::smallint,
    '2099-01-02T12:05:00Z'::timestamptz,
    'Fictional private feedback.'::text
  ),
  'questionnaire answers and server completion time are stored together'
);
select is(
  (
    select count(*)
    from public.delivery_jobs
    where survey_id = '10000000-0000-4000-8000-000000000001'
      and kind = 'private_feedback_email'
  ),
  1::bigint,
  'questionnaire completion atomically creates one email job'
);

create temporary table duplicate_questionnaire as
select *
from public.complete_questionnaire_with_email_job(
  '10000000-0000-4000-8000-000000000001',
  3::smallint,
  5::smallint,
  5::smallint,
  5::smallint,
  5::smallint,
  5::smallint,
  5::smallint,
  1::smallint,
  'This duplicate must not overwrite the first response.',
  '2099-01-02T12:06:00Z'::timestamptz
);

select is(
  (select outcome from duplicate_questionnaire),
  'already_completed',
  'a repeated questionnaire is an idempotent success'
);
select is(
  (
    select row(wait_time_score, comment, questionnaire_submitted_at)
    from public.surveys
    where id = '10000000-0000-4000-8000-000000000001'
  ),
  row(1::smallint, 'Fictional private feedback.'::text, '2099-01-02T12:05:00Z'::timestamptz),
  'the first completed questionnaire remains authoritative'
);
select is(
  (
    select count(*)
    from public.delivery_jobs
    where survey_id = '10000000-0000-4000-8000-000000000001'
      and kind = 'private_feedback_email'
  ),
  1::bigint,
  'repeated questionnaire submissions never duplicate email jobs'
);

insert into public.surveys (id, order_id, location_id, rating)
values
  ('10000000-0000-4000-8000-000000000002', 'FAKE-THRESHOLD-ZERO-ORDER', 'FAKE-LOC-001', 1),
  ('10000000-0000-4000-8000-000000000003', 'FAKE-MISSING-RATING-ORDER', 'FAKE-LOC-001', null);

select is(
  (
    select outcome
    from public.complete_questionnaire_with_email_job(
      '10000000-0000-4000-8000-000000000002',
      0::smallint,
      1::smallint, 1::smallint, 1::smallint, 1::smallint, 1::smallint, 1::smallint,
      1::smallint,
      null::text,
      '2099-01-03T12:00:00Z'::timestamptz
    )
  ),
  'not_private',
  'a Google threshold of one is reversible and sends every rating away from the private questionnaire'
);

select is(
  (
    select outcome
    from public.complete_questionnaire_with_email_job(
      '10000000-0000-4000-8000-000000000003',
      3::smallint,
      1::smallint, 1::smallint, 1::smallint, 1::smallint, 1::smallint, 1::smallint,
      1::smallint,
      null::text,
      '2099-01-03T12:00:00Z'::timestamptz
    )
  ),
  'rating_missing',
  'questionnaire completion requires a stored overall rating'
);

select is(
  (
    select outcome
    from public.complete_questionnaire_with_email_job(
      'ffffffff-ffff-4fff-8fff-ffffffffffff',
      3::smallint,
      1::smallint, 1::smallint, 1::smallint, 1::smallint, 1::smallint, 1::smallint,
      1::smallint,
      null::text,
      '2099-01-03T12:00:00Z'::timestamptz
    )
  ),
  'not_found',
  'questionnaire completion reports an unknown survey without writing work'
);

select throws_like(
  $sql$
    select *
    from public.complete_questionnaire_with_email_job(
      '10000000-0000-4000-8000-000000000002',
      5::smallint,
      1::smallint, 1::smallint, 1::smallint, 1::smallint, 1::smallint, 1::smallint,
      1::smallint,
      null::text,
      '2099-01-03T12:00:00Z'::timestamptz
    )
  $sql$,
  '%questionnaire delivery inputs are invalid%',
  'out-of-range private thresholds are rejected'
);

insert into public.surveys (id, order_id, location_id)
values ('20000000-0000-4000-8000-000000000001', 'FAKE-DUE-SMS-ORDER', 'FAKE-LOC-001');
insert into public.delivery_jobs (id, survey_id, kind, scheduled_at, next_attempt_at)
values (
  '30000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000001',
  'survey_sms',
  '2026-02-01T12:00:00Z',
  '2026-02-01T12:00:00Z'
);

select throws_like(
  $sql$
    select *
    from public.claim_delivery_jobs(
      '40000000-0000-4000-8000-000000000099',
      null,
      600,
      '2026-02-01T12:00:00Z'
    )
  $sql$,
  '%delivery claim inputs are invalid%',
  'a null claim limit is rejected instead of becoming unlimited'
);

select throws_like(
  $sql$
    select *
    from public.claim_delivery_jobs(
      '40000000-0000-4000-8000-000000000099',
      20,
      null,
      '2026-02-01T12:00:00Z'
    )
  $sql$,
  '%delivery claim inputs are invalid%',
  'a null lease duration is rejected'
);

create temporary table first_claim as
select *
from public.claim_delivery_jobs(
  '40000000-0000-4000-8000-000000000001',
  20,
  600,
  '2026-02-01T12:00:00Z'
);

select is((select count(*) from first_claim), 1::bigint, 'a due job is claimed once');
select is((select id from first_claim), '30000000-0000-4000-8000-000000000001'::uuid, 'the due job is selected');
select is((select status from first_claim), 'processing'::public.delivery_job_status, 'claimed jobs become processing');
select is((select attempt_count from first_claim), 0::smallint, 'claiming alone does not count a provider attempt');
select ok(
  (
    select lease_token is not null
      and lease_expires_at = '2026-02-01T12:10:00Z'::timestamptz
    from first_claim
  ),
  'claiming assigns a unique ten-minute lease'
);

select is(
  (
    select count(*)
    from public.claim_delivery_jobs(
      '40000000-0000-4000-8000-000000000002',
      20,
      600,
      '2026-02-01T12:01:00Z'
    )
  ),
  0::bigint,
  'an active lease prevents a concurrent run from double-claiming the job'
);

select is(
  (
    select started
    from public.mark_delivery_job_provider_started(
      '30000000-0000-4000-8000-000000000001',
      'ffffffff-ffff-4fff-8fff-ffffffffffff',
      '2026-02-01T12:02:00Z'
    )
  ),
  false,
  'an incorrect lease token cannot start a provider call'
);

select is(
  (
    select attempt_count
    from public.mark_delivery_job_provider_started(
      '30000000-0000-4000-8000-000000000001',
      (select lease_token from first_claim),
      '2026-02-01T12:02:00Z'
    )
  ),
  1::smallint,
  'provider-start atomically increments the attempt count'
);

select is(
  public.mark_delivery_job_sent(
    '30000000-0000-4000-8000-000000000001',
    (select lease_token from first_claim),
    'FAKE-TWILIO-SID-001',
    '2026-02-01T12:02:05Z'
  ),
  true,
  'provider acceptance completes the leased SMS job'
);

select is(
  (
    select row(status, provider_message_id, accepted_at, lease_token)
    from public.delivery_jobs
    where id = '30000000-0000-4000-8000-000000000001'
  ),
  row(
    'sent'::public.delivery_job_status,
    'FAKE-TWILIO-SID-001'::text,
    '2026-02-01T12:02:05Z'::timestamptz,
    null::uuid
  ),
  'sent jobs retain provider acceptance but release their lease'
);

select is(
  (select sent_at from public.surveys where id = '20000000-0000-4000-8000-000000000001'),
  '2026-02-01T12:02:05Z'::timestamptz,
  'SMS provider acceptance updates the compatible surveys.sent_at field'
);

insert into public.surveys (id, order_id, location_id)
values ('20000000-0000-4000-8000-000000000005', 'FAKE-STALE-PRE-CALL-ORDER', 'FAKE-LOC-001');
insert into public.delivery_jobs (id, survey_id, kind, scheduled_at, next_attempt_at)
values (
  '30000000-0000-4000-8000-000000000005',
  '20000000-0000-4000-8000-000000000005',
  'survey_sms',
  '2026-02-15T12:00:00Z',
  '2026-02-15T12:00:00Z'
);

create temporary table stale_pre_call_first_claim as
select *
from public.claim_delivery_jobs(
  '40000000-0000-4000-8000-000000000010', 20, 600, '2026-02-15T12:00:00Z'
);

create temporary table stale_pre_call_second_claim as
select *
from public.claim_delivery_jobs(
  '40000000-0000-4000-8000-000000000011', 20, 600, '2026-02-15T12:10:01Z'
);

select is(
  (
    select attempt_count
    from stale_pre_call_second_claim
    where id = '30000000-0000-4000-8000-000000000005'
  ),
  1::smallint,
  'an expired pre-provider lease counts the disappeared worker attempt before safe reclaim'
);

select isnt(
  (
    select lease_token
    from stale_pre_call_first_claim
    where id = '30000000-0000-4000-8000-000000000005'
  ),
  (
    select lease_token
    from stale_pre_call_second_claim
    where id = '30000000-0000-4000-8000-000000000005'
  ),
  'a safely reclaimed pre-provider job receives a new lease token'
);

select is(
  (
    select started
    from public.mark_delivery_job_provider_started(
      '30000000-0000-4000-8000-000000000005',
      (select lease_token from stale_pre_call_second_claim where id = '30000000-0000-4000-8000-000000000005'),
      null::timestamptz
    )
  ),
  false,
  'provider-start rejects a missing timestamp without weakening uncertain-outcome fencing'
);

select is(
  public.mark_delivery_job_dead(
    '30000000-0000-4000-8000-000000000005',
    (select lease_token from stale_pre_call_second_claim where id = '30000000-0000-4000-8000-000000000005'),
    'test_cleanup',
    'deterministic_failure',
    '2026-02-15T12:11:00Z'
  ),
  true,
  'the safely reclaimed test job can be terminally released'
);

insert into public.surveys (id, order_id, location_id)
values ('20000000-0000-4000-8000-000000000002', 'FAKE-STALE-SMS-ORDER', 'FAKE-LOC-001');
insert into public.delivery_jobs (id, survey_id, kind, scheduled_at, next_attempt_at)
values (
  '30000000-0000-4000-8000-000000000002',
  '20000000-0000-4000-8000-000000000002',
  'survey_sms',
  '2026-03-01T12:00:00Z',
  '2026-03-01T12:00:00Z'
);

create temporary table stale_sms_claim as
select *
from public.claim_delivery_jobs(
  '40000000-0000-4000-8000-000000000003', 20, 600, '2026-03-01T12:00:00Z'
);

select is(
  (
    select attempt_count
    from public.mark_delivery_job_provider_started(
      '30000000-0000-4000-8000-000000000002',
      (select lease_token from stale_sms_claim where id = '30000000-0000-4000-8000-000000000002'),
      '2026-03-01T12:01:00Z'
    )
  ),
  1::smallint,
  'stale-outcome test marks the SMS provider call started'
);

select is(
  (
    select count(*)
    from public.claim_delivery_jobs(
      '40000000-0000-4000-8000-000000000004', 20, 600, '2026-03-01T12:10:01Z'
    )
    where id = '30000000-0000-4000-8000-000000000002'
  ),
  0::bigint,
  'an expired post-call SMS lease is never reclaimed'
);

select is(
  (select status from public.delivery_jobs where id = '30000000-0000-4000-8000-000000000002'),
  'unknown'::public.delivery_job_status,
  'an expired post-call SMS lease becomes unknown to prevent a duplicate text'
);

insert into public.surveys (id, order_id, location_id, rating)
values ('20000000-0000-4000-8000-000000000003', 'FAKE-STALE-EMAIL-ORDER', 'FAKE-LOC-001', 2);
insert into public.delivery_jobs (id, survey_id, kind, scheduled_at, next_attempt_at)
values (
  '30000000-0000-4000-8000-000000000003',
  '20000000-0000-4000-8000-000000000003',
  'private_feedback_email',
  '2026-04-01T12:00:00Z',
  '2026-04-01T12:00:00Z'
);

create temporary table stale_email_first_claim as
select *
from public.claim_delivery_jobs(
  '40000000-0000-4000-8000-000000000005', 20, 600, '2026-04-01T12:00:00Z'
);

select is(
  (
    select attempt_count
    from public.mark_delivery_job_provider_started(
      '30000000-0000-4000-8000-000000000003',
      (select lease_token from stale_email_first_claim where id = '30000000-0000-4000-8000-000000000003'),
      '2026-04-01T12:01:00Z'
    )
  ),
  1::smallint,
  'stale-outcome test marks the email provider call started'
);

create temporary table stale_email_second_claim as
select *
from public.claim_delivery_jobs(
  '40000000-0000-4000-8000-000000000006', 20, 600, '2026-04-01T12:10:01Z'
);

select is(
  (
    select id
    from stale_email_second_claim
    where id = '30000000-0000-4000-8000-000000000003'
  ),
  '30000000-0000-4000-8000-000000000003'::uuid,
  'an expired post-call email lease is safely reclaimed for its idempotent retry'
);
select isnt(
  (
    select lease_token
    from stale_email_first_claim
    where id = '30000000-0000-4000-8000-000000000003'
  ),
  (
    select lease_token
    from stale_email_second_claim
    where id = '30000000-0000-4000-8000-000000000003'
  ),
  'an email retry receives a fresh lease token'
);
select is(
  (select attempt_count from public.delivery_jobs where id = '30000000-0000-4000-8000-000000000003'),
  1::smallint,
  'reclaiming an uncertain idempotent email does not double-count provider-start'
);
select is(
  public.mark_delivery_job_dead(
    '30000000-0000-4000-8000-000000000003',
    (select lease_token from stale_email_second_claim where id = '30000000-0000-4000-8000-000000000003'),
    'invalid_payload',
    'missing_required_survey_data',
    '2026-04-01T12:11:00Z'
  ),
  true,
  'a deterministic pre-provider payload failure can be marked dead immediately'
);

insert into public.surveys (id, order_id, location_id, rating)
values ('20000000-0000-4000-8000-000000000006', 'FAKE-IDEMPOTENCY-OUTAGE-ORDER', 'FAKE-LOC-001', 2);
insert into public.delivery_jobs (id, survey_id, kind, scheduled_at, next_attempt_at)
values (
  '30000000-0000-4000-8000-000000000006',
  '20000000-0000-4000-8000-000000000006',
  'private_feedback_email',
  '2026-06-01T12:00:00Z',
  '2026-06-01T12:00:00Z'
);

create temporary table idempotency_outage_claim as
select *
from public.claim_delivery_jobs(
  '40000000-0000-4000-8000-000000000012', 20, 600, '2026-06-01T12:00:00Z'
);

select is(
  (
    select attempt_count
    from public.mark_delivery_job_provider_started(
      '30000000-0000-4000-8000-000000000006',
      (select lease_token from idempotency_outage_claim where id = '30000000-0000-4000-8000-000000000006'),
      '2026-06-01T12:00:00Z'
    )
  ),
  1::smallint,
  'the first email provider call starts the idempotency safety window'
);

select is(
  (
    select status
    from public.mark_delivery_job_retry(
      '30000000-0000-4000-8000-000000000006',
      (select lease_token from idempotency_outage_claim where id = '30000000-0000-4000-8000-000000000006'),
      'temporary_provider_failure',
      'fake_retryable_error',
      '2026-06-01T12:00:00Z'
    )
  ),
  'pending'::public.delivery_job_status,
  'an email retry inside the idempotency window remains pending'
);

select is(
  (
    select count(*)
    from public.claim_delivery_jobs(
      '40000000-0000-4000-8000-000000000013', 20, 600, '2026-06-02T12:00:00Z'
    )
    where id = '30000000-0000-4000-8000-000000000006'
  ),
  0::bigint,
  'a delayed cron run cannot claim an email at the 24-hour idempotency boundary'
);

select is(
  (
    select row(status, first_provider_call_started_at, last_error_code)
    from public.delivery_jobs
    where id = '30000000-0000-4000-8000-000000000006'
  ),
  row(
    'dead'::public.delivery_job_status,
    '2026-06-01T12:00:00Z'::timestamptz,
    'idempotency_window_expired'::text
  ),
  'cron-outage protection retains the immutable first call time and records a sanitized terminal reason'
);

select throws_like(
  $sql$
    update public.delivery_jobs
    set first_provider_call_started_at = '2026-06-01T12:01:00Z'
    where id = '30000000-0000-4000-8000-000000000006'
  $sql$,
  '%first provider call time is immutable%',
  'the first provider-call timestamp cannot be rewritten or extended'
);

insert into public.surveys (id, order_id, location_id, rating)
values ('20000000-0000-4000-8000-000000000007', 'FAKE-IDEMPOTENCY-SCHEDULE-ORDER', 'FAKE-LOC-001', 2);
insert into public.delivery_jobs (id, survey_id, kind, scheduled_at, next_attempt_at)
values (
  '30000000-0000-4000-8000-000000000007',
  '20000000-0000-4000-8000-000000000007',
  'private_feedback_email',
  '2026-07-01T00:00:00Z',
  '2026-07-01T00:00:00Z'
);

create temporary table idempotency_schedule_claim as
select *
from public.claim_delivery_jobs(
  '40000000-0000-4000-8000-000000000014', 20, 3600, '2026-07-01T00:00:00Z'
);

-- Claim leases are intentionally capped at an hour; extend this fictional
-- test lease directly so retry scheduling can be evaluated near hour 24.
update public.delivery_jobs
set lease_expires_at = '2026-07-02T00:00:00Z'
where id = '30000000-0000-4000-8000-000000000007';

select is(
  (
    select attempt_count
    from public.mark_delivery_job_provider_started(
      '30000000-0000-4000-8000-000000000007',
      (select lease_token from idempotency_schedule_claim where id = '30000000-0000-4000-8000-000000000007'),
      '2026-07-01T00:00:00Z'
    )
  ),
  1::smallint,
  'retry-schedule protection records the first email call'
);

select is(
  (
    select status
    from public.mark_delivery_job_retry(
      '30000000-0000-4000-8000-000000000007',
      (select lease_token from idempotency_schedule_claim where id = '30000000-0000-4000-8000-000000000007'),
      'temporary_provider_failure',
      'fake_retryable_error',
      '2026-07-01T23:56:00Z'
    )
  ),
  'dead'::public.delivery_job_status,
  'a retry that would fall beyond the 24-hour idempotency window is never scheduled'
);

select is(
  (select last_error_code from public.delivery_jobs where id = '30000000-0000-4000-8000-000000000007'),
  'idempotency_window_expired',
  'unsafe retry scheduling records the sanitized idempotency reason'
);

insert into public.surveys (id, order_id, location_id)
values ('20000000-0000-4000-8000-000000000004', 'FAKE-RETRY-SMS-ORDER', 'FAKE-LOC-001');
insert into public.delivery_jobs (id, survey_id, kind, scheduled_at, next_attempt_at)
values (
  '30000000-0000-4000-8000-000000000004',
  '20000000-0000-4000-8000-000000000004',
  'survey_sms',
  '2026-05-01T12:00:00Z',
  '2026-05-01T12:00:00Z'
);

create temporary table retry_observed (
  attempt_count smallint,
  status public.delivery_job_status,
  next_attempt_at timestamptz
);

do $$
declare
  v_now timestamptz := '2026-05-01T12:00:00Z';
  v_claim record;
  v_started record;
  v_retry record;
  v_attempt integer;
begin
  for v_attempt in 1..6 loop
    select claim.*
    into v_claim
    from public.claim_delivery_jobs(
      '40000000-0000-4000-8000-000000000007',
      20,
      600,
      v_now
    ) as claim
    where claim.id = '30000000-0000-4000-8000-000000000004';

    select started.*
    into v_started
    from public.mark_delivery_job_provider_started(
      v_claim.id,
      v_claim.lease_token,
      v_now
    ) as started;

    select retried.*
    into v_retry
    from public.mark_delivery_job_retry(
      v_claim.id,
      v_claim.lease_token,
      'temporary_provider_failure',
      'fake_retryable_error',
      v_now
    ) as retried;

    insert into retry_observed values (
      v_retry.attempt_count,
      v_retry.status,
      v_retry.next_attempt_at
    );

    v_now := v_retry.next_attempt_at;
  end loop;
end;
$$;

select is(
  (select next_attempt_at from retry_observed where attempt_count = 1),
  '2026-05-01T12:05:00Z'::timestamptz,
  'attempt one retries after exactly five minutes'
);
select is(
  (select next_attempt_at from retry_observed where attempt_count = 2),
  '2026-05-01T12:20:00Z'::timestamptz,
  'attempt two retries after exactly fifteen minutes'
);
select is(
  (select next_attempt_at from retry_observed where attempt_count = 3),
  '2026-05-01T13:20:00Z'::timestamptz,
  'attempt three retries after exactly sixty minutes'
);
select is(
  (select next_attempt_at from retry_observed where attempt_count = 4),
  '2026-05-01T17:20:00Z'::timestamptz,
  'attempt four retries after exactly 240 minutes'
);
select is(
  (select next_attempt_at from retry_observed where attempt_count = 5),
  '2026-05-02T05:20:00Z'::timestamptz,
  'attempt five retries after exactly 720 minutes'
);
select is(
  (select status from retry_observed where attempt_count = 6),
  'dead'::public.delivery_job_status,
  'the sixth failed attempt exhausts the job without a seventh delivery'
);
select is(
  (select status from public.delivery_jobs where id = '30000000-0000-4000-8000-000000000004'),
  'dead'::public.delivery_job_status,
  'retry exhaustion is durably stored'
);

select matches(
  pg_get_functiondef('public.claim_delivery_jobs(uuid, integer, integer, timestamptz)'::regprocedure),
  'for update skip locked',
  'job claiming uses row locks with SKIP LOCKED for concurrent workers'
);

select is(
  has_function_privilege(
    'anon',
    'public.create_survey_with_sms_job(text, text, text, text, jsonb, timestamptz)',
    'EXECUTE'
  ),
  false,
  'anonymous clients cannot execute the atomic survey enqueue function'
);
select is(
  has_function_privilege(
    'authenticated',
    'public.claim_delivery_jobs(uuid, integer, integer, timestamptz)',
    'EXECUTE'
  ),
  false,
  'authenticated clients cannot claim delivery jobs'
);
select is(
  has_function_privilege(
    'service_role',
    'public.claim_delivery_jobs(uuid, integer, integer, timestamptz)',
    'EXECUTE'
  ),
  true,
  'the server service role can claim delivery jobs'
);

set local role anon;

select throws_like(
  $sql$select count(*) from public.delivery_jobs$sql$,
  '%permission denied for table delivery_jobs%',
  'anonymous clients cannot read delivery jobs'
);

select throws_like(
  $sql$
    select *
    from public.create_survey_with_sms_job(
      'ANON-ORDER',
      'FAKE-LOC-001',
      '+13175550000',
      null,
      '[]'::jsonb,
      now()
    )
  $sql$,
  '%permission denied for function create_survey_with_sms_job%',
  'anonymous clients cannot enqueue customer messages through RPCs'
);

reset role;

select * from finish();
rollback;
