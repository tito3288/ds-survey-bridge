begin;

create schema if not exists extensions;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select no_plan();

select has_table('public', 'delivery_events', 'verified callback receipt table exists');
select has_column('public', 'delivery_jobs', 'downstream_status', 'jobs store final downstream status separately');
select has_column('public', 'delivery_jobs', 'downstream_status_at', 'jobs timestamp downstream status changes');
select has_column('public', 'delivery_jobs', 'delivered_at', 'jobs retain verified delivery evidence time');
select has_column('public', 'delivery_jobs', 'failed_at', 'jobs retain verified failure evidence time');
select has_column('public', 'delivery_jobs', 'delayed_at', 'jobs retain verified delay evidence time');
select has_column('public', 'delivery_jobs', 'complained_at', 'jobs retain verified complaint evidence time');
select has_column('public', 'delivery_jobs', 'last_reconciled_at', 'jobs retain a privacy-safe reconciliation watermark');

select enum_has_labels(
  'public',
  'delivery_provider',
  array['twilio', 'resend'],
  'callback providers are intentionally limited'
);
select enum_has_labels(
  'public',
  'delivery_event_type',
  array['accepted', 'delivered', 'delayed', 'failed', 'complained'],
  'privacy-minimal callback evidence types are intentionally limited'
);
select enum_has_labels(
  'public',
  'delivery_downstream_status',
  array['delivered', 'delayed', 'failed', 'mixed', 'complained'],
  'downstream aggregate states are intentionally limited'
);

select is(
  (
    select relrowsecurity
    from pg_catalog.pg_class
    where oid = 'public.delivery_events'::regclass
  ),
  true,
  'RLS is enabled on callback receipts'
);
select is(
  (
    select count(*)::integer
    from pg_catalog.pg_policies
    where schemaname = 'public' and tablename = 'delivery_events'
  ),
  0,
  'callback receipts expose no client-facing RLS policies'
);
select is(
  (
    select count(*)::integer
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'delivery_events'
      and column_name ~ '(phone|customer|recipient|email_address|subject|payload|raw|message_body|body|answer|comment|fingerprint)'
  ),
  0,
  'callback receipts have no PII, raw payload, message, answer, or recipient columns'
);
select ok(
  has_table_privilege('service_role', 'public.delivery_events', 'SELECT'),
  'service role can inspect privacy-minimal callback receipts'
);
select ok(
  not has_table_privilege('service_role', 'public.delivery_events', 'INSERT'),
  'service role cannot bypass the append-only receipt function'
);
select ok(
  not has_table_privilege('service_role', 'public.delivery_events', 'UPDATE'),
  'service role cannot edit callback receipts'
);
select ok(
  not has_table_privilege('service_role', 'public.delivery_events', 'DELETE'),
  'service role cannot directly delete callback receipts'
);
select ok(
  not has_table_privilege('anon', 'public.delivery_events', 'SELECT'),
  'anonymous clients cannot read callback receipts'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.record_delivery_event(uuid,public.delivery_provider,text,text,public.delivery_event_type,timestamptz,timestamptz,text)',
    'EXECUTE'
  ),
  'anonymous clients cannot ingest callback receipts'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.record_delivery_event(uuid,public.delivery_provider,text,text,public.delivery_event_type,timestamptz,timestamptz,text)',
    'EXECUTE'
  ),
  'service role can ingest verified callback receipts'
);
select is(
  (select count(*) from public.delivery_events),
  0::bigint,
  'fictional seed data receives no invented callback receipts'
);
select is(
  (select count(*) from public.delivery_jobs where downstream_status is not null),
  0::bigint,
  'fictional seed data receives no invented downstream outcomes'
);

-- A callback may arrive before the worker has saved provider acceptance. It
-- binds the opaque provider ID, resolves an ambiguous job, and records evidence.
insert into public.surveys (id, order_id, location_id)
values ('61000000-0000-4000-8000-000000000001', 'FAKE-CALLBACK-RACE-SMS', 'FAKE-LOC-001');
insert into public.delivery_jobs (
  id, survey_id, kind, status, scheduled_at, next_attempt_at, attempt_count,
  first_provider_call_started_at, provider_call_started_at,
  last_error_category, last_error_code
)
values (
  '62000000-0000-4000-8000-000000000001',
  '61000000-0000-4000-8000-000000000001',
  'survey_sms',
  'unknown',
  '2099-01-01T12:00:00Z',
  '2099-01-01T12:00:00Z',
  1,
  '2099-01-01T12:00:01Z',
  '2099-01-01T12:00:01Z',
  'uncertain_provider_outcome',
  'connection_lost'
);

