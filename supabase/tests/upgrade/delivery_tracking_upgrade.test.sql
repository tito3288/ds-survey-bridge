begin;

create schema if not exists extensions;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select no_plan();

select is(
  (
    select count(*)
    from public.surveys
    where order_id like 'FAKE-PRE-005-%'
  ),
  3::bigint,
  'all surveys created before migration 005 survive'
);

select is(
  (
    select count(*)
    from public.delivery_jobs
    where id in (
      '50000000-0000-4000-8000-000000000091',
      '50000000-0000-4000-8000-000000000092',
      '50000000-0000-4000-8000-000000000093'
    )
  ),
  3::bigint,
  'all delivery jobs created before migration 005 survive'
);

select is(
  (
    select row(status, provider_message_id, accepted_at)
    from public.delivery_jobs
    where id = '50000000-0000-4000-8000-000000000091'
  ),
  row(
    'sent'::public.delivery_job_status,
    'FAKE-PRE-005-TWILIO-SID'::text,
    '2026-02-01T12:00:05Z'::timestamptz
  ),
  'migration 005 preserves an accepted SMS job exactly'
);

select is(
  (
    select row(status, provider_message_id, last_error_category, last_error_code)
    from public.delivery_jobs
    where id = '50000000-0000-4000-8000-000000000092'
  ),
  row(
    'unknown'::public.delivery_job_status,
    null::text,
    'uncertain_provider_outcome'::text,
    'connection_lost'::text
  ),
  'migration 005 preserves an ambiguous SMS outcome exactly'
);

select is(
  (
    select row(status, provider_message_id, accepted_at)
    from public.delivery_jobs
    where id = '50000000-0000-4000-8000-000000000093'
  ),
  row(
    'sent'::public.delivery_job_status,
    'FAKE-PRE-005-RESEND-ID'::text,
    '2026-02-03T12:00:05Z'::timestamptz
  ),
  'migration 005 preserves an accepted private email job exactly'
);

select is(
  (
    select count(*)
    from public.delivery_jobs
    where downstream_status is not null
      or downstream_status_at is not null
      or delivered_at is not null
      or delayed_at is not null
      or failed_at is not null
      or complained_at is not null
  ),
  0::bigint,
  'migration 005 invents no downstream status or timestamps for historical jobs'
);

select is(
  (
    select count(*)
    from public.delivery_jobs
    where last_reconciled_at is not null
  ),
  0::bigint,
  'migration 005 invents no reconciliation watermark for historical jobs'
);

select is(
  (select count(*) from public.delivery_events),
  0::bigint,
  'migration 005 invents no callback receipts for historical jobs'
);

select is(
  (
    select sent_at
    from public.surveys
    where id = '00000000-0000-4000-8000-000000000091'
  ),
  '2026-02-01T12:00:05Z'::timestamptz,
  'migration 005 preserves the compatible survey SMS sent time'
);

select * from finish();
rollback;
