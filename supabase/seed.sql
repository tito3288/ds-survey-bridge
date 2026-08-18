-- Local development data only. Every identity, order, location, and URL below
-- is intentionally fictional and must never be used for customer messaging.

insert into public.locations (
  id,
  droptop_location_id,
  name,
  google_review_url
)
values (
  '00000000-0000-4000-8000-000000000001',
  'FAKE-LOC-001',
  'Fake Training Location',
  'https://example.com/fake-review-location'
)
on conflict (droptop_location_id) do nothing;

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
  created_at,
  survey_flow_version
)
values (
  '00000000-0000-4000-8000-000000000002',
  'FAKE-LEGACY-ORDER-001',
  'FAKE-LOC-001',
  '+13175550100',
  'Fake Legacy Customer',
  '[{"name":"Fake Oil Change"}]'::jsonb,
  2,
  'Fictional legacy feedback used only for local development.',
  '2026-01-01T12:00:00Z',
  '2026-01-01T12:05:00Z',
  '2026-01-01T11:55:00Z',
  null
)
on conflict (order_id) do nothing;

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
  created_at,
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
  '00000000-0000-4000-8000-000000000003',
  'FAKE-QUESTIONNAIRE-ORDER-001',
  'FAKE-LOC-001',
  '+13175550101',
  'Fake Questionnaire Customer',
  '[{"name":"Fake Full-Service Oil Change"}]'::jsonb,
  1,
  null,
  '2026-01-02T12:00:00Z',
  '2026-01-02T12:10:00Z',
  '2026-01-02T11:55:00Z',
  2,
  3,
  5,
  4,
  3,
  5,
  1,
  '2026-01-02T12:10:00Z'
)
on conflict (order_id) do nothing;
