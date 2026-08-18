-- This row is inserted after migration 001 and before migration 002 by the
-- upgrade-path test. It is fictional and never leaves the local database.
insert into public.surveys (
  id,
  order_id,
  location_id,
  customer_phone,
  customer_name,
  services,
  rating,
  comment,
  sent_at,
  responded_at,
  created_at
)
values (
  '00000000-0000-4000-8000-000000000099',
  'FAKE-PRE-002-ORDER',
  'FAKE-PRE-002-LOCATION',
  '+13175550199',
  'Fake Pre-Migration Customer',
  '[{"name":"Fake Oil Change"}]'::jsonb,
  2,
  'Fictional feedback created before migration 002.',
  '2026-01-10T12:00:00Z',
  '2026-01-10T12:05:00Z',
  '2026-01-10T11:55:00Z'
);