select is(
  (
    select outcome
    from public.record_delivery_event(
      '62000000-0000-4000-8000-000000000001',
      'twilio',
      'FAKE-TWILIO-RACE-SID',
      'FAKE-TWILIO-RACE-DELIVERED',
      'delivered',
      '2099-01-01T12:00:03Z',
      '2099-01-01T12:00:04Z',
      '3000'
    )
  ),
  'recorded',
  'a verified callback is recorded'
);
select is(
  (
    select row(status, provider_message_id, accepted_at, downstream_status, delivered_at)
    from public.delivery_jobs
    where id = '62000000-0000-4000-8000-000000000001'
  ),
  row(
    'sent'::public.delivery_job_status,
    'FAKE-TWILIO-RACE-SID'::text,
    '2099-01-01T12:00:01Z'::timestamptz,
    'delivered'::public.delivery_downstream_status,
    '2099-01-01T12:00:03Z'::timestamptz
  ),
  'callback-before-worker reconciles acceptance and downstream delivery without conflating the states'
);
select is(
  (
    select sent_at
    from public.surveys
    where id = '61000000-0000-4000-8000-000000000001'
  ),
  '2099-01-01T12:00:01Z'::timestamptz,
  'a verified SMS callback updates the compatible survey sent time'
);
select is(
  public.mark_delivery_job_sent(
    '62000000-0000-4000-8000-000000000001',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'FAKE-TWILIO-RACE-SID',
    '2099-01-01T12:00:02Z'
  ),
  true,
  'the worker response is idempotent when the callback already saved the same provider ID'
);
select is(
  public.mark_delivery_job_sent(
    '62000000-0000-4000-8000-000000000001',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'DIFFERENT-TWILIO-SID',
    '2099-01-01T12:00:02Z'
  ),
  false,
  'the callback race fence rejects a mismatched provider ID'
);

select is(
  (
    select outcome
    from public.record_delivery_event(
      '62000000-0000-4000-8000-000000000001',
      'twilio',
      'FAKE-TWILIO-RACE-SID',
      'FAKE-TWILIO-RACE-DELIVERED',
      'delivered',
      '2099-01-01T12:00:03Z',
      '2099-01-01T12:00:05Z',
      '3000'
    )
  ),
  'duplicate',
  'a repeated provider receipt is an idempotent duplicate'
);
select is(
  (
    select count(*)
    from public.delivery_events
    where provider = 'twilio'
      and provider_event_key = 'FAKE-TWILIO-RACE-DELIVERED'
  ),
  1::bigint,
  'duplicate callbacks retain one append-only receipt'
);

insert into public.surveys (id, order_id, location_id)
values ('61000000-0000-4000-8000-000000000008', 'FAKE-LATE-CALLBACK-DEAD-SMS', 'FAKE-LOC-001');
insert into public.delivery_jobs (
  id, survey_id, kind, status, scheduled_at, next_attempt_at, attempt_count,
  first_provider_call_started_at, last_error_category, last_error_code
)
values (
  '62000000-0000-4000-8000-000000000008',
  '61000000-0000-4000-8000-000000000008',
  'survey_sms',
  'dead',
  '2099-01-02T12:00:00Z',
  '2099-01-02T12:00:00Z',
  6,
  '2099-01-02T12:00:01Z',
  'retry_exhausted',
  'attempts_exhausted'
);

select is(
  (
    select outcome
    from public.record_delivery_event(
      '62000000-0000-4000-8000-000000000008',
      'twilio',
      'FAKE-TWILIO-LATE-DEAD-SID',
      'FAKE-TWILIO-LATE-DEAD-DELIVERED',
      'delivered',
      '2099-01-02T12:00:03Z',
      '2099-01-02T12:00:04Z',
      null
    )
  ),
  'recorded',
  'a late verified callback is recorded after local retry exhaustion'
);
select is(
  (
    select row(
      status,
      provider_message_id,
      accepted_at,
      downstream_status,
      last_error_category,
      last_error_code,
      lease_token
    )
    from public.delivery_jobs
    where id = '62000000-0000-4000-8000-000000000008'
  ),
  row(
    'sent'::public.delivery_job_status,
    'FAKE-TWILIO-LATE-DEAD-SID'::text,
    '2099-01-02T12:00:01Z'::timestamptz,
    'delivered'::public.delivery_downstream_status,
    null::text,
    null::text,
    null::uuid
  ),
  'verified provider evidence promotes dead to sent and clears terminal worker errors'
);

insert into public.surveys (id, order_id, location_id, rating)
values
  ('61000000-0000-4000-8000-000000000002', 'FAKE-CALLBACK-CONFLICT-SMS', 'FAKE-LOC-001', null),
  ('61000000-0000-4000-8000-000000000003', 'FAKE-CALLBACK-KIND-EMAIL', 'FAKE-LOC-001', 2);
