import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  validateSignature: vi.fn(),
  recordEvent: vi.fn(),
}));

vi.mock('@/lib/twilio', () => ({
  getTwilioStatusCallbackUrl: (jobId: string) =>
    `https://survey.example.test/api/webhooks/twilio/message-status/${jobId}`,
  isDeliveryJobId: (value: unknown) =>
    typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value),
  isTwilioMessageSid: (value: unknown) =>
    typeof value === 'string' && /^(SM|MM)[0-9a-f]{32}$/i.test(value),
  normalizeTwilioMessageStatus: (status: unknown, errorCode: unknown) => {
    const known = new Set([
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
    ]);
    if (typeof status !== 'string' || !known.has(status)) return null;
    if (
      errorCode !== null &&
      errorCode !== undefined &&
      errorCode !== '' &&
      !/^\d{1,10}$/.test(String(errorCode))
    ) {
      return null;
    }
    return {
      status,
      errorCode:
        errorCode === null || errorCode === undefined || errorCode === ''
          ? null
          : String(errorCode),
    };
  },
  validateTwilioStatusCallbackSignature: mocks.validateSignature,
}));

vi.mock('@/server/delivery/provider-events', () => ({
  buildTwilioProviderEventKey: (
    sid: string,
    status: string,
    errorCode: string | null,
  ) => `message/${sid}/${status}/${errorCode ?? 'none'}`,
  mapTwilioStatusToDeliveryEventType: (status: string) => {
    if (status === 'delivered' || status === 'read') return 'delivered';
    if (
      ['failed', 'partially_delivered', 'undelivered', 'canceled'].includes(
        status,
      )
    ) {
      return 'failed';
    }
    return 'accepted';
  },
  recordProviderDeliveryEvent: mocks.recordEvent,
}));

import { POST } from './route';

const jobId = '10000000-0000-4000-8000-000000000123';
const messageSid = `SM${'a'.repeat(32)}`;
const accountSid = `AC${'0'.repeat(32)}`;

function request(
  parameters: Array<[string, string]> = [
    ['AccountSid', accountSid],
    ['MessageSid', messageSid],
    ['MessageStatus', 'delivered'],
    ['ErrorCode', ''],
  ],
  headers: Record<string, string> = {},
) {
  const body = new URLSearchParams();
  for (const [key, value] of parameters) body.append(key, value);
  return new Request(
    `https://survey.example.test/api/webhooks/twilio/message-status/${jobId}`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'x-twilio-signature': 'valid-signature',
        ...headers,
      },
      body: body.toString(),
    },
  );
}

beforeEach(() => {
  vi.stubEnv('TWILIO_ACCOUNT_SID', accountSid);
  mocks.validateSignature.mockReset();
  mocks.recordEvent.mockReset();
  mocks.validateSignature.mockReturnValue(true);
  mocks.recordEvent.mockResolvedValue({
    outcome: 'recorded',
    jobStatus: 'sent',
    downstreamStatus: 'delivered',
  });
});

describe('Twilio message-status callback', () => {
  it('validates every form parameter and records a normalized delivery event', async () => {
    const response = await POST(
      request([
        ['AccountSid', accountSid],
        ['MessageSid', messageSid],
        ['MessageStatus', 'delivered'],
        ['ErrorCode', ''],
        ['FutureParameter', 'second'],
        ['FutureParameter', 'first'],
      ]),
      { params: { deliveryJobId: jobId } },
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mocks.validateSignature).toHaveBeenCalledWith({
      signature: 'valid-signature',
      url: `https://survey.example.test/api/webhooks/twilio/message-status/${jobId}`,
      formParameters: expect.objectContaining({
        AccountSid: accountSid,
        MessageSid: messageSid,
        MessageStatus: 'delivered',
        ErrorCode: '',
        FutureParameter: ['second', 'first'],
      }),
    });
    expect(mocks.recordEvent).toHaveBeenCalledWith({
      deliveryJobId: jobId,
      provider: 'twilio',
      providerMessageId: messageSid,
      providerEventKey: `message/${messageSid}/delivered/none`,
      eventType: 'delivered',
      occurredAt: expect.any(String),
      receivedAt: expect.any(String),
      providerCode: null,
    });
    const recorded = mocks.recordEvent.mock.calls[0]?.[0];
    expect(recorded.occurredAt).toBe(recorded.receivedAt);
  });

  it.each(['duplicate', 'provider_message_mismatch', 'event_key_conflict'])(
    'acknowledges safe database outcome %s without exposing it',
    async (outcome) => {
      mocks.recordEvent.mockResolvedValue({
        outcome,
        jobStatus: 'sent',
        downstreamStatus: null,
      });

      const response = await POST(request(), {
        params: { deliveryJobId: jobId },
      });

      expect(response.status).toBe(200);
      expect(await response.text()).toBe('');
    },
  );

  it('rejects an invalid signature without touching storage', async () => {
    mocks.validateSignature.mockReturnValue(false);

    const response = await POST(request(), {
      params: { deliveryJobId: jobId },
    });

    expect(response.status).toBe(403);
    expect(mocks.recordEvent).not.toHaveBeenCalled();
  });

  it.each([
    ['wrong account', 'AccountSid', `AC${'f'.repeat(32)}`],
    ['bad message sid', 'MessageSid', 'SM_not-valid'],
    ['unknown status', 'MessageStatus', 'future_status'],
    ['bad error code', 'ErrorCode', 'customer-data'],
  ])('rejects signed malformed input: %s', async (_name, key, value) => {
    const parameters: Array<[string, string]> = [
      ['AccountSid', accountSid],
      ['MessageSid', messageSid],
      ['MessageStatus', 'failed'],
      ['ErrorCode', '30003'],
    ];
    const index = parameters.findIndex(([candidate]) => candidate === key);
    parameters[index] = [key, value];

    const response = await POST(request(parameters), {
      params: { deliveryJobId: jobId },
    });

    expect(response.status).toBe(400);
    expect(mocks.recordEvent).not.toHaveBeenCalled();
  });

  it('rejects contradictory SMS aliases after signature validation', async () => {
    const response = await POST(
      request([
        ['AccountSid', accountSid],
        ['MessageSid', messageSid],
        ['MessageStatus', 'sent'],
        ['SmsSid', `SM${'b'.repeat(32)}`],
        ['SmsStatus', 'sent'],
      ]),
      { params: { deliveryJobId: jobId } },
    );

    expect(response.status).toBe(400);
    expect(mocks.recordEvent).not.toHaveBeenCalled();
  });

  it('enforces content type and the 64 KiB limit before verification', async () => {
    const wrongType = request();
    wrongType.headers.set('content-type', 'application/json');
    expect(
      (
        await POST(wrongType, { params: { deliveryJobId: jobId } })
      ).status,
    ).toBe(415);

    const oversized = request(undefined, { 'content-length': '65537' });
    expect(
      (
        await POST(oversized, { params: { deliveryJobId: jobId } })
      ).status,
    ).toBe(413);
    expect(mocks.validateSignature).not.toHaveBeenCalled();
  });

  it('returns a sanitized retryable response for database failure', async () => {
    mocks.recordEvent.mockRejectedValue(
      new Error('database contained customer details'),
    );

    const response = await POST(request(), {
      params: { deliveryJobId: jobId },
    });

    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('customer');
  });
});
