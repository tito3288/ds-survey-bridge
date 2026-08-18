import 'server-only';

import twilio from 'twilio';
import { getRequiredEnv } from '@/lib/env';
import { isSurveyToken } from '@/lib/survey-token';

let twilioClient: ReturnType<typeof twilio> | undefined;

function getTwilioClient(): ReturnType<typeof twilio> {
  if (!twilioClient) {
    twilioClient = twilio(
      getRequiredEnv('TWILIO_ACCOUNT_SID'),
      getRequiredEnv('TWILIO_AUTH_TOKEN'),
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
