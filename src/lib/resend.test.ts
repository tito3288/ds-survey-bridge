import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  construct: vi.fn(),
  send: vi.fn(),
}));

vi.mock('resend', () => ({
  Resend: class {
    emails = { send: mocks.send };

    constructor(apiKey: string) {
      mocks.construct(apiKey);
    }
  },
}));

const answers = {
  waitTime: 1,
  serviceSpeed: 2,
  vehicleCleanliness: 3,
  additionalServicesExperience: 4,
  value: 5,
  teamFriendliness: 2,
} as const;

beforeEach(() => {
  vi.resetModules();
  mocks.construct.mockReset();
  mocks.send.mockReset();
  mocks.send.mockResolvedValue({ data: { id: 'fake-email-id' }, error: null });
});

describe('sendPrivateFeedbackEmail', () => {
  it('initializes Resend lazily and sends every questionnaire score', async () => {
    vi.stubEnv('RESEND_API_KEY', 're_fake_private_feedback');
    vi.stubEnv(
      'SUPPORT_EMAIL',
      'support@example.test, manager@example.test, ',
    );

    const resendModule = await import('./resend');

    expect(mocks.construct).not.toHaveBeenCalled();

    await resendModule.sendPrivateFeedbackEmail({
      orderId: 'ORDER-FAKE-123',
      rating: 2,
      answers,
      comment: '  Please explain the recommendations more clearly.  ',
      locationId: 'FAKE-LOC-001',
      locationName: 'Fake Training Location',
      customerName: 'Jamie Test-Customer',
      customerPhone: '+15555550123',
      services: [
        '  Full Synthetic Oil Change  ',
        { name: '  Tire Rotation  ' },
        '',
        { name: '   ' },
        42,
        null,
      ],
    });

    expect(mocks.construct).toHaveBeenCalledOnce();
    expect(mocks.construct).toHaveBeenCalledWith('re_fake_private_feedback');
    expect(mocks.send).toHaveBeenCalledOnce();
    expect(mocks.send).toHaveBeenCalledWith({
      from: 'Drive & Shine <onboarding@resend.dev>',
      to: ['support@example.test', 'manager@example.test'],
      subject: 'Private oil change survey feedback - Order ORDER-FAKE-123',
      text: [
        'A customer completed the private oil change questionnaire.',
        '',
        'Order ID: ORDER-FAKE-123',
        'Overall rating: 2/5',
        'Location: Fake Training Location (FAKE-LOC-001)',
        'Customer name: Jamie Test-Customer',
        'Customer phone: +15555550123',
        'Services: Full Synthetic Oil Change, Tire Rotation',
        '',
        'Questionnaire scores (1 = Poor, 5 = Excellent):',
        'How satisfied were you with your wait time? 1/5',
        'How satisfied were you with the speed of service? 2/5',
        'How satisfied were you with how clean we left your vehicle? 3/5',
        'How comfortable did you feel with recommendations for additional services? 4/5',
        'How satisfied were you with the value you received? 5/5',
        'How friendly and welcoming was our team? 2/5',
        '',
        'Anything we can improve?',
        'Please explain the recommendations more clearly.',
      ].join('\n'),
    });
  });

  it('emails a completed questionnaire without a written comment', async () => {
    const { sendPrivateFeedbackEmail } = await import('./resend');

    await sendPrivateFeedbackEmail({
      orderId: 'ORDER-NO-COMMENT',
      rating: 3,
      answers,
      comment: null,
      locationId: 'FAKE-LOC-002',
    });

    expect(mocks.send).toHaveBeenCalledOnce();
    expect(mocks.send).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining([
          'Customer name: Unknown',
          'Customer phone: Unknown',
          'Services: Unknown',
          '',
          'Questionnaire scores (1 = Poor, 5 = Excellent):',
        ].join('\n')),
      }),
    );
    expect(mocks.send).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining(
          'Anything we can improve?\nNot provided',
        ),
      }),
    );
  });

  it('normalizes a string service and falls back for blank service data', async () => {
    const { sendPrivateFeedbackEmail } = await import('./resend');

    await sendPrivateFeedbackEmail({
      orderId: 'ORDER-STRING-SERVICE',
      rating: 1,
      answers,
      services: '  Premium Oil Change  ',
    });
    await sendPrivateFeedbackEmail({
      orderId: 'ORDER-BLANK-SERVICES',
      rating: 1,
      answers,
      services: ['', { name: ' ' }],
    });

    expect(mocks.send).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        text: expect.stringContaining('Services: Premium Oil Change'),
      }),
    );
    expect(mocks.send).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        text: expect.stringContaining('Services: Unknown'),
      }),
    );
  });
});
