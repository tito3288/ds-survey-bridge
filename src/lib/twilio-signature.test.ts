import twilio from 'twilio';
import { describe, expect, it, vi } from 'vitest';

describe('Twilio SDK signature integration', () => {
  it('validates an evolving form payload locally without contacting Twilio', async () => {
    vi.stubEnv('TWILIO_AUTH_TOKEN', 'fake-local-auth-token');
    const url =
      'https://survey.example.test/api/webhooks/twilio/message-status/10000000-0000-4000-8000-000000000123';
    const parameters = {
      AccountSid: `AC${'0'.repeat(32)}`,
      MessageSid: `SM${'a'.repeat(32)}`,
      MessageStatus: 'delivered',
      FutureParameter: ['second', 'first'],
    };
    const signature = twilio.getExpectedTwilioSignature(
      'fake-local-auth-token',
      url,
      parameters,
    );
    const { validateTwilioStatusCallbackSignature } = await import('./twilio');

    expect(
      validateTwilioStatusCallbackSignature({
        signature,
        url,
        formParameters: parameters,
      }),
    ).toBe(true);
  });
});