insert into public.delivery_jobs (id, survey_id, kind, scheduled_at, next_attempt_at)
values
  (
    '62000000-0000-4000-8000-000000000002',
    '61000000-0000-4000-8000-000000000002',
    'survey_sms',
    '2100-01-01T00:00:00Z',
    '2100-01-01T00:00:00Z'
  ),
  (
    '62000000-0000-4000-8000-000000000003',
    '61000000-0000-4000-8000-000000000003',
    'private_feedback_email',
    '2100-01-01T00:00:00Z',
    '2100-01-01T00:00:00Z'
  );

select is(
  (
    select outcome
    from public.record_delivery_event(
      '62000000-0000-4000-8000-000000000002', 'twilio',
      'ANOTHER-TWILIO-SID', 'FAKE-TWILIO-RACE-DELIVERED', 'delivered',
      '2099-01-01T12:00:03Z', '2099-01-01T12:01:00Z', null
    )
  ),
  'event_key_conflict',
  'a provider event key cannot be rebound to another job'
);
select is(
  (
    select outcome
    from public.record_delivery_event(
      '62000000-0000-4000-8000-000000000002', 'twilio',
      'FAKE-TWILIO-RACE-SID', 'FAKE-UNIQUE-EVENT-KEY', 'accepted',
      '2099-01-01T12:01:00Z', '2099-01-01T12:01:00Z', null
    )
  ),
  'provider_message_conflict',
  'one provider message ID cannot be bound to two jobs'
);
select is(
  (
    select count(*)
    from public.delivery_events
    where provider_event_key = 'FAKE-UNIQUE-EVENT-KEY'
  ),
  0::bigint,
  'a provider-ID conflict rolls back its tentative callback receipt'
);
select is(
  (
    select outcome
    from public.record_delivery_event(
      '62000000-0000-4000-8000-000000000003', 'twilio',
      'FAKE-WRONG-KIND-SID', 'FAKE-WRONG-KIND-EVENT', 'delivered',
      '2099-01-01T12:01:00Z', '2099-01-01T12:01:00Z', null
    )
  ),
  'provider_kind_mismatch',
  'Twilio evidence cannot be attached to a private-email job'
);
select is(
  (
    select outcome
    from public.record_delivery_event(
      '62000000-0000-4000-8000-000000000002', 'twilio',
      'FAKE-TWILIO-COMPLAINT', 'FAKE-TWILIO-COMPLAINT-EVENT', 'complained',
      '2099-01-01T12:01:00Z', '2099-01-01T12:01:00Z', null
    )
  ),
  'event_type_mismatch',
  'email-only complaint evidence is rejected for SMS jobs'
);
select is(
  (
    select outcome
    from public.record_delivery_event(
      'ffffffff-ffff-4fff-8fff-ffffffffffff', 'twilio',
      'FAKE-UNKNOWN-SID', 'FAKE-UNKNOWN-EVENT', 'delivered',
      '2099-01-01T12:01:00Z', '2099-01-01T12:01:00Z', null
    )
  ),
  'not_found',
  'an unknown opaque delivery-job ID reveals only a terminal not-found outcome'
);

-- SMS evidence is monotonic: delivery is stronger than delayed or failed,
-- regardless of callback order.
insert into public.surveys (id, order_id, location_id, sent_at)
values (
  '61000000-0000-4000-8000-000000000004',
  'FAKE-OUT-OF-ORDER-SMS',
  'FAKE-LOC-001',
  '2099-02-01T12:00:00Z'
);
insert into public.delivery_jobs (
  id, survey_id, kind, status, scheduled_at, next_attempt_at,
  provider_message_id, accepted_at
)
values (
  '62000000-0000-4000-8000-000000000004',
  '61000000-0000-4000-8000-000000000004',
  'survey_sms',
  'sent',
  '2099-02-01T12:00:00Z',
  '2099-02-01T12:00:00Z',
  'FAKE-TWILIO-ORDER-SID',
  '2099-02-01T12:00:00Z'
);

