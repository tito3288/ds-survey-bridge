begin;

create schema if not exists extensions;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(10);

select is(
  (
    select count(*)
    from public.surveys
    where order_id in (
      'FAKE-PRE-004-RATING-ORDER',
      'FAKE-PRE-004-COMPLETE-ORDER'
    )
  ),
  2::bigint,
  'all surveys created before migration 004 survive'
);

select is(
  (select rating from public.surveys where order_id = 'FAKE-PRE-004-RATING-ORDER'),
  2,
  'migration 004 preserves an existing overall rating'
);

select is(
  (select comment from public.surveys where order_id = 'FAKE-PRE-004-RATING-ORDER'),
  'Fictional feedback created before migration 004.',
  'migration 004 preserves an existing comment'
);

select is(
  (
    select row(
      wait_time_score,
      service_speed_score,
      vehicle_cleanliness_score,
      additional_services_experience_score,
      value_score,
      team_friendliness_score,
      questionnaire_version
    )
    from public.surveys
    where order_id = 'FAKE-PRE-004-COMPLETE-ORDER'
  ),
  row(2::smallint, 3::smallint, 4::smallint, 5::smallint, 3::smallint, 4::smallint, 1::smallint),
  'migration 004 preserves every completed questionnaire value'
);

select is(
  (
    select questionnaire_submitted_at
    from public.surveys
    where order_id = 'FAKE-PRE-004-COMPLETE-ORDER'
  ),
  '2026-01-12T13:10:00Z'::timestamptz,
  'migration 004 preserves questionnaire completion time'
);

select is(
  (
    select count(*)
    from public.surveys
    where order_id in (
      'FAKE-PRE-004-RATING-ORDER',
      'FAKE-PRE-004-COMPLETE-ORDER'
    )
      and survey_token is not null
  ),
  2::bigint,
  'migration 004 preserves private survey tokens'
);

select is(
  (select count(*) from public.delivery_jobs),
  0::bigint,
  'migration 004 creates no delivery jobs for historical surveys'
);

select lives_ok(
  $sql$
    insert into public.surveys (order_id, location_id)
    values ('FAKE-POST-004-DIRECT-ORDER', 'FAKE-PRE-004-LOCATION')
  $sql$,
  'direct post-migration survey inserts remain compatible'
);

select is(
  (
    select count(*)
    from public.delivery_jobs as job
    join public.surveys as survey on survey.id = job.survey_id
    where survey.order_id = 'FAKE-POST-004-DIRECT-ORDER'
  ),
  0::bigint,
  'direct inserts do not silently enqueue outbound work'
);

select is(
  (select survey_flow_version from public.surveys where order_id = 'FAKE-POST-004-DIRECT-ORDER'),
  2::smallint,
  'migration 004 leaves private-link flow version defaults unchanged'
);

select * from finish();
rollback;
