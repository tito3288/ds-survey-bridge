-- 003_private_survey_tokens.sql
-- Give every survey a private, database-generated identifier for customer links.

alter table public.surveys
  add column survey_token uuid;

-- Generate a different token for each existing row. Historical ratings,
-- questionnaire answers, and flow-version values remain unchanged.
update public.surveys
set survey_token = gen_random_uuid()
where survey_token is null;

alter table public.surveys
  alter column survey_token set default gen_random_uuid(),
  alter column survey_token set not null,
  add constraint surveys_survey_token_key unique (survey_token);

-- Rows created by the private-link flow use version 2. Explicit historical
-- values, including null for pre-versioned records, are not backfilled.
alter table public.surveys
  alter column survey_flow_version set default 2;

comment on column public.surveys.survey_token is
  'Private, non-expiring UUID used in customer-facing survey links.';

comment on column public.surveys.survey_flow_version is
  'Version of the survey flow that created this row; null identifies pre-versioned legacy records. New rows default to private-token flow version 2.';