select is(
  (
    select downstream_status
    from public.record_delivery_event(
      '62000000-0000-4000-8000-000000000004', 'twilio',
      'FAKE-TWILIO-ORDER-SID', 'FAKE-SMS-FAILED-FIRST', 'failed',
      '2099-02-01T12:05:00Z', '2099-02-01T12:06:00Z', '30007'
    )
  ),
  'failed'::public.delivery_downstream_status,
  'a verified SMS failure is tracked downstream without changing provider acceptance'
);
select is(
  (
    select downstream_status
    from public.record_delivery_event(
      '62000000-0000-4000-8000-000000000004', 'twilio',
      'FAKE-TWILIO-ORDER-SID', 'FAKE-SMS-DELIVERED-LATE', 'delivered',
      '2099-02-01T12:04:00Z', '2099-02-01T12:07:00Z', null
    )
  ),
  'delivered'::public.delivery_downstream_status,
  'late delivery evidence safely upgrades an earlier SMS failure'
);
select is(
  (
    select downstream_status
    from public.record_delivery_event(
      '62000000-0000-4000-8000-000000000004', 'twilio',
      'FAKE-TWILIO-ORDER-SID', 'FAKE-SMS-FAILED-LATER', 'failed',
      '2099-02-01T12:03:00Z', '2099-02-01T12:08:00Z', '30008'
    )
  ),
  'delivered'::public.delivery_downstream_status,
  'late failure evidence cannot downgrade verified SMS delivery'
);
select is(
  (
    select row(status, delivered_at, failed_at)
    from public.delivery_jobs
    where id = '62000000-0000-4000-8000-000000000004'
  ),
  row(
    'sent'::public.delivery_job_status,
    '2099-02-01T12:04:00Z'::timestamptz,
    '2099-02-01T12:03:00Z'::timestamptz
  ),
  'SMS delivery and failure evidence are retained while provider acceptance stays sent'
);

-- Resend may emit one event per recipient. Aggregate only job-level evidence,
-- with no recipient identifiers or fingerprints.
insert into public.surveys (id, order_id, location_id, rating)
values
  ('61000000-0000-4000-8000-000000000005', 'FAKE-MULTI-RECIPIENT-EMAIL', 'FAKE-LOC-001', 2),
  ('61000000-0000-4000-8000-000000000006', 'FAKE-MIXED-HEALTH-EMAIL', 'FAKE-LOC-001', 1),
  ('61000000-0000-4000-8000-000000000007', 'FAKE-ACCEPTED-ONLY-EMAIL', 'FAKE-LOC-001', 3);
insert into public.delivery_jobs (
  id, survey_id, kind, status, scheduled_at, next_attempt_at,
  provider_message_id, accepted_at
)
values
  (
    '62000000-0000-4000-8000-000000000005',
    '61000000-0000-4000-8000-000000000005',
    'private_feedback_email', 'sent',
    '2099-03-01T12:00:00Z', '2099-03-01T12:00:00Z',
    'FAKE-RESEND-MULTI-ID', '2099-03-01T12:00:00Z'
  ),
  (
    '62000000-0000-4000-8000-000000000006',
    '61000000-0000-4000-8000-000000000006',
    'private_feedback_email', 'sent',
    '2099-03-01T12:00:00Z', '2099-03-01T12:00:00Z',
    'FAKE-RESEND-MIXED-ID', '2099-03-01T12:00:00Z'
  ),
  (
    '62000000-0000-4000-8000-000000000007',
    '61000000-0000-4000-8000-000000000007',
    'private_feedback_email', 'sent',
    '2099-03-01T12:00:00Z', '2099-03-01T12:00:00Z',
    'FAKE-RESEND-ACCEPTED-ID', '2099-03-01T12:00:00Z'
  );

select is(
  (
    select downstream_status
    from public.record_delivery_event(
      '62000000-0000-4000-8000-000000000005', 'resend',
      'FAKE-RESEND-MULTI-ID', 'FAKE-RESEND-FAILED-ONE', 'failed',
      '2099-03-01T12:10:00Z', '2099-03-01T12:10:01Z', 'bounce'
    )
  ),
  'failed'::public.delivery_downstream_status,
  'failure-only email evidence is failed'
);
select is(
  (
    select downstream_status
    from public.record_delivery_event(
      '62000000-0000-4000-8000-000000000005', 'resend',
      'FAKE-RESEND-MULTI-ID', 'FAKE-RESEND-DELIVERED-ONE', 'delivered',
      '2099-03-01T12:09:00Z', '2099-03-01T12:10:02Z', null
    )
  ),
  'mixed'::public.delivery_downstream_status,
  'email success and failure evidence aggregate to mixed'
);
select is(
  (
    select downstream_status
    from public.record_delivery_event(
      '62000000-0000-4000-8000-000000000005', 'resend',
      'FAKE-RESEND-MULTI-ID', 'FAKE-RESEND-COMPLAINT', 'complained',
      '2099-03-01T12:11:00Z', '2099-03-01T12:11:01Z', 'complained'
    )
  ),
  'complained'::public.delivery_downstream_status,
  'complaint evidence becomes the terminal privacy-minimal email state'
);
select is(
  (
    select downstream_status
    from public.record_delivery_event(
      '62000000-0000-4000-8000-000000000005', 'resend',
      'FAKE-RESEND-MULTI-ID', 'FAKE-RESEND-DELIVERED-LATE', 'delivered',
      '2099-03-01T12:08:00Z', '2099-03-01T12:12:01Z', null
    )
  ),
  'complained'::public.delivery_downstream_status,
  'out-of-order delivery cannot downgrade a complaint'
);
select is(
  (
    select count(*)
    from public.delivery_events
    where delivery_job_id = '62000000-0000-4000-8000-000000000005'
  ),
  4::bigint,
  'multi-recipient evidence stores one privacy-minimal job receipt per provider event'
);

