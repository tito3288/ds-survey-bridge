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
      'FAKE-PRE-003-VERSIONED-ORDER',
      'FAKE-PRE-003-LEGACY-ORDER'
    )
  ),
  2::bigint,
  'all surveys created before migration 003 survive'
);

select is(
  (
    select rating
    from public.surveys
    where order_id = 'FAKE-PRE-003-VERSIONED-ORDER'
  ),
  4,
  'migration 003 preserves existing ratings'
);

select is(
  (
    select comment
    from public.surveys
    where order_id = 'FAKE-PRE-003-LEGACY-ORDER'
  ),
  'Fictional legacy feedback created before migration 003.',
  'migration 003 preserves existing comments'
);

select is(
  (
    select survey_flow_version
    from public.surveys
    where order_id = 'FAKE-PRE-003-VERSIONED-ORDER'
  ),
  1::smallint,
  'migration 003 preserves flow version 1'
);

select is(
  (
    select survey_flow_version
    from public.surveys
    where order_id = 'FAKE-PRE-003-LEGACY-ORDER'
  ),
  null::smallint,
  'migration 003 preserves an explicit legacy null flow version'
);

select is(
  (
    select count(*)
    from public.surveys
    where order_id in (
      'FAKE-PRE-003-VERSIONED-ORDER',
      'FAKE-PRE-003-LEGACY-ORDER'
    )
      and survey_token is not null
  ),
  2::bigint,
  'migration 003 backfills every existing survey token'
);

select is(
  (
    select count(distinct survey_token)
    from public.surveys
    where order_id in (
      'FAKE-PRE-003-VERSIONED-ORDER',
      'FAKE-PRE-003-LEGACY-ORDER'
    )
  ),
  2::bigint,
  'backfilled survey tokens are unique'
);

select lives_ok(
  $sql$
    insert into public.surveys (order_id, location_id)
    values ('FAKE-POST-003-ORDER', 'FAKE-PRE-003-LOCATION')
  $sql$,
  'a post-migration survey can rely on database defaults'
);

select ok(
  (
    select survey_token is not null
    from public.surveys
    where order_id = 'FAKE-POST-003-ORDER'
  ),
  'new surveys receive a database-generated token'
);

select is(
  (
    select survey_flow_version
    from public.surveys
    where order_id = 'FAKE-POST-003-ORDER'
  ),
  2::smallint,
  'new surveys default to flow version 2'
);

select * from finish();
rollback;
