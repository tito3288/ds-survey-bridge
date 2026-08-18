import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  construct: vi.fn(),
  create: vi.fn(),
  fetch: vi.fn(),
  message: vi.fn(),
  validateRequest: vi.fn(),
}));

vi.mock('twilio', () => ({
  default: Object.assign(
    (
      accountSid: string,
      authToken: string,
      options: { autoRetry?: boolean; timeout?: number },
    ) => {
      mocks.construct(accountSid, authToken, options);
      const messages = Object.assign(
        (messageSid: string) => {
          mocks.message(messageSid);
          return { fetch: mocks.fetch };
        },
        { create: mocks.create },
      );
      return { messages };
    },
    { validateRequest: mocks.validateRequest },
  ),
}));

const surveyToken = '00000000-0000-4000-8000-000000000123';
const deliveryJobId = '10000000-0000-4000-8000-000000000123';
const messageSid = `SM${'a'.repeat(32)}`;

beforeEach(() => {
  vi.resetModules();
  mocks.construct.mockReset();
  mocks.create.mockReset();
  mocks.fetch.mockReset();
  mocks.message.mockReset();
  mocks.validateRequest.mockReset();
  mocks.create.mockResolvedValue({ sid: 'SM_fake_private_link' });
  mocks.fetch.mockResolvedValue({ status: 'delivered', errorCode: null });
  mocks.validateRequest.mockReturnValue(true);
});

describe('sendSurveySMS', () => {
  it('preserves the SMS wording while linking only to the private survey token', async () => {
    vi.stubEnv('APP_URL', 'https://survey.example.test');
    const { sendSurveySMS } = await import('./twilio');

    const sid = await sendSurveySMS({
      to: '+15555550123',
      customerName: '  Fake Customer  ',
      surveyToken,
      deliveryJobId,
    });

    expect(sid).toBe('SM_fake_private_link');
    expect(mocks.construct).toHaveBeenCalledWith(
      'AC00000000000000000000000000000000',
      'fake-local-auth-token',
      {
        autoRetry: false,
        timeout: 30_000,
      },
    );
    expect(mocks.create).toHaveBeenCalledWith({
      body: `Hi Fake Customer! Thanks for visiting Drive & Shine today. How was your oil change? Tap to rate: https://survey.example.test/survey/${surveyToken} — Drive & Shine`,
      from: '+15555550100',
      statusCallback: `https://survey.example.test/api/webhooks/twilio/message-status/${deliveryJobId}#rc=3&rp=ct,rt,5xx`,
      to: '+15555550123',
    });
    expect(mocks.create.mock.calls[0]?.[0].body).not.toContain(
      'DROP-TOP-ORDER-987',
    );
  });

  it.each([
    'http://localhost:3000',
    'http://127.0.0.1:3001/',
  ])('allows local HTTP development origin %s', async (appUrl) => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('APP_URL', appUrl);
    const { sendSurveySMS } = await import('./twilio');

    await sendSurveySMS({
      to: '+15555550123',
      surveyToken,
      deliveryJobId,
    });

    const expectedOrigin = appUrl.endsWith('/') ? appUrl.slice(0, -1) : appUrl;
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining(
          `${expectedOrigin}/survey/${surveyToken}`,
        ),
      }),
    );
  });

  it.each(['http://localhost:3000', 'http://127.0.0.1:3001'])(
    'rejects local HTTP origin %s in production',
    async (appUrl) => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('APP_URL', appUrl);
      const { sendSurveySMS } = await import('./twilio');

      await expect(
        sendSurveySMS({
          to: '+15555550123',
          surveyToken,
          deliveryJobId,
        }),
      ).rejects.toThrow('Invalid APP_URL');

      expect(mocks.construct).not.toHaveBeenCalled();
      expect(mocks.create).not.toHaveBeenCalled();
    },
  );

  it.each([
    'http://survey.example.test',
    'http://127.0.0.2:3000',
    'https://survey.example.test/private',
    'https://survey.example.test?source=sms',
    'https://survey.example.test#fragment',
    'https://user:password@survey.example.test',
    'not-a-url',
  ])('rejects unsafe APP_URL %s before initializing Twilio', async (appUrl) => {
    vi.stubEnv('APP_URL', appUrl);
    const { sendSurveySMS } = await import('./twilio');

    await expect(
      sendSurveySMS({
        to: '+15555550123',
        surveyToken,
        deliveryJobId,
      }),
    ).rejects.toThrow('Invalid APP_URL');

    expect(mocks.construct).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it.each([' ', 'DROP-TOP-ORDER-987', '11111111-1111-1111-8111-111111111111'])(
    'rejects invalid survey token %s before initializing Twilio',
    async (invalidToken) => {
      const { sendSurveySMS } = await import('./twilio');

      await expect(
        sendSurveySMS({
          to: '+15555550123',
          surveyToken: invalidToken,
          deliveryJobId,
        }),
      ).rejects.toThrow('Invalid survey token');

      expect(mocks.construct).not.toHaveBeenCalled();
      expect(mocks.create).not.toHaveBeenCalled();
    },
  );

  it('rejects an invalid delivery job id before initializing Twilio', async () => {
    const { sendSurveySMS } = await import('./twilio');

    await expect(
      sendSurveySMS({
        to: '+15555550123',
        surveyToken,
        deliveryJobId: 'not-a-delivery-job-id',
      }),
    ).rejects.toThrow('Invalid delivery job id');
    expect(mocks.construct).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('validates callback signatures with the exact canonical URL and all parameters', async () => {
    const { validateTwilioStatusCallbackSignature } = await import('./twilio');
    const formParameters = {
      MessageSid: messageSid,
      ExtraField: ['value-two', 'value-one'],
    };

    expect(
      validateTwilioStatusCallbackSignature({
        signature: 'fake-valid-signature',
        url: `https://survey.example.test/api/webhooks/twilio/message-status/${deliveryJobId}`,
        formParameters,
      }),
    ).toBe(true);
    expect(mocks.validateRequest).toHaveBeenCalledWith(
      'fake-local-auth-token',
      'fake-valid-signature',
      `https://survey.example.test/api/webhooks/twilio/message-status/${deliveryJobId}`,
      formParameters,
    );
  });

  it('fetches and sanitizes an authoritative Twilio message status', async () => {
    const { fetchSurveySmsStatus } = await import('./twilio');
    mocks.fetch.mockResolvedValue({ status: 'undelivered', errorCode: 30003 });

    await expect(fetchSurveySmsStatus(messageSid)).resolves.toEqual({
      status: 'undelivered',
      errorCode: '30003',
    });
    expect(mocks.message).toHaveBeenCalledWith(messageSid);
  });

  it('rejects malformed SIDs and unsupported fetched statuses without a network call', async () => {
    const { fetchSurveySmsStatus } = await import('./twilio');

    await expect(fetchSurveySmsStatus('SM_not_valid')).rejects.toThrow(
      'Invalid Twilio message SID',
    );
    expect(mocks.message).not.toHaveBeenCalled();

    mocks.fetch.mockResolvedValue({ status: 'future_status', errorCode: null });
    await expect(fetchSurveySmsStatus(messageSid)).rejects.toThrow(
      'Invalid Twilio message status',
    );
  });
});