select lives_ok(
  $sql$
    select *
    from public.record_delivery_event(
      '62000000-0000-4000-8000-000000000006', 'resend',
      'FAKE-RESEND-MIXED-ID', 'FAKE-MIXED-DELIVERED', 'delivered',
      '2099-03-01T12:09:00Z', '2099-03-01T12:09:01Z', null
    );
    select *
    from public.record_delivery_event(
      '62000000-0000-4000-8000-000000000006', 'resend',
      'FAKE-RESEND-MIXED-ID', 'FAKE-MIXED-FAILED', 'failed',
      '2099-03-01T12:10:00Z', '2099-03-01T12:10:01Z', 'bounce'
    )
  $sql$,
  'a second email job records mixed delivery evidence for health reporting'
);
select is(
  (
    select downstream_status
    from public.record_delivery_event(
      '62000000-0000-4000-8000-000000000007', 'resend',
      'FAKE-RESEND-ACCEPTED-ID', 'FAKE-RESEND-ACCEPTED-EVENT', 'accepted',
      '2099-03-01T12:00:00Z', '2099-03-01T12:00:01Z', 'accepted'
    )
  ),
  null::public.delivery_downstream_status,
  'provider acceptance receipts do not invent a downstream delivery result'
);
select is(
  (
    select provider_code
    from public.delivery_events
    where provider_event_key = 'FAKE-RESEND-ACCEPTED-EVENT'
  ),
  'accepted',
  'safe provider codes are stored without raw webhook content'
);
select is(
  (
    select outcome
    from public.record_delivery_event(
      '62000000-0000-4000-8000-000000000007', 'resend',
      'FAKE-RESEND-ACCEPTED-ID', 'FAKE-RESEND-UNSAFE-CODE', 'delayed',
      '2099-03-01T12:02:00Z', '2099-03-01T12:02:01Z',
      'unsafe code containing customer@example.test'
    )
  ),
  'recorded',
  'an event with an unsafe provider code is still handled safely'
);
select is(
  (
    select provider_code
    from public.delivery_events
    where provider_event_key = 'FAKE-RESEND-UNSAFE-CODE'
  ),
  null::text,
  'unsafe free-form provider text is discarded instead of stored'
);

-- Operational health is aggregate-only and contains no survey or customer IDs.
insert into public.surveys (id, order_id, location_id)
values
  ('61000000-0000-4000-8000-000000000011', 'FAKE-HEALTH-OVERDUE', 'FAKE-LOC-001'),
  ('61000000-0000-4000-8000-000000000012', 'FAKE-HEALTH-STALE', 'FAKE-LOC-001'),
  ('61000000-0000-4000-8000-000000000013', 'FAKE-HEALTH-DEAD', 'FAKE-LOC-001'),
  ('61000000-0000-4000-8000-000000000014', 'FAKE-HEALTH-UNKNOWN', 'FAKE-LOC-001'),
  ('61000000-0000-4000-8000-000000000015', 'FAKE-HEALTH-FAILED-SMS', 'FAKE-LOC-001'),
  ('61000000-0000-4000-8000-000000000016', 'FAKE-HEALTH-GRACE', 'FAKE-LOC-001');
