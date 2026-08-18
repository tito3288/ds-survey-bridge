import 'server-only';

import twilio from 'twilio';
import { getRequiredEnv } from '@/lib/env';
import { isSurveyToken } from '@/lib/survey-token';

let twilioClient: ReturnType<typeof twilio> | undefined;

export const TWILIO_STATUS_CALLBACK_PATH =
  '/api/webhooks/twilio/message-status';
export const TWILIO_STATUS_CALLBACK_RETRY_FRAGMENT =
  '#rc=3&rp=ct,rt,5xx';

export const TWILIO_OUTBOUND_MESSAGE_STATUSES = [
  'accepted',
  'scheduled',
  'queued',
  'sending',
  'sent',
  'delivered',
  'partially_delivered',
  'undelivered',
  'failed',
  'canceled',
  'read',
] as const;

export type TwilioOutboundMessageStatus =
  (typeof TWILIO_OUTBOUND_MESSAGE_STATUSES)[number];

const TWILIO_OUTBOUND_STATUS_SET = new Set<string>(
  TWILIO_OUTBOUND_MESSAGE_STATUSES,
);
const DELIVERY_JOB_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TWILIO_MESSAGE_SID_PATTERN = /^(SM|MM)[0-9a-f]{32}$/i;
const TWILIO_ERROR_CODE_PATTERN = /^\d{1,10}$/;

// Keep the SDK request inside the worker's 60-second provider fence. A
// transport timeout is still treated as an ambiguous outcome, so the job is
// marked unknown instead of risking a duplicate customer text.
export const TWILIO_REQUEST_TIMEOUT_MS = 30_000;

function getTwilioClient(): ReturnType<typeof twilio> {
  if (!twilioClient) {
    twilioClient = twilio(
      getRequiredEnv('TWILIO_ACCOUNT_SID'),
      getRequiredEnv('TWILIO_AUTH_TOKEN'),
      {
        autoRetry: false,
        timeout: TWILIO_REQUEST_TIMEOUT_MS,
      },
    );
  }

  return twilioClient;
}

export function getAppOrigin(): string {
  const configuredUrl = getRequiredEnv('APP_URL');
  let parsedUrl: URL;

  try {
    parsedUrl = new URL(configuredUrl);
  } catch {
    throw new Error(
      'Invalid APP_URL: expected an HTTPS origin without a path, query, fragment, or credentials',
    );
  }

  const isLocalHttp =
    process.env.NODE_ENV !== 'production' &&
    parsedUrl.protocol === 'http:' &&
    (parsedUrl.hostname === 'localhost' || parsedUrl.hostname === '127.0.0.1');
  const isHttps = parsedUrl.protocol === 'https:';
  const isExactOrigin =
    configuredUrl === parsedUrl.origin ||
    configuredUrl === `${parsedUrl.origin}/`;

  if (
    (!isHttps && !isLocalHttp) ||
    parsedUrl.username ||
    parsedUrl.password ||
    parsedUrl.pathname !== '/' ||
    parsedUrl.search ||
    parsedUrl.hash ||
    !isExactOrigin
  ) {
    throw new Error(
      'Invalid APP_URL: expected an HTTPS origin without a path, query, fragment, or credentials',
    );
  }

  return parsedUrl.origin;
}

export function isDeliveryJobId(value: unknown): value is string {
  return typeof value === 'string' && DELIVERY_JOB_ID_PATTERN.test(value);
}

export function isTwilioMessageSid(value: unknown): value is string {
  return typeof value === 'string' && TWILIO_MESSAGE_SID_PATTERN.test(value);
}

export function normalizeTwilioMessageStatus(
  status: unknown,
  errorCode: unknown,
): { status: TwilioOutboundMessageStatus; errorCode: string | null } | null {
  if (
    typeof status !== 'string' ||
    !TWILIO_OUTBOUND_STATUS_SET.has(status)
  ) {
    return null;
  }

  let normalizedErrorCode: string | null = null;
  if (errorCode !== null && errorCode !== undefined && errorCode !== '') {
    const candidate = String(errorCode);
    if (!TWILIO_ERROR_CODE_PATTERN.test(candidate)) {
      return null;
    }
    normalizedErrorCode = candidate;
  }

  return {
    status: status as TwilioOutboundMessageStatus,
    errorCode: normalizedErrorCode,
  };
}

export function getTwilioStatusCallbackUrl(
  deliveryJobId: string,
  includeRetryFragment = false,
): string {
  if (!isDeliveryJobId(deliveryJobId)) {
    throw new Error('Invalid delivery job id');
  }

  const callbackUrl = `${getAppOrigin()}${TWILIO_STATUS_CALLBACK_PATH}/${deliveryJobId}`;
  return includeRetryFragment
    ? `${callbackUrl}${TWILIO_STATUS_CALLBACK_RETRY_FRAGMENT}`
    : callbackUrl;
}

export function validateTwilioStatusCallbackSignature(params: {
  signature: string;
  url: string;
  formParameters: Record<string, string | string[]>;
}): boolean {
  return twilio.validateRequest(
    getRequiredEnv('TWILIO_AUTH_TOKEN'),
    params.signature,
    params.url,
    params.formParameters,
  );
}

export function validateSurveySmsConfiguration(): void {
  const accountSid = getRequiredEnv('TWILIO_ACCOUNT_SID');
  getRequiredEnv('TWILIO_AUTH_TOKEN');
  const phoneNumber = getRequiredEnv('TWILIO_PHONE_NUMBER');
  if (!/^AC[0-9a-f]{32}$/i.test(accountSid)) {
    throw new Error('TWILIO_ACCOUNT_SID is invalid');
  }
  if (!/^\+[1-9]\d{7,14}$/.test(phoneNumber)) {
    throw new Error('TWILIO_PHONE_NUMBER must use E.164 format');
  }
  getAppOrigin();
}

export async function sendSurveySMS(params: {
  to: string;
  customerName?: string | null;
  surveyToken: string;
  deliveryJobId: string;
}): Promise<string> {
  const { to, customerName, surveyToken, deliveryJobId } = params;

  if (!isSurveyToken(surveyToken)) {
    throw new Error('Invalid survey token');
  }

  const greeting =
    customerName && customerName.trim().length > 0
      ? `Hi ${customerName.trim()}!`
      : 'Hi there!';

  const surveyUrl = `${getAppOrigin()}/survey/${encodeURIComponent(surveyToken)}`;
  const body = `${greeting} Thanks for visiting Drive & Shine today. How was your oil change? Tap to rate: ${surveyUrl} — Drive & Shine`;
  const statusCallback = getTwilioStatusCallbackUrl(deliveryJobId, true);

  const message = await getTwilioClient().messages.create({
    body,
    from: getRequiredEnv('TWILIO_PHONE_NUMBER'),
    statusCallback,
    to,
  });

  return message.sid;
}

export async function fetchSurveySmsStatus(
  messageSid: string,
): Promise<{ status: TwilioOutboundMessageStatus; errorCode: string | null }> {
  if (!isTwilioMessageSid(messageSid)) {
    throw new Error('Invalid Twilio message SID');
  }

  const message = await getTwilioClient().messages(messageSid).fetch();
  const normalized = normalizeTwilioMessageStatus(
    message.status,
    message.errorCode,
  );
  if (!normalized) {
    throw new Error('Invalid Twilio message status');
  }

  return normalized;
}
