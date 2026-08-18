-- 002_questionnaire_foundation.sql
-- Add the private service questionnaire fields without changing legacy rows.

alter table public.surveys
  add column wait_time_score smallint,
  add column service_speed_score smallint,
  add column vehicle_cleanliness_score smallint,
  add column additional_services_experience_score smallint,
  add column value_score smallint,
  add column team_friendliness_score smallint,
  add column survey_flow_version smallint,
  add column questionnaire_version smallint,
  add column questionnaire_submitted_at timestamptz;

alter table public.surveys
  add constraint surveys_wait_time_score_range
    check (wait_time_score between 1 and 5),
  add constraint surveys_service_speed_score_range
    check (service_speed_score between 1 and 5),
  add constraint surveys_vehicle_cleanliness_score_range
    check (vehicle_cleanliness_score between 1 and 5),
  add constraint surveys_additional_services_experience_score_range
    check (additional_services_experience_score between 1 and 5),
  add constraint surveys_value_score_range
    check (value_score between 1 and 5),
  add constraint surveys_team_friendliness_score_range
    check (team_friendliness_score between 1 and 5),
  add constraint surveys_flow_version_positive
    check (survey_flow_version >= 1),
  add constraint surveys_questionnaire_version_positive
    check (questionnaire_version >= 1),
  add constraint surveys_questionnaire_all_or_none
    check (
      (
        wait_time_score is null
        and service_speed_score is null
        and vehicle_cleanliness_score is null
        and additional_services_experience_score is null
        and value_score is null
        and team_friendliness_score is null
        and questionnaire_version is null
        and questionnaire_submitted_at is null
      )
      or
      (
        wait_time_score is not null
        and service_speed_score is not null
        and vehicle_cleanliness_score is not null
        and additional_services_experience_score is not null
        and value_score is not null
        and team_friendliness_score is not null
        and questionnaire_version is not null
        and questionnaire_submitted_at is not null
      )
    );

-- Existing rows remain null and are therefore identifiable as pre-versioned
-- legacy records. Rows created after this migration receive flow version 1.
alter table public.surveys
  alter column survey_flow_version set default 1;

-- Supabase service-role requests bypass RLS. With RLS enabled and no public
-- policies, anon/authenticated clients cannot read or write either table.
alter table public.locations enable row level security;
alter table public.surveys enable row level security;

revoke all privileges on public.locations, public.surveys from anon, authenticated;

-- Make server access explicit instead of relying on project-wide default
-- privileges. The service_role has BYPASSRLS in Supabase; client roles do not.
grant usage on schema public to service_role;
grant select, insert, update, delete on public.locations, public.surveys to service_role;

comment on column public.surveys.questionnaire_version is
  'Version of the completed private-service questionnaire; null for legacy or incomplete responses.';

comment on column public.surveys.survey_flow_version is
  'Version of the survey flow that created this row; null identifies pre-versioned legacy records.';

comment on column public.surveys.questionnaire_submitted_at is
  'Time the complete private-service questionnaire was submitted; null for legacy responses.';
