import { describe, expect, it, vi } from 'vitest';
import type { DeliveryProviderDependencies } from './providers';
import {
  classifyTwilioError,
  createDeliveryProviders,
} from './providers';
import type {
  PrivateFeedbackEmailPayload,
  SurveySmsPayload,
} from './types';

const smsPayload: SurveySmsPayload = {
  kind: 'survey_sms',
  surveyToken: '00000000-0000-4000-8000-000000000123',
  customerPhone: '+15555550123',
  customerName: 'Fake Customer',
};
const smsJobId = '10000000-0000-4000-8000-000000000123';
const emailJobId = '20000000-0000-4000-8000-000000000123';

const emailPayload: PrivateFeedbackEmailPayload = {
  kind: 'private_feedback_email',
  orderId: 'ORDER-FAKE-123',
  rating: 2,
  answers: {
    waitTime: 1,
    serviceSpeed: 2,
    vehicleCleanliness: 3,
    additionalServicesExperience: 4,
    value: 5,
    teamFriendliness: 2,
  },
  comment: null,
  locationId: 'FAKE-LOC-001',
  locationName: 'Fake Training Location',
  customerName: 'Fake Customer',
  customerPhone: '+15555550123',
  services: [{ name: 'Synthetic Oil Change' }],
};

function createDependencies(
  overrides: Partial<DeliveryProviderDependencies> = {},
): DeliveryProviderDependencies {
  return {
    sendSms: vi.fn().mockResolvedValue('SM_fake'),
    sendEmail: vi.fn().mockResolvedValue({
      data: { id: 'email_fake' },
      error: null,
      headers: null,
    }),
    validateSmsConfiguration: vi.fn(),
    validateEmailConfiguration: vi.fn(),
    ...overrides,
  } as DeliveryProviderDependencies;
}

describe('delivery providers', () => {
  it('validates both provider configurations before work is claimed', () => {
    const dependencies = createDependencies();
    const providers = createDeliveryProviders(dependencies);

    providers.validateConfiguration();

    expect(dependencies.validateSmsConfiguration).toHaveBeenCalledOnce();
    expect(dependencies.validateEmailConfiguration).toHaveBeenCalledOnce();
  });

  it('sends the existing SMS payload and returns Twilio acceptance', async () => {
    const dependencies = createDependencies();
    const providers = createDeliveryProviders(dependencies);

    await expect(providers.send(smsPayload, smsJobId)).resolves.toEqual({
      outcome: 'sent',
      providerMessageId: 'SM_fake',
    });
    expect(dependencies.sendSms).toHaveBeenCalledWith({
      to: '+15555550123',
      customerName: 'Fake Customer',
      surveyToken: smsPayload.surveyToken,
      deliveryJobId: smsJobId,
    });
  });

  it.each([
    [{ status: 429, code: 20429 }, 'retry'],
    [{ status: 503, code: 20503 }, 'retry'],
    [{ status: 408, code: 20408 }, 'unknown'],
    [{ status: 400, code: 21211 }, 'dead'],
    [{ code: 'ENOTFOUND' }, 'retry'],
    [{ code: 'ECONNRESET' }, 'unknown'],
    [new Error('unclassified failure'), 'unknown'],
  ] as const)(
    'classifies Twilio failure %# without exposing its message',
    (error, outcome) => {
      const result = classifyTwilioError(error);
      expect(result.outcome).toBe(outcome);
      expect(JSON.stringify(result)).not.toContain('unclassified failure');
    },
  );

  it('uses the stable job idempotency key for Resend acceptance', async () => {
    const dependencies = createDependencies();
    const providers = createDeliveryProviders(dependencies);

    await expect(providers.send(emailPayload, emailJobId)).resolves.toEqual(
      {
        outcome: 'sent',
        providerMessageId: 'email_fake',
      },
    );
    expect(dependencies.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: 'ORDER-FAKE-123',
        answers: emailPayload.answers,
      }),
      {
        idempotencyKey: `private-feedback/${emailJobId}`,
        deliveryJobId: emailJobId,
      },
    );
  });

  it.each([
    ['rate_limit_exceeded', 429, 'retry'],
    ['internal_server_error', 500, 'retry'],
    ['validation_error', 422, 'dead'],
    ['invalid_from_address', 400, 'dead'],
  ] as const)(
    'normalizes Resend resolved error %s as %s',
    async (name, statusCode, outcome) => {
      const dependencies = createDependencies({
        sendEmail: vi.fn().mockResolvedValue({
          data: null,
          error: { name, statusCode, message: 'sensitive raw message' },
          headers: null,
        }),
      } as Partial<DeliveryProviderDependencies>);
      const providers = createDeliveryProviders(dependencies);

      const result = await providers.send(emailPayload, 'job-email');

      expect(result.outcome).toBe(outcome);
      expect(JSON.stringify(result)).not.toContain('sensitive raw message');
    },
  );

  it('retries an uncertain Resend exception using the same idempotency key', async () => {
    const sendEmail = vi.fn().mockRejectedValue(Object.assign(
      new Error('socket contained customer data'),
      { code: 'ECONNRESET' },
    ));
    const providers = createDeliveryProviders(
      createDependencies({ sendEmail } as Partial<DeliveryProviderDependencies>),
    );

    const first = await providers.send(emailPayload, 'stable-job-id');
    const second = await providers.send(emailPayload, 'stable-job-id');

    expect(first).toEqual(second);
    expect(first.outcome).toBe('retry');
    expect(sendEmail).toHaveBeenNthCalledWith(
      1,
      expect.any(Object),
      {
        idempotencyKey: 'private-feedback/stable-job-id',
        deliveryJobId: 'stable-job-id',
      },
    );
    expect(sendEmail).toHaveBeenNthCalledWith(
      2,
      expect.any(Object),
      {
        idempotencyKey: 'private-feedback/stable-job-id',
        deliveryJobId: 'stable-job-id',
      },
    );
    expect(JSON.stringify(first)).not.toContain('customer data');
  });

  it('rejects malformed authoritative payloads before a provider call', () => {
    const dependencies = createDependencies();
    const providers = createDeliveryProviders(dependencies);

    expect(
      providers.validatePayload({ ...smsPayload, surveyToken: 'ORDER-123' }),
    ).toEqual({ ok: false, errorCode: 'invalid_delivery_payload' });
    expect(dependencies.sendSms).not.toHaveBeenCalled();
  });

  it('uses the exact questionnaire shape and comment limit for email jobs', () => {
    const providers = createDeliveryProviders(createDependencies());

    expect(
      providers.validatePayload({
        ...emailPayload,
        answers: {
          ...emailPayload.answers,
          unexpected: 5,
        },
      } as unknown as PrivateFeedbackEmailPayload),
    ).toEqual({ ok: false, errorCode: 'invalid_delivery_payload' });
    expect(
      providers.validatePayload({
        ...emailPayload,
        comment: 'x'.repeat(2_001),
      }),
    ).toEqual({ ok: false, errorCode: 'invalid_delivery_payload' });
  });
});