insert into public.delivery_jobs (
  id, survey_id, kind, status, scheduled_at, next_attempt_at,
  claimed_by_run_id, lease_token, lease_expires_at,
  first_provider_call_started_at, provider_call_started_at,
  provider_message_id, accepted_at
)
values
  (
    '62000000-0000-4000-8000-000000000011',
    '61000000-0000-4000-8000-000000000011',
    'survey_sms', 'pending',
    '2099-05-01T10:00:00Z', '2099-05-01T10:00:00Z',
    null, null, null, null, null, null, null
  ),
  (
    '62000000-0000-4000-8000-000000000012',
    '61000000-0000-4000-8000-000000000012',
    'survey_sms', 'processing',
    '2099-05-01T10:00:00Z', '2099-05-01T10:00:00Z',
    '63000000-0000-4000-8000-000000000012',
    '64000000-0000-4000-8000-000000000012',
    '2099-05-01T10:10:00Z',
    null, null, null, null
  ),
  (
    '62000000-0000-4000-8000-000000000013',
    '61000000-0000-4000-8000-000000000013',
    'survey_sms', 'dead',
    '2099-05-01T10:00:00Z', '2099-05-01T10:00:00Z',
    null, null, null, null, null, null, null
  ),
  (
    '62000000-0000-4000-8000-000000000014',
    '61000000-0000-4000-8000-000000000014',
    'survey_sms', 'unknown',
    '2099-05-01T10:00:00Z', '2099-05-01T10:00:00Z',
    null, null, null,
    '2099-05-01T10:01:00Z', '2099-05-01T10:01:00Z', null, null
  ),
  (
    '62000000-0000-4000-8000-000000000015',
    '61000000-0000-4000-8000-000000000015',
    'survey_sms', 'sent',
    '2099-05-01T10:00:00Z', '2099-05-01T10:00:00Z',
    null, null, null, null, null,
    'FAKE-HEALTH-FAILED-SID', '2099-05-01T10:00:05Z'
  ),
  (
    '62000000-0000-4000-8000-000000000016',
    '61000000-0000-4000-8000-000000000016',
    'survey_sms', 'pending',
    '2099-05-01T11:50:00Z', '2099-05-01T11:50:00Z',
    null, null, null, null, null, null, null
  );

select lives_ok(
  $sql$
    select *
    from public.record_delivery_event(
      '62000000-0000-4000-8000-000000000015', 'twilio',
      'FAKE-HEALTH-FAILED-SID', 'FAKE-HEALTH-FAILED-EVENT', 'failed',
      '2099-05-01T10:05:00Z', '2099-05-01T10:05:01Z', '30007'
    )
  $sql$,
  'health reporting includes a verified failed SMS without exposing it'
);
select is(
  (
    select row(
      overdue_count, stale_count, dead_count, unknown_count,
      failed_count, mixed_count, complained_count
    )
    from public.get_delivery_health_summary('2099-05-01T12:00:00Z')
  ),
  row(1::bigint, 1::bigint, 1::bigint, 1::bigint, 1::bigint, 1::bigint, 1::bigint),
  'health summary applies a 15-minute overdue grace and reports only aggregate problem counts'
);

-- Reconciliation selects accepted Twilio messages with no final callback after
-- twelve hours. It only returns opaque job and provider IDs and never resends.
insert into public.surveys (id, order_id, location_id)
values
  ('61000000-0000-4000-8000-000000000021', 'FAKE-RECONCILE-OLD', 'FAKE-LOC-001'),
  ('61000000-0000-4000-8000-000000000022', 'FAKE-RECONCILE-DELAYED', 'FAKE-LOC-001'),
  ('61000000-0000-4000-8000-000000000023', 'FAKE-RECONCILE-RECENT', 'FAKE-LOC-001');
insert into public.delivery_jobs (
  id, survey_id, kind, status, scheduled_at, next_attempt_at,
  provider_message_id, accepted_at, downstream_status, downstream_status_at, delayed_at
)
values
  (
    '62000000-0000-4000-8000-000000000021',
    '61000000-0000-4000-8000-000000000021',
    'survey_sms', 'sent',
    '2099-06-01T00:00:00Z', '2099-06-01T00:00:00Z',
    'FAKE-RECONCILE-OLD-SID', '2099-06-01T00:00:00Z', null, null, null
  ),
  (
    '62000000-0000-4000-8000-000000000022',
    '61000000-0000-4000-8000-000000000022',
    'survey_sms', 'sent',
    '2099-06-01T00:00:00Z', '2099-06-01T00:00:00Z',
    'FAKE-RECONCILE-DELAYED-SID', '2099-06-01T00:00:00Z',
    'delayed', '2099-06-01T01:00:00Z', '2099-06-01T01:00:00Z'
  ),
  (
    '62000000-0000-4000-8000-000000000023',
    '61000000-0000-4000-8000-000000000023',
    'survey_sms', 'sent',
    '2099-06-01T15:00:00Z', '2099-06-01T15:00:00Z',
    'FAKE-RECONCILE-RECENT-SID', '2099-06-01T15:00:00Z', null, null, null
  );

