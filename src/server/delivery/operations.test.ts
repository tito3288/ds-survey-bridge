import { describe, expect, it, vi } from 'vitest';
import type { DeliveryOperationsRepository } from './operations';
import {
  DELIVERY_EVENT_CLEANUP_BATCH_SIZE,
  DELIVERY_EVENT_RETENTION_DAYS,
  DELIVERY_RECONCILIATION_BATCH_SIZE,
  DELIVERY_RECONCILIATION_CONCURRENCY,
  DeliveryOperationsConfigurationError,
  runDeliveryEventCleanup,
  runDeliveryHealthCheck,
  runTwilioReconciliation,
} from './operations';

const zeroHealth = {
  overdueCount: 0,
  staleCount: 0,
  deadCount: 0,
  unknownCount: 0,
  failedCount: 0,
  mixedCount: 0,
  complainedCount: 0,
};

function createRepository(
  overrides: Partial<DeliveryOperationsRepository> = {},
): DeliveryOperationsRepository {
  return {
    validateConfiguration: vi.fn(),
    getHealthSummary: vi.fn().mockResolvedValue(zeroHealth),
    getTwilioReconciliationCandidates: vi.fn().mockResolvedValue([]),
    purgeDeliveryEvents: vi.fn().mockResolvedValue(0),
    ...overrides,
  };
}

