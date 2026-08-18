import { describe, expect, it } from 'vitest';
import { Webhook } from 'svix';

import { verifyResendWebhook } from './resend-webhook';

describe('Resend webhook verification', () => {
  it('cryptographically verifies the untouched raw body using only the webhook secret', () => {
    const payload = '{"type":"email.delivered",  "data":{}}\n';
    const secret = `whsec_${Buffer.from('fake-local-signing-secret').toString('base64')}`;
    const id = 'msg_fake';
    const now = new Date();
    const signature = new Webhook(secret).sign(id, now, payload);

    expect(
      verifyResendWebhook(
        payload,
        {
          id,
          timestamp: String(Math.floor(now.getTime() / 1_000)),
          signature,
        },
        secret,
      ),
    ).toEqual({ type: 'email.delivered', data: {} });

    expect(() =>
      verifyResendWebhook(
        `${payload} `,
        {
          id,
          timestamp: String(Math.floor(now.getTime() / 1_000)),
          signature,
        },
        secret,
      ),
    ).toThrow();

    const stale = new Date(now.getTime() - 10 * 60 * 1_000);
    const staleSignature = new Webhook(secret).sign(id, stale, payload);
    expect(() =>
      verifyResendWebhook(
        payload,
        {
          id,
          timestamp: String(Math.floor(stale.getTime() / 1_000)),
          signature: staleSignature,
        },
        secret,
      ),
    ).toThrow();
  });
});
