import { describe, expect, it, vi } from 'vitest';
import type { DeliveryProviders } from './providers';
import type { DeliveryRepository } from './repository';
import {
  DeliveryWorkerConfigurationError,
  runDeliveryWorker,
} from './worker';
import {
  DELIVERY_BATCH_SIZE,
  DELIVERY_CONCURRENCY,
  DELIVERY_LEASE_SECONDS,
  DELIVERY_MAX_ATTEMPTS,
  DELIVERY_RETRY_GAPS_MINUTES,
  type ClaimedDeliveryJob,
  type DeliveryWorkerLog,
} from './types';

const NOW = new Date('2026-08-18T12:00:00.000Z');
const smsPayload = {
  kind: 'survey_sms' as const,
  surveyToken: '00000000-0000-4000-8000-000000000123',
  customerPhone: '+15555550123',
  customerName: 'Fake Customer',
};

function createJob(index = 1): ClaimedDeliveryJob {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    surveyId: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    kind: 'survey_sms',
    attemptCount: 0,
    leaseToken: `20000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  };
}

function createRepository(
  overrides: Partial<DeliveryRepository> = {},
): DeliveryRepository {
  return {
    validateConfiguration: vi.fn(),
    claimDueJobs: vi.fn().mockResolvedValue([createJob()]),
    loadPayload: vi.fn().mockResolvedValue({ ok: true, payload: smsPayload }),
    markProviderStarted: vi.fn().mockResolvedValue({
      started: true,
      attemptCount: 1,
    }),
    markSent: vi.fn().mockResolvedValue(true),
    markRetry: vi.fn().mockResolvedValue({
      status: 'pending',
      nextAttemptAt: '2026-08-18T12:05:00.000Z',
      attemptCount: 1,
    }),
    markDead: vi.fn().mockResolvedValue(true),
    markUnknown: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

function createProviders(
  overrides: Partial<DeliveryProviders> = {},
): DeliveryProviders {
  return {
    validateConfiguration: vi.fn(),
    validatePayload: vi.fn().mockReturnValue({ ok: true }),
    send: vi.fn().mockResolvedValue({
      outcome: 'sent',
      providerMessageId: 'SM_fake',
    }),
    ...overrides,
  };
}

function createHarness(options: {
  repository?: DeliveryRepository;
  providers?: DeliveryProviders;
  now?: () => Date;
} = {}) {
  const logs: DeliveryWorkerLog[] = [];
  const repository = options.repository ?? createRepository();
  const providers = options.providers ?? createProviders();
  const dependencies = {
    repository,
    providers,
    now: options.now ?? (() => NOW),
    createRunId: () => '30000000-0000-4000-8000-000000000001',
    logger: { log: (record: DeliveryWorkerLog) => logs.push(record) },
  };

  return { dependencies, repository, providers, logs };
}

describe('delivery worker', () => {
  it('locks the planned batch, concurrency, lease, attempt, and retry defaults', () => {
    expect(DELIVERY_BATCH_SIZE).toBe(20);
    expect(DELIVERY_CONCURRENCY).toBe(5);
    expect(DELIVERY_LEASE_SECONDS).toBe(600);
    expect(DELIVERY_MAX_ATTEMPTS).toBe(6);
    expect(DELIVERY_RETRY_GAPS_MINUTES).toEqual([5, 15, 60, 240, 720]);
  });

  it('refuses to validate providers or claim jobs unless explicitly enabled', async () => {
    const harness = createHarness();

    await expect(
      runDeliveryWorker(harness.dependencies, { env: {} }),
    ).rejects.toBeInstanceOf(DeliveryWorkerConfigurationError);
    expect(harness.providers.validateConfiguration).not.toHaveBeenCalled();
    expect(harness.repository.validateConfiguration).not.toHaveBeenCalled();
    expect(harness.repository.claimDueJobs).not.toHaveBeenCalled();
  });

  it('rejects malformed provider configuration before claiming jobs', async () => {
    const providers = createProviders({
      validateConfiguration: vi.fn(() => {
        throw new Error('credential with sensitive value');
      }),
    });
    const harness = createHarness({ providers });

    await expect(
      runDeliveryWorker(harness.dependencies, {
        env: { DELIVERY_WORKER_ENABLED: 'true' },
      }),
    ).rejects.toEqual(
      new DeliveryWorkerConfigurationError('configuration_error'),
    );
    expect(harness.repository.claimDueJobs).not.toHaveBeenCalled();
  });

  it('claims one bounded batch and records provider acceptance', async () => {
    const harness = createHarness();

    const summary = await runDeliveryWorker(harness.dependencies, {
      env: { DELIVERY_WORKER_ENABLED: 'true' },
    });

    expect(harness.repository.claimDueJobs).toHaveBeenCalledWith({
      runId: '30000000-0000-4000-8000-000000000001',
      limit: 20,
      leaseSeconds: 600,
      now: NOW.toISOString(),
    });
    expect(harness.repository.markProviderStarted).toHaveBeenCalledBefore(
      harness.providers.send as ReturnType<typeof vi.fn>,
    );
    expect(harness.repository.markSent).toHaveBeenCalledWith({
      jobId: createJob().id,
      leaseToken: createJob().leaseToken,
      providerMessageId: 'SM_fake',
      acceptedAt: NOW.toISOString(),
    });
    expect(summary).toEqual({
      runId: '30000000-0000-4000-8000-000000000001',
      claimed: 1,
      sent: 1,
      retried: 0,
      dead: 0,
      unknown: 0,
      failed: 0,
      deferred: 0,
    });
  });

  it('lets the database schedule a safe retry or exhaust the sixth attempt', async () => {
    const providers = createProviders({
      send: vi.fn().mockResolvedValue({
        outcome: 'retry',
        errorCategory: 'provider',
        errorCode: 'twilio_503_20503',
      }),
    });
    const repository = createRepository({
      markProviderStarted: vi.fn().mockResolvedValue({
        started: true,
        attemptCount: 6,
      }),
      markRetry: vi.fn().mockResolvedValue({
        status: 'dead',
        nextAttemptAt: null,
        attemptCount: 6,
      }),
    });
    const harness = createHarness({ repository, providers });

    const summary = await runDeliveryWorker(harness.dependencies, {
      env: { DELIVERY_WORKER_ENABLED: 'true' },
    });

    expect(repository.markRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCategory: 'provider',
        errorCode: 'twilio_503_20503',
      }),
    );
    expect(summary.dead).toBe(1);
    expect(summary.retried).toBe(0);
  });

  it('marks ambiguous Twilio acceptance unknown and never retries it', async () => {
    const providers = createProviders({
      send: vi.fn().mockResolvedValue({
        outcome: 'unknown',
        errorCategory: 'provider',
        errorCode: 'twilio_econnreset',
      }),
    });
    const harness = createHarness({ providers });

    const summary = await runDeliveryWorker(harness.dependencies, {
      env: { DELIVERY_WORKER_ENABLED: 'true' },
    });

    expect(harness.repository.markUnknown).toHaveBeenCalledOnce();
    expect(harness.repository.markRetry).not.toHaveBeenCalled();
    expect(summary.unknown).toBe(1);
  });

  it('retries temporary payload loading without declaring a provider call', async () => {
    const repository = createRepository({
      loadPayload: vi.fn().mockResolvedValue({
        ok: false,
        disposition: 'retry',
        errorCategory: 'payload',
        errorCode: 'survey_read_failed',
      }),
    });
    const harness = createHarness({ repository });

    const summary = await runDeliveryWorker(harness.dependencies, {
      env: { DELIVERY_WORKER_ENABLED: 'true' },
    });

    expect(repository.markProviderStarted).not.toHaveBeenCalled();
    expect(repository.markRetry).toHaveBeenCalledOnce();
    expect(harness.providers.send).not.toHaveBeenCalled();
    expect(summary.retried).toBe(1);
  });

  it('dead-letters malformed job data before calling a provider', async () => {
    const providers = createProviders({
      validatePayload: vi.fn().mockReturnValue({
        ok: false,
        errorCode: 'invalid_delivery_payload',
      }),
    });
    const harness = createHarness({ providers });

    const summary = await runDeliveryWorker(harness.dependencies, {
      env: { DELIVERY_WORKER_ENABLED: 'true' },
    });

    expect(harness.repository.markDead).toHaveBeenCalledOnce();
    expect(harness.repository.markProviderStarted).not.toHaveBeenCalled();
    expect(providers.send).not.toHaveBeenCalled();
    expect(summary.dead).toBe(1);
  });

  it('never logs customer data or raw provider/database errors', async () => {
    const providers = createProviders({
      send: vi.fn().mockRejectedValue(
        new Error('Fake Customer +15555550123 raw provider body'),
      ),
    });
    const harness = createHarness({ providers });

    const summary = await runDeliveryWorker(harness.dependencies, {
      env: { DELIVERY_WORKER_ENABLED: 'true' },
    });

    expect(summary.failed).toBe(1);
    const serializedLogs = JSON.stringify(harness.logs);
    expect(serializedLogs).not.toContain('Fake Customer');
    expect(serializedLogs).not.toContain('+15555550123');
    expect(serializedLogs).not.toContain('raw provider body');
  });

  it('starts at most five provider calls concurrently', async () => {
    const jobs = Array.from({ length: 20 }, (_, index) => createJob(index + 1));
    const repository = createRepository({
      claimDueJobs: vi.fn().mockResolvedValue(jobs),
    });
    let active = 0;
    let maximum = 0;
    const providers = createProviders({
      send: vi.fn(async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        await Promise.resolve();
        active -= 1;
        return { outcome: 'sent' as const, providerMessageId: 'SM_fake' };
      }),
    });
    const harness = createHarness({ repository, providers });

    const summary = await runDeliveryWorker(harness.dependencies, {
      env: { DELIVERY_WORKER_ENABLED: 'true' },
    });

    expect(maximum).toBe(5);
    expect(summary.sent).toBe(20);
  });

  it('does not start newly claimed work after the four-minute deadline', async () => {
    let clockRead = 0;
    const now = () => {
      clockRead += 1;
      return clockRead === 1
        ? NOW
        : new Date(NOW.getTime() + 4 * 60 * 1_000);
    };
    const harness = createHarness({ now });

    const summary = await runDeliveryWorker(harness.dependencies, {
      env: { DELIVERY_WORKER_ENABLED: 'true' },
    });

    expect(harness.repository.loadPayload).not.toHaveBeenCalled();
    expect(summary.deferred).toBe(1);
  });

  it('turns a timed-out SMS into unknown and aborts its provider signal', async () => {
    let signal: AbortSignal | undefined;
    const providers = createProviders({
      send: vi.fn((_payload, _jobId, providerSignal) => {
        signal = providerSignal;
        return new Promise<never>(() => undefined);
      }),
    });
    const harness = createHarness({ providers });

    const summary = await runDeliveryWorker(harness.dependencies, {
      env: { DELIVERY_WORKER_ENABLED: 'true' },
      providerTimeoutMs: 1,
    });

    expect(signal?.aborted).toBe(true);
    expect(harness.repository.markUnknown).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'worker_provider_timeout' }),
    );
    expect(summary.unknown).toBe(1);
    expect(harness.repository.markRetry).not.toHaveBeenCalled();
  });
});
