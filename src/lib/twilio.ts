import 'server-only';

import twilio from 'twilio';
import { getRequiredEnv } from '@/lib/env';
import { isSurveyToken } from '@/lib/survey-token';

let twilioClient: ReturnType<typeof twilio> | undefined;

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

function getAppOrigin(): string {
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
}): Promise<string> {
  const { to, customerName, surveyToken } = params;

  if (!isSurveyToken(surveyToken)) {
    throw new Error('Invalid survey token');
  }

  const greeting =
    customerName && customerName.trim().length > 0
      ? `Hi ${customerName.trim()}!`
      : 'Hi there!';

  const surveyUrl = `${getAppOrigin()}/survey/${encodeURIComponent(surveyToken)}`;
  const body = `${greeting} Thanks for visiting Drive & Shine today. How was your oil change? Tap to rate: ${surveyUrl} — Drive & Shine`;

  const message = await getTwilioClient().messages.create({
    body,
    from: getRequiredEnv('TWILIO_PHONE_NUMBER'),
    to,
  });

  return message.sid;
}
