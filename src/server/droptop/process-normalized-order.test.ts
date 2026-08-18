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
};

function createHarness(options: HarnessOptions = {}) {
  const creationResult = options.creationResult ?? {
    created: true,
    error: null,
  };

  const createSurveyWithSmsJob = vi.fn(async () => creationResult);
  const logger = {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  const dependencies: NormalizedOrderDependencies = {
    createSurveyWithSmsJob,
    logger,
  };

  return {
    dependencies,
    createSurveyWithSmsJob,
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
    expect(harness.createSurveyWithSmsJob).not.toHaveBeenCalled();
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
    expect(harness.createSurveyWithSmsJob).not.toHaveBeenCalled();
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
    expect(harness.createSurveyWithSmsJob).toHaveBeenCalledOnce();
  });

  it('creates exactly one SMS job when duplicate orders are processed concurrently', async () => {
    let claimed = false;
    const createSurveyWithSmsJob = vi.fn(
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
          error: null,
        };
      },
    );
    const dependencies: NormalizedOrderDependencies = {
      createSurveyWithSmsJob,
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
    expect(createSurveyWithSmsJob).toHaveBeenCalledTimes(2);
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
    expect(harness.createSurveyWithSmsJob).toHaveBeenCalledOnce();
    expect(harness.logger.error).toHaveBeenCalledWith(
      '[droptop webhook] survey and SMS job creation failed',
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
    expect(harness.createSurveyWithSmsJob).toHaveBeenCalledWith({
      orderId: 'order-test-123',
      locationId: 'location-test-456',
      customerPhone: '+15555550123',
      customerName: 'Test Customer',
      services: [{ name: 'Synthetic Oil Change' }],
    });
    expect(harness.createSurveyWithSmsJob).toHaveBeenCalledOnce();
  });

  it('atomically inserts the survey and schedules its SMS', async () => {
    const harness = createHarness();

    const result = await processNormalizedOrder(
      oilChangeOrder,
      harness.dependencies,
    );

    expect(result).toEqual({
      status: 200,
      body: { ok: true, orderId: 'order-test-123' },
    });
    expect(harness.createSurveyWithSmsJob).toHaveBeenCalledWith({
      orderId: 'order-test-123',
      locationId: 'location-test-456',
      customerPhone: '+15555550123',
      customerName: 'Test Customer',
      services: [{ name: 'Synthetic Oil Change' }],
    });
  });
});
