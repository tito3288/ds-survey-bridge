import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import { getRequiredEnv } from '@/lib/env';
import {
  isSurveyScore,
  validateQuestionnaire,
} from '@/lib/questionnaire';
import { isSurveyToken } from '@/lib/survey-token';
import { getSupabaseAdmin } from '@/lib/supabase';
import type {
  DeliveryRepository,
  DeliveryRetryResult,
} from '@/server/delivery/repository';
import type {
  ClaimedDeliveryJob,
  DeliveryPayloadLoadResult,
} from '@/server/delivery/types';
import type { Database } from '@/types/database';

type AdminClient = SupabaseClient<Database>;

export class DeliveryRepositoryError extends Error {
  constructor() {
    super('Delivery repository operation failed');
    this.name = 'DeliveryRepositoryError';
  }
}

function validateDatabaseConfiguration(
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  const configuredUrl = getRequiredEnv('NEXT_PUBLIC_SUPABASE_URL', env);
  getRequiredEnv('SUPABASE_SERVICE_ROLE_KEY', env);

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(configuredUrl);
  } catch {
    throw new Error('Invalid Supabase URL');
  }

  const isLocalHttp =
    process.env.NODE_ENV !== 'production' &&
    parsedUrl.protocol === 'http:' &&
    (parsedUrl.hostname === 'localhost' || parsedUrl.hostname === '127.0.0.1');
  const isExactOrigin =
    configuredUrl === parsedUrl.origin ||
    configuredUrl === `${parsedUrl.origin}/`;
  if (
    (parsedUrl.protocol !== 'https:' && !isLocalHttp) ||
    parsedUrl.username ||
    parsedUrl.password ||
    parsedUrl.pathname !== '/' ||
    parsedUrl.search ||
    parsedUrl.hash ||
    !isExactOrigin
  ) {
    throw new Error('Invalid Supabase URL');
  }
}

function repositoryFailure(): never {
  throw new DeliveryRepositoryError();
}

export function createSupabaseDeliveryRepository(
  getClient: () => AdminClient = getSupabaseAdmin,
): DeliveryRepository {
  return {
    validateConfiguration() {
      validateDatabaseConfiguration();
    },

    async claimDueJobs(input) {
      const { data, error } = await getClient().rpc('claim_delivery_jobs', {
        p_run_id: input.runId,
        p_limit: input.limit,
        p_lease_seconds: input.leaseSeconds,
        p_now: input.now,
      });
      if (error || !data) repositoryFailure();

      return data.map((row): ClaimedDeliveryJob => {
        if (!row.lease_token) repositoryFailure();
        return {
          id: row.id,
          surveyId: row.survey_id,
          kind: row.kind,
          attemptCount: row.attempt_count,
          leaseToken: row.lease_token,
        };
      });
    },

    async loadPayload(job): Promise<DeliveryPayloadLoadResult> {
      const { data: survey, error: surveyError } = await getClient()
        .from('surveys')
        .select(
          'order_id, location_id, customer_phone, customer_name, services, survey_token, rating, comment, wait_time_score, service_speed_score, vehicle_cleanliness_score, additional_services_experience_score, value_score, team_friendliness_score',
        )
        .eq('id', job.surveyId)
        .maybeSingle();

      if (surveyError) {
        return {
          ok: false,
          disposition: 'retry',
          errorCategory: 'payload',
          errorCode: 'survey_read_failed',
        };
      }
      if (!survey) {
        return {
          ok: false,
          disposition: 'dead',
          errorCategory: 'payload',
          errorCode: 'survey_not_found',
        };
      }

      if (job.kind === 'survey_sms') {
        if (!survey.customer_phone || !isSurveyToken(survey.survey_token)) {
          return {
            ok: false,
            disposition: 'dead',
            errorCategory: 'payload',
            errorCode: 'invalid_sms_payload',
          };
        }

        return {
          ok: true,
          payload: {
            kind: 'survey_sms',
            surveyToken: survey.survey_token,
            customerPhone: survey.customer_phone,
            customerName: survey.customer_name,
          },
        };
      }

      const questionnaire = validateQuestionnaire({
        answers: {
          waitTime: survey.wait_time_score,
          serviceSpeed: survey.service_speed_score,
          vehicleCleanliness: survey.vehicle_cleanliness_score,
          additionalServicesExperience:
            survey.additional_services_experience_score,
          value: survey.value_score,
          teamFriendliness: survey.team_friendliness_score,
        },
        comment: survey.comment,
      });
      if (!isSurveyScore(survey.rating) || !questionnaire.ok) {
        return {
          ok: false,
          disposition: 'dead',
          errorCategory: 'payload',
          errorCode: 'invalid_email_payload',
        };
      }

      const { data: location } = await getClient()
        .from('locations')
        .select('name')
        .eq('droptop_location_id', survey.location_id)
        .maybeSingle();

      return {
        ok: true,
        payload: {
          kind: 'private_feedback_email',
          orderId: survey.order_id,
          rating: survey.rating,
          answers: questionnaire.value.answers,
          comment: questionnaire.value.comment,
          locationId: survey.location_id,
          locationName: location?.name ?? null,
          customerName: survey.customer_name,
          customerPhone: survey.customer_phone,
          services: survey.services,
        },
      };
    },

    async markProviderStarted(input) {
      const { data, error } = await getClient()
        .rpc('mark_delivery_job_provider_started', {
          p_job_id: input.jobId,
          p_lease_token: input.leaseToken,
          p_started_at: input.startedAt,
        })
        .single();
      if (error || !data) repositoryFailure();
      return {
        started: data.started,
        attemptCount: data.attempt_count,
      };
    },

    async markSent(input) {
      const { data, error } = await getClient().rpc(
        'mark_delivery_job_sent',
        {
          p_job_id: input.jobId,
          p_lease_token: input.leaseToken,
          p_provider_message_id: input.providerMessageId,
          p_accepted_at: input.acceptedAt,
        },
      );
      if (error) repositoryFailure();
      return data === true;
    },

    async markRetry(input): Promise<DeliveryRetryResult> {
      const { data, error } = await getClient()
        .rpc('mark_delivery_job_retry', {
          p_job_id: input.jobId,
          p_lease_token: input.leaseToken,
          p_error_category: input.errorCategory,
          p_error_code: input.errorCode,
          p_failed_at: input.failedAt,
        })
        .single();
      if (
        error ||
        !data ||
        (data.status !== 'pending' && data.status !== 'dead')
      ) {
        repositoryFailure();
      }
      return {
        status: data.status,
        nextAttemptAt: data.status === 'dead' ? null : data.next_attempt_at,
        attemptCount: data.attempt_count,
      };
    },

    async markDead(input) {
      const { data, error } = await getClient().rpc(
        'mark_delivery_job_dead',
        {
          p_job_id: input.jobId,
          p_lease_token: input.leaseToken,
          p_error_category: input.errorCategory,
          p_error_code: input.errorCode,
          p_failed_at: input.failedAt,
        },
      );
      if (error) repositoryFailure();
      return data === true;
    },

    async markUnknown(input) {
      const { data, error } = await getClient().rpc(
        'mark_delivery_job_unknown',
        {
          p_job_id: input.jobId,
          p_lease_token: input.leaseToken,
          p_error_category: input.errorCategory,
          p_error_code: input.errorCode,
          p_failed_at: input.failedAt,
        },
      );
      if (error) repositoryFailure();
      return data === true;
    },
  };
}
