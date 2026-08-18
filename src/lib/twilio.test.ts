import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  construct: vi.fn(),
  create: vi.fn(),
}));

vi.mock('twilio', () => ({
  default: (accountSid: string, authToken: string) => {
    mocks.construct(accountSid, authToken);
    return { messages: { create: mocks.create } };
  },
}));

const surveyToken = '00000000-0000-4000-8000-000000000123';

beforeEach(() => {
  vi.resetModules();
  mocks.construct.mockReset();
  mocks.create.mockReset();
  mocks.create.mockResolvedValue({ sid: 'SM_fake_private_link' });
});

describe('sendSurveySMS', () => {
  it('preserves the SMS wording while linking only to the private survey token', async () => {
    vi.stubEnv('APP_URL', 'https://survey.example.test');
    const { sendSurveySMS } = await import('./twilio');

    const sid = await sendSurveySMS({
      to: '+15555550123',
      customerName: '  Fake Customer  ',
      surveyToken,
    });

    expect(sid).toBe('SM_fake_private_link');
    expect(mocks.construct).toHaveBeenCalledWith(
      'AC00000000000000000000000000000000',
      'fake-local-auth-token',
    );
    expect(mocks.create).toHaveBeenCalledWith({
      body: `Hi Fake Customer! Thanks for visiting Drive & Shine today. How was your oil change? Tap to rate: https://survey.example.test/survey/${surveyToken} — Drive & Shine`,
      from: '+15555550100',
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
        }),
      ).rejects.toThrow('Invalid survey token');

      expect(mocks.construct).not.toHaveBeenCalled();
      expect(mocks.create).not.toHaveBeenCalled();
    },
  );
});
