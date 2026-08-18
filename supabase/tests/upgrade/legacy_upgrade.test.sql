begin;

create schema if not exists extensions;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(7);

select is(
  (select count(*) from public.surveys where order_id = 'FAKE-PRE-002-ORDER'),
  1::bigint,
  'the survey row created under migration 001 survives later migrations'
);

select is(
  (select rating from public.surveys where order_id = 'FAKE-PRE-002-ORDER'),
  2,
  'the legacy rating remains unchanged'
);

select is(
  (select comment from public.surveys where order_id = 'FAKE-PRE-002-ORDER'),
  'Fictional feedback created before migration 002.',
  'the legacy comment remains unchanged'
);

select is(
  (
    select responded_at
    from public.surveys
    where order_id = 'FAKE-PRE-002-ORDER'
  ),
  '2026-01-10T12:05:00Z'::timestamptz,
  'the legacy response timestamp remains unchanged'
);

select ok(
  (
    select
      wait_time_score is null
      and service_speed_score is null
      and vehicle_cleanliness_score is null
      and additional_services_experience_score is null
      and value_score is null
      and team_friendliness_score is null
      and questionnaire_version is null
      and questionnaire_submitted_at is null
    from public.surveys
    where order_id = 'FAKE-PRE-002-ORDER'
  ),
  'migration 002 does not invent questionnaire answers for a legacy row'
);

select is(
  (
    select survey_flow_version
    from public.surveys
    where order_id = 'FAKE-PRE-002-ORDER'
  ),
  null::smallint,
  'a pre-versioned row remains explicitly identifiable as legacy'
);

select ok(
  (
    select survey_token is not null
    from public.surveys
    where order_id = 'FAKE-PRE-002-ORDER'
  ),
  'a pre-versioned row receives a private survey token without changing its answers'
);

select * from finish();
rollback;
