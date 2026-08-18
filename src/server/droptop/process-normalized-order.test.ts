import { describe, expect, it, vi } from 'vitest';
import {
  processNormalizedOrder,
  type NormalizedOrder,
  type NormalizedOrderDependencies,
  type SurveyCreationResult,
} from './process-normalized-order';

const oilChangeOrder: NormalizedOrder = {
  orderId: 'order-test-123',
  customerName: 'Test Customer',
  customerPhone: '+15555550123',
  locationId: 'location-test-456',
  services: [{ name: 'Synthetic Oil Change' }],
};

type HarnessOptions = {
  creationResult?: SurveyCreationResult;
  smsError?: Error;
  sentAtResult?: { error: unknown | null };
};

function createHarness(options: HarnessOptions = {}) {
  const creationResult = options.creationResult ?? {
    created: true,
    surveyToken: '00000000-0000-4000-8000-000000000123',
    error: null,
  };
  const sentAtResult = options.sentAtResult ?? { error: null };

  const createSurvey = vi.fn(async () => creationResult);
  const sendSurveySms = vi.fn(async () => {
    if (options.smsError) throw options.smsError;
    return 'SM_test_123';
  });
  const markSurveySent = vi.fn(async () => sentAtResult);
  const logger = {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  const dependencies: NormalizedOrderDependencies = {
    createSurvey,
    sendSurveySms,
    markSurveySent,
    now: () => new Date('2026-08-18T12:34:56.000Z'),
    logger,
  };

  return {
    dependencies,
    createSurvey,
    sendSurveySms,
    markSurveySent,
    logger,
  };
}

describe('processNormalizedOrder', () => {
  it('acknowledges and skips an order with missing required fields', async () => {
    const harness = createHarness();

    const result = await processNormalizedOrder(
      { ...oilChangeOrder, customerPhone: undefined },
      harness.dependencies,
    );

    expect(result).toEqual({
      status: 200,
      body: { ok: true, skipped: 'missing_fields' },
    });
    expect(harness.createSurvey).not.toHaveBeenCalled();
    expect(harness.sendSurveySms).not.toHaveBeenCalled();
  });

  it('acknowledges and skips a non-oil-change order', async () => {
    const harness = createHarness();

    const result = await processNormalizedOrder(
      { ...oilChangeOrder, services: [{ name: 'Premium Car Wash' }] },
      harness.dependencies,
    );

    expect(result).toEqual({
      status: 200,
      body: { ok: true, skipped: 'not_oil_change' },
    });
    expect(harness.createSurvey).not.toHaveBeenCalled();
  });

  it('acknowledges and skips a duplicate without sending another SMS', async () => {
    const harness = createHarness({
      creationResult: { created: false, error: null },
    });

    const result = await processNormalizedOrder(
      oilChangeOrder,
      harness.dependencies,
    );

    expect(result).toEqual({
      status: 200,
      body: { ok: true, skipped: 'duplicate' },
    });
    expect(harness.createSurvey).toHaveBeenCalledOnce();
    expect(harness.sendSurveySms).not.toHaveBeenCalled();
  });

  it('sends exactly one SMS when duplicate orders are processed concurrently', async () => {
    let claimed = false;
    const createSurvey = vi.fn(
      async (): Promise<SurveyCreationResult> => {
        // Let both requests reach the atomic persistence boundary before one
        // becomes the winner and the other observes the conflict.
        await Promise.resolve();
        if (claimed) {
          return { created: false, error: null };
        }

        claimed = true;
        return {
          created: true,
          surveyToken: '00000000-0000-4000-8000-000000000123',
          error: null,
        };
      },
    );
    const sendSurveySms = vi.fn(async () => 'SM_test_concurrent');
    const markSurveySent = vi.fn(async () => ({ error: null }));
    const dependencies: NormalizedOrderDependencies = {
      createSurvey,
      sendSurveySms,
      markSurveySent,
      now: () => new Date('2026-08-18T12:34:56.000Z'),
      logger: {
        log: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    };

    const results = await Promise.all([
      processNormalizedOrder(oilChangeOrder, dependencies),
      processNormalizedOrder(oilChangeOrder, dependencies),
    ]);

    expect(results).toEqual(
      expect.arrayContaining([
        { status: 200, body: { ok: true, orderId: 'order-test-123' } },
        { status: 200, body: { ok: true, skipped: 'duplicate' } },
      ]),
    );
    expect(createSurvey).toHaveBeenCalledTimes(2);
    expect(sendSurveySms).toHaveBeenCalledOnce();
    expect(markSurveySent).toHaveBeenCalledOnce();
  });

  it('returns an internal error when atomic survey creation fails', async () => {
    const creationError = new Error('creation failed');
    const harness = createHarness({
      creationResult: { created: false, error: creationError },
    });

    const result = await processNormalizedOrder(
      oilChangeOrder,
      harness.dependencies,
    );

    expect(result).toEqual({
      status: 500,
      body: { error: 'Internal server error' },
    });
    expect(harness.sendSurveySms).not.toHaveBeenCalled();
    expect(harness.logger.error).toHaveBeenCalledWith(
      '[droptop webhook] survey insert failed',
      creationError,
    );
  });

  it('passes the complete survey record to atomic creation', async () => {
    const creationError = new Error('insert failed');
    const harness = createHarness({
      creationResult: { created: false, error: creationError },
    });

    const result = await processNormalizedOrder(
      oilChangeOrder,
      harness.dependencies,
    );

    expect(result).toEqual({
      status: 500,
      body: { error: 'Internal server error' },
    });
    expect(harness.createSurvey).toHaveBeenCalledWith({
      orderId: 'order-test-123',
      locationId: 'location-test-456',
      customerPhone: '+15555550123',
      customerName: 'Test Customer',
      services: [{ name: 'Synthetic Oil Change' }],
    });
    expect(harness.sendSurveySms).not.toHaveBeenCalled();
  });

  it('inserts the survey, sends the SMS, and records sent_at', async () => {
    const harness = createHarness();

    const result = await processNormalizedOrder(
      oilChangeOrder,
      harness.dependencies,
    );

    expect(result).toEqual({
      status: 200,
      body: { ok: true, orderId: 'order-test-123' },
    });
    expect(harness.createSurvey).toHaveBeenCalledWith({
      orderId: 'order-test-123',
      locationId: 'location-test-456',
      customerPhone: '+15555550123',
      customerName: 'Test Customer',
      services: [{ name: 'Synthetic Oil Change' }],
    });
    expect(harness.sendSurveySms).toHaveBeenCalledWith({
      to: '+15555550123',
      customerName: 'Test Customer',
      surveyToken: '00000000-0000-4000-8000-000000000123',
    });
    expect(harness.markSurveySent).toHaveBeenCalledWith(
      'order-test-123',
      '2026-08-18T12:34:56.000Z',
    );
  });

  it('retains the inserted survey and acknowledges when SMS delivery fails', async () => {
    const smsError = new Error('SMS failed');
    const harness = createHarness({ smsError });

    const result = await processNormalizedOrder(
      oilChangeOrder,
      harness.dependencies,
    );

    expect(result).toEqual({
      status: 200,
      body: { ok: true, orderId: 'order-test-123' },
    });
    expect(harness.createSurvey).toHaveBeenCalledOnce();
    expect(harness.sendSurveySms).toHaveBeenCalledOnce();
    expect(harness.markSurveySent).not.toHaveBeenCalled();
    expect(harness.logger.error).toHaveBeenCalledWith(
      '[droptop webhook] SMS send failed',
      smsError,
    );
    expect(harness.createSurvey.mock.invocationCallOrder[0]).toBeLessThan(
      harness.sendSurveySms.mock.invocationCallOrder[0],
    );
  });

  it('acknowledges a sent_at update failure after the SMS succeeds', async () => {
    const sentAtError = new Error('sent_at update failed');
    const harness = createHarness({
      sentAtResult: { error: sentAtError },
    });

    const result = await processNormalizedOrder(
      oilChangeOrder,
      harness.dependencies,
    );

    expect(result).toEqual({
      status: 200,
      body: { ok: true, orderId: 'order-test-123' },
    });
    expect(harness.sendSurveySms).toHaveBeenCalledOnce();
    expect(harness.markSurveySent).toHaveBeenCalledOnce();
    expect(harness.logger.error).toHaveBeenCalledWith(
      '[droptop webhook] sent_at update failed',
      sentAtError,
    );
  });
});
