import 'server-only';

import { Webhook } from 'svix';

export const RESEND_APP_TAG_VALUE = 'ds-survey-bridge';

export type ResendWebhookHeaders = {
  id: string;
  timestamp: string;
  signature: string;
};

export function verifyResendWebhook(
  payload: string,
  headers: ResendWebhookHeaders,
  webhookSecret: string,
): unknown {
  return new Webhook(webhookSecret).verify(payload, {
    'svix-id': headers.id,
    'svix-timestamp': headers.timestamp,
    'svix-signature': headers.signature,
  });
}
