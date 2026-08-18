-- Fictional rows created after migration 003 and before the durable delivery
-- queue exists. Migration 004 must preserve them and must not infer jobs.

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
values (
  '00000000-0000-4000-8000-000000000081',
  'FAKE-PRE-004-RATING-ORDER',
  'FAKE-PRE-004-LOCATION',
  '+13175550181',
  'Fake Pre Queue Customer',
  '[{"name":"Fake Oil Change"}]'::jsonb,
  2,
  'Fictional feedback created before migration 004.',
  '2026-01-12T12:05:00Z',
  '2026-01-12T11:55:00Z',
  2
);

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
  survey_flow_version,
  wait_time_score,
  service_speed_score,
  vehicle_cleanliness_score,
  additional_services_experience_score,
  value_score,
  team_friendliness_score,
  questionnaire_version,
  questionnaire_submitted_at
)
values (
  '00000000-0000-4000-8000-000000000082',
  'FAKE-PRE-004-COMPLETE-ORDER',
  'FAKE-PRE-004-LOCATION',
  '+13175550182',
  'Fake Completed Customer',
  '[{"name":"Fake Full-Service Oil Change"}]'::jsonb,
  1,
  null,
  '2026-01-12T13:05:00Z',
  '2026-01-12T12:55:00Z',
  2,
  2,
  3,
  4,
  5,
  3,
  4,
  1,
  '2026-01-12T13:10:00Z'
);
