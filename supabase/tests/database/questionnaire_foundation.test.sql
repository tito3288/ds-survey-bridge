begin;

create schema if not exists extensions;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(33);

select has_column('public', 'surveys', 'wait_time_score', 'wait-time score column exists');
select has_column('public', 'surveys', 'service_speed_score', 'service-speed score column exists');
select has_column('public', 'surveys', 'vehicle_cleanliness_score', 'vehicle-cleanliness score column exists');
select has_column(
  'public',
  'surveys',
  'additional_services_experience_score',
  'additional-service experience score column exists'
);
select has_column('public', 'surveys', 'value_score', 'value score column exists');
select has_column('public', 'surveys', 'team_friendliness_score', 'team-friendliness score column exists');
select has_column('public', 'surveys', 'survey_flow_version', 'survey flow version column exists');
select has_column('public', 'surveys', 'questionnaire_version', 'questionnaire version column exists');
select has_column(
  'public',
  'surveys',
  'questionnaire_submitted_at',
  'questionnaire completion-time column exists'
);

select lives_ok(
  $sql$
    insert into public.surveys (
      order_id,
      location_id,
      rating,
      comment
    ) values (
      'PGTAP-LEGACY-ORDER',
      'FAKE-LOC-001',
      3,
      'Legacy-shaped test response'
    )
  $sql$,
  'legacy-shaped survey rows remain valid'
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
    where order_id = 'PGTAP-LEGACY-ORDER'
  ),
  'legacy rows retain null questionnaire fields without invented answers'
);

select is(
  (
    select survey_flow_version
    from public.surveys
    where order_id = 'PGTAP-LEGACY-ORDER'
  ),
  1::smallint,
  'rows inserted after migration 002 receive flow version 1'
);

select lives_ok(
  $sql$
    insert into public.surveys (
      order_id,
      location_id,
      rating,
      wait_time_score,
      service_speed_score,
      vehicle_cleanliness_score,
      additional_services_experience_score,
      value_score,
      team_friendliness_score,
      questionnaire_version,
      questionnaire_submitted_at
    ) values (
      'PGTAP-COMPLETE-ORDER',
      'FAKE-LOC-001',
      2,
      1,
      2,
      3,
      4,
      5,
      4,
      1,
      '2026-01-03T12:00:00Z'
    )
  $sql$,
  'a complete six-score questionnaire is accepted'
);

select ok(
  (
    select row(
      wait_time_score,
      service_speed_score,
      vehicle_cleanliness_score,
      additional_services_experience_score,
      value_score,
      team_friendliness_score,
      questionnaire_version
    ) = row(1::smallint, 2::smallint, 3::smallint, 4::smallint, 5::smallint, 4::smallint, 1::smallint)
    from public.surveys
    where order_id = 'PGTAP-COMPLETE-ORDER'
  ),
  'all complete questionnaire values are stored unchanged'
);

select throws_like(
  $sql$
    insert into public.surveys (
      order_id,
      location_id,
      wait_time_score,
      service_speed_score,
      vehicle_cleanliness_score,
      additional_services_experience_score,
      value_score,
      team_friendliness_score,
      questionnaire_version,
      questionnaire_submitted_at
    ) values (
      'PGTAP-OUT-OF-RANGE-ORDER',
      'FAKE-LOC-001',
      0,
      2,
      3,
      4,
      5,
      4,
      1,
      now()
    )
  $sql$,
  '%surveys_wait_time_score_range%',
  'scores below 1 are rejected'
);

select throws_like(
  $sql$
    insert into public.surveys (
      order_id,
      location_id,
      wait_time_score,
      service_speed_score,
      vehicle_cleanliness_score,
      additional_services_experience_score,
      value_score,
      team_friendliness_score,
      questionnaire_version,
      questionnaire_submitted_at
    ) values (
      'PGTAP-OUT-OF-RANGE-HIGH-ORDER',
      'FAKE-LOC-001',
      1,
      2,
      3,
      4,
      5,
      6,
      1,
      now()
    )
  $sql$,
  '%surveys_team_friendliness_score_range%',
  'scores above 5 are rejected'
);

select throws_like(
  $sql$
    insert into public.surveys (
      order_id,
      location_id,
      wait_time_score
    ) values (
      'PGTAP-PARTIAL-ORDER',
      'FAKE-LOC-001',
      3
    )
  $sql$,
  '%surveys_questionnaire_all_or_none%',
  'partial questionnaires are rejected'
);

select is(
  (
    select relrowsecurity
    from pg_catalog.pg_class
    where oid = 'public.surveys'::regclass
  ),
  true,
  'RLS is enabled on surveys'
);

select is(
  (
    select relrowsecurity
    from pg_catalog.pg_class
    where oid = 'public.locations'::regclass
  ),
  true,
  'RLS is enabled on locations'
);

select is(
  (
    select count(*)::integer
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename in ('locations', 'surveys')
  ),
  0,
  'no client-facing RLS policies exist'
);

set local role anon;

select throws_like(
  $sql$select count(*) from public.surveys$sql$,
  '%permission denied for table surveys%',
  'anonymous clients cannot read surveys'
);

select throws_like(
  $sql$select count(*) from public.locations$sql$,
  '%permission denied for table locations%',
  'anonymous clients cannot read locations'
);

select throws_like(
  $sql$
    insert into public.surveys (
      order_id,
      location_id
    ) values (
      'PGTAP-ANON-ORDER',
      'FAKE-LOC-001'
    )
  $sql$,
  '%permission denied for table surveys%',
  'anonymous clients cannot insert surveys'
);

reset role;

select is(
  has_table_privilege('anon', 'public.surveys', 'UPDATE'),
  false,
  'anonymous clients have no survey update privilege'
);

select is(
  has_table_privilege('anon', 'public.surveys', 'DELETE'),
  false,
  'anonymous clients have no survey delete privilege'
);

select is(
  has_table_privilege('authenticated', 'public.surveys', 'UPDATE'),
  false,
  'authenticated clients have no survey update privilege'
);

select is(
  has_table_privilege('authenticated', 'public.surveys', 'DELETE'),
  false,
  'authenticated clients have no survey delete privilege'
);

set local role authenticated;

select throws_like(
  $sql$select count(*) from public.surveys$sql$,
  '%permission denied for table surveys%',
  'authenticated clients cannot read surveys'
);

select throws_like(
  $sql$
    insert into public.surveys (
      order_id,
      location_id
    ) values (
      'PGTAP-AUTHENTICATED-ORDER',
      'FAKE-LOC-001'
    )
  $sql$,
  '%permission denied for table surveys%',
  'authenticated clients cannot insert surveys'
);

reset role;

set local role service_role;

select ok(
  (select count(*) > 0 from public.surveys),
  'the server service role retains survey access'
);

select lives_ok(
  $sql$
    insert into public.surveys (
      order_id,
      location_id
    ) values (
      'PGTAP-SERVICE-ROLE-ORDER',
      'FAKE-LOC-001'
    )
  $sql$,
  'the server service role can insert surveys'
);

select lives_ok(
  $sql$
    update public.surveys
    set rating = 4
    where order_id = 'PGTAP-SERVICE-ROLE-ORDER'
  $sql$,
  'the server service role can update surveys'
);

select lives_ok(
  $sql$
    delete from public.surveys
    where order_id = 'PGTAP-SERVICE-ROLE-ORDER'
  $sql$,
  'the server service role can delete surveys'
);

reset role;

select * from finish();
rollback;
