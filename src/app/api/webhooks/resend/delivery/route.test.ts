import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  verify: vi.fn(),
  recordEvent: vi.fn(),
}));

vi.mock('@/lib/resend-webhook', () => ({
  RESEND_APP_TAG_VALUE: 'ds-survey-bridge',
  verifyResendWebhook: mocks.verify,
}));

vi.mock('@/server/delivery/provider-events', () => ({
  recordProviderDeliveryEvent: mocks.recordEvent,
}));

import { POST } from './route';

const jobId = '20000000-0000-4000-8000-000000000123';
const emailId = '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794';
const occurredAt = '2026-08-18T12:00:00.000Z';

function event(type = 'email.delivered') {
  return {
    type,
    created_at: occurredAt,
    data: {
      email_id: emailId,
      from: 'private@example.test',
      to: ['support@example.test'],
      subject: 'Private customer details must not be stored',
      tags: {
        app: 'ds-survey-bridge',
        delivery_job_id: jobId,
      },
      bounce: {
        message: 'raw bounce details with customer data',
        type: 'Permanent',
        subType: 'General',
      },
    },
  };
}

function request(
  body = '{"type":"email.delivered",  "data":{}}\n',
  headers: Record<string, string> = {},
) {
  return new Request(
    'https://survey.example.test/api/webhooks/resend/delivery',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'svix-id': 'msg_fake_123',
        'svix-timestamp': '1787054400',
        'svix-signature': 'v1,fake-valid-signature',
        ...headers,
      },
      body,
    },
  );
}

beforeEach(() => {
  vi.stubEnv('RESEND_API_KEY', 're_fake_private_feedback');
  vi.stubEnv('RESEND_WEBHOOK_SECRET', 'whsec_fake_webhook_secret');
  mocks.verify.mockReset();
  mocks.recordEvent.mockReset();
  mocks.verify.mockReturnValue(event());
  mocks.recordEvent.mockResolvedValue({
    outcome: 'recorded',
    jobStatus: 'sent',
    downstreamStatus: 'delivered',
  });
});

describe('Resend delivery callback', () => {
  it('verifies the untouched raw body and records no PII', async () => {
    vi.stubEnv('RESEND_API_KEY', '');
    const rawBody = '{"type":"email.delivered",  "data":{}}\n';

    const response = await POST(request(rawBody));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
    expect(mocks.verify).toHaveBeenCalledWith(
      rawBody,
      {
        id: 'msg_fake_123',
        timestamp: '1787054400',
        signature: 'v1,fake-valid-signature',
      },
      'whsec_fake_webhook_secret',
    );
    expect(mocks.recordEvent).toHaveBeenCalledWith({
      deliveryJobId: jobId,
      provider: 'resend',
      providerMessageId: emailId,
      providerEventKey: 'msg_fake_123',
      eventType: 'delivered',
      occurredAt,
      receivedAt: expect.any(String),
      providerCode: null,
    });
    expect(JSON.stringify(mocks.recordEvent.mock.calls[0]?.[0])).not.toContain(
      'support@example.test',
    );
    expect(JSON.stringify(mocks.recordEvent.mock.calls[0]?.[0])).not.toContain(
      'customer details',
    );
  });

  it.each([
    ['email.sent', 'accepted', null],
    ['email.delivered', 'delivered', null],
    ['email.delivery_delayed', 'delayed', null],
    ['email.complained', 'complained', 'resend_complained'],
    ['email.bounced', 'failed', 'resend_bounced'],
    ['email.failed', 'failed', 'resend_failed'],
    ['email.suppressed', 'failed', 'resend_suppressed'],
  ] as const)(
    'maps signed %s to %s',
    async (type, eventType, providerCode) => {
      mocks.verify.mockReturnValue(event(type));

      const response = await POST(request());

      expect(response.status).toBe(200);
      expect(mocks.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({ eventType, providerCode }),
      );
    },
  );

  it('accepts the full database-safe Svix event-id boundary', async () => {
    const maxLengthId = 'a'.repeat(255);
    const response = await POST(
      request('{"signed":"payload"}', { 'svix-id': maxLengthId }),
    );

    expect(response.status).toBe(200);
    expect(mocks.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ providerEventKey: maxLengthId }),
    );

    mocks.recordEvent.mockClear();
    const tooLong = await POST(
      request('{"signed":"payload"}', { 'svix-id': `${maxLengthId}a` }),
    );
    expect(tooLong.status).toBe(400);
    expect(mocks.recordEvent).not.toHaveBeenCalled();
  });

  it.each(['duplicate', 'provider_message_mismatch', 'event_key_conflict'])(
    'acknowledges safe database outcome %s without exposing it',
    async (outcome) => {
      mocks.recordEvent.mockResolvedValue({
        outcome,
        jobStatus: 'sent',
        downstreamStatus: null,
      });

      const response = await POST(request());

      expect(response.status).toBe(200);
      expect(await response.text()).toBe('');
    },
  );

  it.each([
    'email.opened',
    'email.clicked',
    'email.scheduled',
    'email.received',
    'contact.created',
  ])('acknowledges unrelated signed event %s without storage', async (type) => {
    mocks.verify.mockReturnValue(event(type));

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(mocks.recordEvent).not.toHaveBeenCalled();
  });

  it('ignores a signed delivery event for another application', async () => {
    const other = event();
    other.data.tags.app = 'another-application';
    mocks.verify.mockReturnValue(other);

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(mocks.recordEvent).not.toHaveBeenCalled();
  });

  it('rejects an invalid signature and missing Svix headers', async () => {
    mocks.verify.mockImplementation(() => {
      throw new Error('invalid signature with raw payload');
    });
    expect((await POST(request())).status).toBe(403);
    expect(mocks.recordEvent).not.toHaveBeenCalled();

    const missing = request();
    missing.headers.delete('svix-id');
    expect((await POST(missing)).status).toBe(403);
  });

  it('fails closed with a retryable response when webhook configuration is missing', async () => {
    vi.stubEnv('RESEND_WEBHOOK_SECRET', '');

    const response = await POST(request());

    expect(response.status).toBe(503);
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it('rejects malformed signed owned events', async () => {
    mocks.verify.mockReturnValue({
      ...event(),
      data: {
        ...event().data,
        tags: {
          app: 'ds-survey-bridge',
          delivery_job_id: 'not-a-job-id',
        },
      },
    });

    const response = await POST(request());

    expect(response.status).toBe(400);
    expect(mocks.recordEvent).not.toHaveBeenCalled();
  });

  it('enforces JSON and 64 KiB before verification', async () => {
    const wrongType = request();
    wrongType.headers.set('content-type', 'text/plain');
    expect((await POST(wrongType)).status).toBe(415);

    const oversized = request('tiny', { 'content-length': '65537' });
    expect((await POST(oversized)).status).toBe(413);
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it('returns a sanitized retryable response for database failure', async () => {
    mocks.recordEvent.mockRejectedValue(
      new Error('raw customer and database details'),
    );

    const response = await POST(request());

    expect(response.status).toBe(503);
    expect(await response.text()).toBe('');
  });
});
