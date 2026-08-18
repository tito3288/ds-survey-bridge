import 'server-only';

import twilio from 'twilio';
import { getRequiredEnv } from '@/lib/env';

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

export async function sendSurveySMS(params: {
  to: string;
  customerName?: string | null;
  orderId: string;
}): Promise<string> {
  const { to, customerName, orderId } = params;

  const greeting =
    customerName && customerName.trim().length > 0
      ? `Hi ${customerName.trim()}!`
      : 'Hi there!';

  const surveyUrl = `${getRequiredEnv('APP_URL')}/survey/${orderId}`;
  const body = `${greeting} Thanks for visiting Drive & Shine today. How was your oil change? Tap to rate: ${surveyUrl} — Drive & Shine`;

  const message = await getTwilioClient().messages.create({
    body,
    from: getRequiredEnv('TWILIO_PHONE_NUMBER'),
    to,
  });

  return message.sid;
}
