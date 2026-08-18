-- These fictional rows are inserted after migration 002 and before migration
-- 003. They verify that private-token backfilling preserves existing versions.
insert into public.surveys (
  id,
  order_id,
  location_id,
  customer_phone,
  customer_name,
  services,
  rating,
  comment,
  responded_at,
  created_at,
  survey_flow_version
)
values
  (
    '00000000-0000-4000-8000-000000000091',
    'FAKE-PRE-003-VERSIONED-ORDER',
    'FAKE-PRE-003-LOCATION',
    '+13175550191',
    'Fake Versioned Customer',
    '[{"name":"Fake Oil Change"}]'::jsonb,
    4,
    'Fictional versioned feedback created before migration 003.',
    '2026-01-11T12:05:00Z',
    '2026-01-11T11:55:00Z',
    1
  ),
  (
    '00000000-0000-4000-8000-000000000092',
    'FAKE-PRE-003-LEGACY-ORDER',
    'FAKE-PRE-003-LOCATION',
    '+13175550192',
    'Fake Legacy Customer',
    '[{"name":"Fake Oil Change"}]'::jsonb,
    2,
    'Fictional legacy feedback created before migration 003.',
    '2026-01-11T13:05:00Z',
    '2026-01-11T12:55:00Z',
    null
  );