select is(
  (
    select array_agg(delivery_job_id order by delivery_job_id)
    from public.get_twilio_reconciliation_candidates(
      '2099-06-02T00:00:00Z',
      20
    )
    where delivery_job_id in (
      '62000000-0000-4000-8000-000000000021',
      '62000000-0000-4000-8000-000000000022',
      '62000000-0000-4000-8000-000000000023'
    )
  ),
  array[
    '62000000-0000-4000-8000-000000000021'::uuid,
    '62000000-0000-4000-8000-000000000022'::uuid
  ],
  'reconciliation selects only old accepted SMS jobs without a final callback'
);
select is(
  (
    select count(*)
    from public.get_twilio_reconciliation_candidates(
      '2099-06-02T00:00:00Z',
      20
    )
    where delivery_job_id in (
      '62000000-0000-4000-8000-000000000021',
      '62000000-0000-4000-8000-000000000022'
    )
  ),
  0::bigint,
  'an immediate second reconciliation run cannot claim the same messages again'
);
select is(
  (
    select count(*)
    from public.get_twilio_reconciliation_candidates(
      '2099-06-02T12:00:00Z',
      1000
    )
    where delivery_job_id in (
      '62000000-0000-4000-8000-000000000021',
      '62000000-0000-4000-8000-000000000022'
    )
  ),
  2::bigint,
  'non-final messages become eligible again twelve hours after their last status lookup'
);
select is(
  (
    select count(*)
    from public.delivery_jobs
    where id in (
      '62000000-0000-4000-8000-000000000021',
      '62000000-0000-4000-8000-000000000022'
    )
      and last_reconciled_at = '2099-06-02T12:00:00Z'
  ),
  2::bigint,
  'each attempted provider lookup advances its reconciliation watermark'
);

insert into public.surveys (id, order_id, location_id)
values
  ('61000000-0000-4000-8000-000000000024', 'FAKE-RECONCILE-FAIR-ONE', 'FAKE-LOC-001'),
  ('61000000-0000-4000-8000-000000000025', 'FAKE-RECONCILE-FAIR-TWO', 'FAKE-LOC-001'),
  ('61000000-0000-4000-8000-000000000026', 'FAKE-RECONCILE-FAIR-THREE', 'FAKE-LOC-001');
insert into public.delivery_jobs (
  id, survey_id, kind, status, scheduled_at, next_attempt_at,
  provider_message_id, accepted_at
)
values
  (
    '62000000-0000-4000-8000-000000000024',
    '61000000-0000-4000-8000-000000000024',
    'survey_sms', 'sent',
    '2099-06-02T00:00:00Z', '2099-06-02T00:00:00Z',
    'FAKE-RECONCILE-FAIR-SID-ONE', '2099-06-02T00:00:00Z'
  ),
  (
    '62000000-0000-4000-8000-000000000025',
    '61000000-0000-4000-8000-000000000025',
    'survey_sms', 'sent',
    '2099-06-02T01:00:00Z', '2099-06-02T01:00:00Z',
    'FAKE-RECONCILE-FAIR-SID-TWO', '2099-06-02T01:00:00Z'
  ),
  (
    '62000000-0000-4000-8000-000000000026',
    '61000000-0000-4000-8000-000000000026',
    'survey_sms', 'sent',
    '2099-06-02T02:00:00Z', '2099-06-02T02:00:00Z',
    'FAKE-RECONCILE-FAIR-SID-THREE', '2099-06-02T02:00:00Z'
  );

select is(
  (
    select delivery_job_id
    from public.get_twilio_reconciliation_candidates(
      '2099-06-03T00:00:00Z',
      1
    )
  ),
  '62000000-0000-4000-8000-000000000024'::uuid,
  'a bounded reconciliation run fairly claims the oldest never-checked message first'
);
select is(
  (
    select count(*)
    from public.delivery_jobs
    where id in (
      '62000000-0000-4000-8000-000000000024',
      '62000000-0000-4000-8000-000000000025',
      '62000000-0000-4000-8000-000000000026'
    )
      and last_reconciled_at = '2099-06-03T00:00:00Z'
  ),
  1::bigint,
  'a one-row reconciliation limit advances exactly one watermark'
);
select is(
  (
    select delivery_job_id
    from public.get_twilio_reconciliation_candidates(
      '2099-06-03T00:00:00Z',
      1
    )
  ),
  '62000000-0000-4000-8000-000000000025'::uuid,
  'a second bounded run advances to the next eligible message instead of starving it'
);
select matches(
  lower(
    pg_get_functiondef(
      'public.get_twilio_reconciliation_candidates(timestamptz,integer)'::regprocedure
    )
  ),
  'for update skip locked',
  'reconciliation claims use row locks so concurrent operators cannot poll the same job'
);
select is(
  (
    select count(*)
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'delivery_events'
      and column_name in ('customer_phone', 'customer_name', 'recipient')
  ),
  0::bigint,
  'reconciliation and receipts require no customer contact fields'
);
select throws_like(
  $sql$
    select *
    from public.get_twilio_reconciliation_candidates(
      '2099-06-02T00:00:00Z',
      null
    )
  $sql$,
  '%reconciliation inputs are invalid%',
  'an absent reconciliation bound is rejected'
);

