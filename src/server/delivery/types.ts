import type { QuestionnaireAnswers, SurveyScore } from '@/lib/questionnaire';
import type { Json } from '@/types/database';

export const DELIVERY_BATCH_SIZE = 20;
export const DELIVERY_CONCURRENCY = 5;
export const DELIVERY_LEASE_SECONDS = 10 * 60;
export const DELIVERY_RUN_DEADLINE_MS = 4 * 60 * 1_000;
export const DELIVERY_PROVIDER_TIMEOUT_MS = 60 * 1_000;
export const DELIVERY_MAX_ATTEMPTS = 6;
export const DELIVERY_RETRY_GAPS_MINUTES = [5, 15, 60, 240, 720] as const;

export type DeliveryKind = 'survey_sms' | 'private_feedback_email';

export type ClaimedDeliveryJob = {
  id: string;
  surveyId: string;
  kind: DeliveryKind;
  attemptCount: number;
  leaseToken: string;
};

export type SurveySmsPayload = {
  kind: 'survey_sms';
  surveyToken: string;
  customerPhone: string;
  customerName: string | null;
};

export type PrivateFeedbackEmailPayload = {
  kind: 'private_feedback_email';
  orderId: string;
  rating: SurveyScore;
  answers: QuestionnaireAnswers;
  comment: string | null;
  locationId: string;
  locationName: string | null;
  customerName: string | null;
  customerPhone: string | null;
  services: Json | null;
};

export type DeliveryPayload = SurveySmsPayload | PrivateFeedbackEmailPayload;

export type DeliveryPayloadLoadResult =
  | { ok: true; payload: DeliveryPayload }
  | {
      ok: false;
      disposition: 'retry' | 'dead';
      errorCategory: 'payload';
      errorCode: string;
    };

export type ProviderDeliveryResult =
  | {
      outcome: 'sent';
      providerMessageId: string;
    }
  | {
      outcome: 'retry' | 'dead' | 'unknown';
      errorCategory: 'provider';
      errorCode: string;
    };

export type DeliveryWorkerLog = {
  runId: string;
  jobId?: string;
  surveyId?: string;
  channel?: DeliveryKind;
  attempt?: number;
  outcome: string;
  durationMs?: number;
  providerCode?: string;
  errorCode?: string;
};
