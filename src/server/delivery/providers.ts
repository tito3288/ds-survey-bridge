import 'server-only';

import {
  sendPrivateFeedbackEmail,
  validatePrivateFeedbackEmailConfiguration,
} from '@/lib/resend';
import {
  isSurveyScore,
  validateQuestionnaire,
} from '@/lib/questionnaire';
import { isSurveyToken } from '@/lib/survey-token';
import {
  sendSurveySMS,
  validateSurveySmsConfiguration,
} from '@/lib/twilio';
import type {
  DeliveryPayload,
  PrivateFeedbackEmailPayload,
  ProviderDeliveryResult,
  SurveySmsPayload,
} from '@/server/delivery/types';

type ErrorLike = {
  code?: unknown;
  name?: unknown;
  status?: unknown;
  statusCode?: unknown;
};

type ResendResponse = Awaited<ReturnType<typeof sendPrivateFeedbackEmail>>;

export interface DeliveryProviders {
  validateConfiguration(): void;
  validatePayload(payload: DeliveryPayload):
    | { ok: true }
    | { ok: false; errorCode: string };
  send(
    payload: DeliveryPayload,
    jobId: string,
    signal?: AbortSignal,
  ): Promise<ProviderDeliveryResult>;
}

export type DeliveryProviderDependencies = {
  sendSms: typeof sendSurveySMS;
  sendEmail: typeof sendPrivateFeedbackEmail;
  validateSmsConfiguration: typeof validateSurveySmsConfiguration;
  validateEmailConfiguration: typeof validatePrivateFeedbackEmailConfiguration;
};

const DEFAULT_DEPENDENCIES: DeliveryProviderDependencies = {
  sendSms: sendSurveySMS,
  sendEmail: sendPrivateFeedbackEmail,
  validateSmsConfiguration: validateSurveySmsConfiguration,
  validateEmailConfiguration: validatePrivateFeedbackEmailConfiguration,
};

const DEFINITE_PRE_SEND_NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
]);

const TRANSIENT_RESEND_ERROR_NAMES = new Set([
  'application_error',
  'concurrent_idempotent_requests',
  'internal_server_error',
  'rate_limit_exceeded',
]);

function asErrorLike(error: unknown): ErrorLike {
  return error && typeof error === 'object' ? (error as ErrorLike) : {};
}

function safeCode(value: unknown, fallback: string): string {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return fallback;
  }

  const normalized = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '_')
    .slice(0, 80);
  return normalized || fallback;
}

export function classifyTwilioError(error: unknown): ProviderDeliveryResult {
  const details = asErrorLike(error);
  const status =
    typeof details.status === 'number'
      ? details.status
      : typeof details.statusCode === 'number'
        ? details.statusCode
        : null;
  const providerCode = safeCode(details.code, 'twilio_error');
  const errorCode = status
    ? `twilio_${status}_${providerCode}`
    : `twilio_${providerCode}`;

  if (status === 429 || (status !== null && status >= 500)) {
    return { outcome: 'retry', errorCategory: 'provider', errorCode };
  }

  // A 408 can arrive after Twilio received part or all of the request. Treat
  // it as ambiguous so the customer is never texted twice.
  if (status === 408) {
    return { outcome: 'unknown', errorCategory: 'provider', errorCode };
  }

  if (status !== null && status >= 400 && status < 500) {
    return { outcome: 'dead', errorCategory: 'provider', errorCode };
  }

  if (
    typeof details.code === 'string' &&
    DEFINITE_PRE_SEND_NETWORK_CODES.has(details.code.toUpperCase())
  ) {
    return { outcome: 'retry', errorCategory: 'provider', errorCode };
  }

  // A socket/read timeout or an unrecognized exception can happen after
  // Twilio accepted the request. Conservatively stop instead of texting twice.
  return { outcome: 'unknown', errorCategory: 'provider', errorCode };
}