describe('delivery operations', () => {
  it('locks the reconciliation and receipt-retention defaults', () => {
    expect(DELIVERY_RECONCILIATION_BATCH_SIZE).toBe(20);
    expect(DELIVERY_RECONCILIATION_CONCURRENCY).toBe(5);
    expect(DELIVERY_EVENT_RETENTION_DAYS).toBe(90);
    expect(DELIVERY_EVENT_CLEANUP_BATCH_SIZE).toBe(1_000);
  });

  it('refuses a disabled health check before touching configuration or data', async () => {
    const repository = createRepository();

    await expect(
      runDeliveryHealthCheck({ repository }, {}),
    ).rejects.toEqual(
      new DeliveryOperationsConfigurationError('delivery_health_disabled'),
    );
    expect(repository.validateConfiguration).not.toHaveBeenCalled();
    expect(repository.getHealthSummary).not.toHaveBeenCalled();
  });

  it('reports aggregate-only attention without customer data', async () => {
    const logger = { log: vi.fn() };
    const repository = createRepository({
      getHealthSummary: vi.fn().mockResolvedValue({
        ...zeroHealth,
        unknownCount: 1,
        failedCount: 2,
      }),
    });

    const result = await runDeliveryHealthCheck(
      {
        repository,
        now: () => new Date('2026-08-18T12:00:00Z'),
        createRunId: () => 'health-run',
        logger,
      },
      { DELIVERY_HEALTH_ENABLED: 'true' },
    );

    expect(result.healthy).toBe(false);
    expect(repository.getHealthSummary).toHaveBeenCalledWith(
      '2026-08-18T12:00:00.000Z',
    );
    expect(logger.log).toHaveBeenCalledWith({
      runId: 'health-run',
      outcome: 'attention_required',
      ...result.summary,
    });
    expect(JSON.stringify(logger.log.mock.calls)).not.toContain(
      '+15555550123',
    );
  });

  it('returns healthy only when every aggregate attention count is zero', async () => {
    await expect(
      runDeliveryHealthCheck(
        { repository: createRepository() },
        { DELIVERY_HEALTH_ENABLED: 'true' },
      ),
    ).resolves.toEqual({ healthy: true, summary: zeroHealth });
  });

  it('runs one bounded service-only cleanup batch when explicitly enabled', async () => {
    const purgeDeliveryEvents = vi.fn().mockResolvedValue(27);
    const repository = createRepository({ purgeDeliveryEvents });

    await expect(
      runDeliveryEventCleanup(
        {
          repository,
          now: () => new Date('2026-08-18T12:00:00Z'),
          createRunId: () => 'cleanup-run',
        },
        { DELIVERY_EVENT_CLEANUP_ENABLED: 'true' },
      ),
    ).resolves.toEqual({ deleted: 27 });
    expect(purgeDeliveryEvents).toHaveBeenCalledWith({
      now: '2026-08-18T12:00:00.000Z',
      limit: 1_000,
    });
  });

  it('refuses reconciliation before validating Twilio or claiming candidates', async () => {
    const repository = createRepository();
    const validateTwilioConfiguration = vi.fn();

    await expect(
      runTwilioReconciliation(
        {
          repository,
          validateTwilioConfiguration,
          fetchTwilioStatus: vi.fn(),
          mapTwilioStatus: vi.fn(),
          createTwilioEventKey: vi.fn(),
          recordProviderEvent: vi.fn(),
        },
        {},
      ),
    ).rejects.toEqual(
      new DeliveryOperationsConfigurationError(
        'delivery_reconciler_disabled',
      ),
    );
    expect(validateTwilioConfiguration).not.toHaveBeenCalled();
    expect(repository.getTwilioReconciliationCandidates).not.toHaveBeenCalled();
  });

  it('rejects malformed Twilio configuration before selecting candidates', async () => {
    const repository = createRepository();

    await expect(
      runTwilioReconciliation(
        {
          repository,
          validateTwilioConfiguration: () => {
            throw new Error('secret provider detail');
          },
          fetchTwilioStatus: vi.fn(),
          mapTwilioStatus: vi.fn(),
          createTwilioEventKey: vi.fn(),
          recordProviderEvent: vi.fn(),
        },
        { DELIVERY_RECONCILER_ENABLED: 'true' },
      ),
    ).rejects.toEqual(
      new DeliveryOperationsConfigurationError(
        'twilio_configuration_error',
      ),
    );
    expect(repository.getTwilioReconciliationCandidates).not.toHaveBeenCalled();
  });

  it('polls candidates and feeds normalized statuses through shared event ingest', async () => {
    const repository = createRepository({
      getTwilioReconciliationCandidates: vi.fn().mockResolvedValue([
        {
          deliveryJobId: '11111111-1111-4111-8111-111111111111',
          providerMessageId: `SM${'1'.repeat(32)}`,
        },
        {
          deliveryJobId: '22222222-2222-4222-8222-222222222222',
          providerMessageId: `SM${'2'.repeat(32)}`,
        },
      ]),
    });
    const recordProviderEvent = vi.fn().mockResolvedValue({
      outcome: 'recorded',
      jobStatus: 'sent',
      downstreamStatus: 'delivered',
    });

    const result = await runTwilioReconciliation(
      {
        repository,
        validateTwilioConfiguration: vi.fn(),
        fetchTwilioStatus: vi
          .fn()
          .mockResolvedValueOnce({ status: 'delivered', errorCode: null })
          .mockResolvedValueOnce({ status: 'undelivered', errorCode: '30003' }),
        mapTwilioStatus: (status) =>
          status === 'delivered' ? 'delivered' : 'failed',
        createTwilioEventKey: ({ messageSid, status, errorCode }) =>
          `message/${messageSid}/${status}/${errorCode ?? 'none'}`,
        recordProviderEvent,
        now: () => new Date('2026-08-18T12:00:00Z'),
        createRunId: () => 'reconcile-run',
      },
      { DELIVERY_RECONCILER_ENABLED: 'true' },
    );

    expect(result).toEqual({
      checked: 2,
      recorded: 2,
      ignored: 0,
      failed: 0,
    });
    expect(repository.getTwilioReconciliationCandidates).toHaveBeenCalledWith({
      now: '2026-08-18T12:00:00.000Z',
      limit: 20,
    });
    expect(recordProviderEvent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        deliveryJobId: '22222222-2222-4222-8222-222222222222',
        eventType: 'failed',
        providerCode: '30003',
      }),
    );
  });

  it('sanitizes lookup failures and continues processing later candidates', async () => {
    const logger = { log: vi.fn() };
    const repository = createRepository({
      getTwilioReconciliationCandidates: vi.fn().mockResolvedValue([
        {
          deliveryJobId: '11111111-1111-4111-8111-111111111111',
          providerMessageId: `SM${'1'.repeat(32)}`,
        },
        {
          deliveryJobId: '22222222-2222-4222-8222-222222222222',
          providerMessageId: `SM${'2'.repeat(32)}`,
        },
      ]),
    });
    const fetchTwilioStatus = vi
      .fn()
      .mockRejectedValueOnce(new Error('phone +15555550123 leaked here'))
      .mockResolvedValueOnce({ status: 'sent', errorCode: null });

    const result = await runTwilioReconciliation(
      {
        repository,
        validateTwilioConfiguration: vi.fn(),
        fetchTwilioStatus,
        mapTwilioStatus: () => 'accepted',
        createTwilioEventKey: () => 'safe-key',
        recordProviderEvent: vi.fn().mockResolvedValue({
          outcome: 'duplicate',
          jobStatus: 'sent',
          downstreamStatus: null,
        }),
        logger,
      },
      { DELIVERY_RECONCILER_ENABLED: 'true' },
    );

    expect(result).toEqual({
      checked: 2,
      recorded: 0,
      ignored: 1,
      failed: 1,
    });
    expect(JSON.stringify(logger.log.mock.calls)).not.toContain(
      '+15555550123',
    );
    expect(JSON.stringify(logger.log.mock.calls)).not.toContain('leaked here');
  });
});