-- Cleanup is bounded and enforces the 90-day retention window. The aggregate
-- outcome remains on the job after old receipts are removed.
insert into public.surveys (id, order_id, location_id, rating)
values
  ('61000000-0000-4000-8000-000000000031', 'FAKE-CLEANUP-OLD-ONE', 'FAKE-LOC-001', 2),
  ('61000000-0000-4000-8000-000000000032', 'FAKE-CLEANUP-OLD-TWO', 'FAKE-LOC-001', 2),
  ('61000000-0000-4000-8000-000000000033', 'FAKE-CLEANUP-RECENT', 'FAKE-LOC-001', 2);
insert into public.delivery_jobs (
  id, survey_id, kind, status, scheduled_at, next_attempt_at,
  provider_message_id, accepted_at
)
values
  (
    '62000000-0000-4000-8000-000000000031',
    '61000000-0000-4000-8000-000000000031',
    'private_feedback_email', 'sent',
    '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z',
    'FAKE-CLEANUP-OLD-ID-ONE', '2026-01-01T00:00:00Z'
  ),
  (
    '62000000-0000-4000-8000-000000000032',
    '61000000-0000-4000-8000-000000000032',
    'private_feedback_email', 'sent',
    '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z',
    'FAKE-CLEANUP-OLD-ID-TWO', '2026-01-02T00:00:00Z'
  ),
  (
    '62000000-0000-4000-8000-000000000033',
    '61000000-0000-4000-8000-000000000033',
    'private_feedback_email', 'sent',
    '2026-05-15T00:00:00Z', '2026-05-15T00:00:00Z',
    'FAKE-CLEANUP-RECENT-ID', '2026-05-15T00:00:00Z'
  );

select lives_ok(
  $sql$
    select * from public.record_delivery_event(
      '62000000-0000-4000-8000-000000000031', 'resend',
      'FAKE-CLEANUP-OLD-ID-ONE', 'FAKE-CLEANUP-OLD-EVENT-ONE', 'delivered',
      '2026-01-01T00:01:00Z', '2026-01-01T00:01:01Z', null
    );
    select * from public.record_delivery_event(
      '62000000-0000-4000-8000-000000000032', 'resend',
      'FAKE-CLEANUP-OLD-ID-TWO', 'FAKE-CLEANUP-OLD-EVENT-TWO', 'delivered',
      '2026-01-02T00:01:00Z', '2026-01-02T00:01:01Z', null
    );
    select * from public.record_delivery_event(
      '62000000-0000-4000-8000-000000000033', 'resend',
      'FAKE-CLEANUP-RECENT-ID', 'FAKE-CLEANUP-RECENT-EVENT', 'delivered',
      '2026-05-15T00:01:00Z', '2026-05-15T00:01:01Z', null
    )
  $sql$,
  'cleanup fixtures are recorded through the same verified callback function'
);
select is(
  public.purge_delivery_events('2026-06-15T00:00:00Z', 1),
  1,
  'cleanup deletes at most its requested batch size'
);
select is(
  (
    select count(*)
    from public.delivery_events
    where provider_event_key in (
      'FAKE-CLEANUP-OLD-EVENT-ONE',
      'FAKE-CLEANUP-OLD-EVENT-TWO'
    )
  ),
  1::bigint,
  'one old callback receipt remains after a one-row cleanup batch'
);
select is(
  public.purge_delivery_events('2026-06-15T00:00:00Z', 10),
  1,
  'a later cleanup removes the remaining receipt older than 90 days'
);
select is(
  (
    select count(*)
    from public.delivery_events
    where provider_event_key = 'FAKE-CLEANUP-RECENT-EVENT'
  ),
  1::bigint,
  'cleanup preserves callback receipts inside the 90-day retention window'
);
select is(
  (
    select count(*)
    from public.delivery_jobs
    where id in (
      '62000000-0000-4000-8000-000000000031',
      '62000000-0000-4000-8000-000000000032'
    )
      and downstream_status = 'delivered'
  ),
  2::bigint,
  'receipt cleanup preserves final downstream status on delivery jobs'
);
select throws_like(
  $sql$
    select public.purge_delivery_events('2026-06-15T00:00:00Z', 0)
  $sql$,
  '%delivery event cleanup inputs are invalid%',
  'cleanup rejects an unbounded zero-size request'
);
select throws_like(
  $sql$
    select public.purge_delivery_events(clock_timestamp() + interval '1 day', 10)
  $sql$,
  '%delivery event cleanup time is invalid%',
  'cleanup rejects a caller clock that could erase receipts prematurely'
);

select * from finish();
rollback;