function classifyResendResolvedError(
  error: Exclude<ResendResponse['error'], null>,
): ProviderDeliveryResult {
  const name = safeCode(error.name, 'resend_error');
  const status = typeof error.statusCode === 'number' ? error.statusCode : null;
  const errorCode = status ? `resend_${status}_${name}` : `resend_${name}`;

  if (
    status === 429 ||
    (status !== null && status >= 500) ||
    TRANSIENT_RESEND_ERROR_NAMES.has(name)
  ) {
    return { outcome: 'retry', errorCategory: 'provider', errorCode };
  }

  return { outcome: 'dead', errorCategory: 'provider', errorCode };
}

function classifyResendThrownError(error: unknown): ProviderDeliveryResult {
  const details = asErrorLike(error);
  return {
    outcome: 'retry',
    errorCategory: 'provider',
    errorCode: `resend_${safeCode(details.code ?? details.name, 'network_error')}`,
  };
}

function validateSmsPayload(payload: SurveySmsPayload): boolean {
  return (
    isSurveyToken(payload.surveyToken) &&
    typeof payload.customerPhone === 'string' &&
    payload.customerPhone.trim().length > 0 &&
    (payload.customerName === null || typeof payload.customerName === 'string')
  );
}

function validateEmailPayload(payload: PrivateFeedbackEmailPayload): boolean {
  const questionnaire = validateQuestionnaire({
    answers: payload.answers,
    comment: payload.comment,
  });

  return (
    typeof payload.orderId === 'string' &&
    payload.orderId.trim().length > 0 &&
    typeof payload.locationId === 'string' &&
    payload.locationId.trim().length > 0 &&
    isSurveyScore(payload.rating) &&
    questionnaire.ok
  );
}

export function createDeliveryProviders(
  overrides: Partial<DeliveryProviderDependencies> = {},
): DeliveryProviders {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };

  return {
    validateConfiguration() {
      dependencies.validateSmsConfiguration();
      dependencies.validateEmailConfiguration();
    },

    validatePayload(payload) {
      const valid =
        payload.kind === 'survey_sms'
          ? validateSmsPayload(payload)
          : validateEmailPayload(payload);
      return valid
        ? { ok: true }
        : { ok: false, errorCode: 'invalid_delivery_payload' };
    },

    async send(payload, jobId, signal) {
      if (payload.kind === 'survey_sms') {
        try {
          const providerMessageId = await dependencies.sendSms({
            to: payload.customerPhone,
            customerName: payload.customerName,
            surveyToken: payload.surveyToken,
            deliveryJobId: jobId,
          });

          if (!providerMessageId) {
            return {
              outcome: 'unknown',
              errorCategory: 'provider',
              errorCode: 'twilio_missing_message_id',
            };
          }

          return { outcome: 'sent', providerMessageId };
        } catch (error) {
          return classifyTwilioError(error);
        }
      }

      try {
        const response = await dependencies.sendEmail(
          {
            orderId: payload.orderId,
            rating: payload.rating,
            answers: payload.answers,
            comment: payload.comment,
            locationId: payload.locationId,
            locationName: payload.locationName ?? undefined,
            customerName: payload.customerName ?? undefined,
            customerPhone: payload.customerPhone ?? undefined,
            services: payload.services,
          },
          {
            idempotencyKey: `private-feedback/${jobId}`,
            deliveryJobId: jobId,
            ...(signal ? { signal } : {}),
          },
        );

        if (response.error) {
          return classifyResendResolvedError(response.error);
        }

        const providerMessageId = response.data?.id;
        return providerMessageId
          ? { outcome: 'sent', providerMessageId }
          : {
              outcome: 'retry',
              errorCategory: 'provider',
              errorCode: 'resend_missing_message_id',
            };
      } catch (error) {
        // The stable idempotency key makes uncertain Resend responses safe to
        // retry throughout the configured (under 24-hour) retry window.
        return classifyResendThrownError(error);
      }
    },
  };
}
