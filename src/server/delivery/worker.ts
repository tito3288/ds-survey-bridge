import 'server-only';

import { randomUUID } from 'node:crypto';
import type { DeliveryProviders } from '@/server/delivery/providers';
import type { DeliveryRepository } from '@/server/delivery/repository';
import {
  DELIVERY_BATCH_SIZE,
  DELIVERY_CONCURRENCY,
  DELIVERY_LEASE_SECONDS,
  DELIVERY_PROVIDER_TIMEOUT_MS,
  DELIVERY_RUN_DEADLINE_MS,
  type ClaimedDeliveryJob,
  type DeliveryWorkerLog,
} from '@/server/delivery/types';

export class DeliveryWorkerConfigurationError extends Error {
  constructor(
    readonly code:
      | 'delivery_worker_disabled'
      | 'configuration_error' = 'configuration_error',
    message = 'Delivery worker configuration is invalid',
  ) {
    super(message);
    this.name = 'DeliveryWorkerConfigurationError';
  }
}

export type DeliveryWorkerSummary = {
  runId: string;
  claimed: number;
  sent: number;
  retried: number;
  dead: number;
  unknown: number;
  failed: number;
  deferred: number;
};

export type DeliveryWorkerDependencies = {
  repository: DeliveryRepository;
  providers: DeliveryProviders;
  now: () => Date;
  createRunId: () => string;
  logger: { log(record: DeliveryWorkerLog): void };
};

const DEFAULT_RUNTIME_DEPENDENCIES = {
  now: () => new Date(),
  createRunId: () => randomUUID(),
  logger: { log: (record: DeliveryWorkerLog) => console.log(record) },
};

export function assertDeliveryWorkerEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  if (env.DELIVERY_WORKER_ENABLED !== 'true') {
    throw new DeliveryWorkerConfigurationError(
      'delivery_worker_disabled',
      'DELIVERY_WORKER_ENABLED must be exactly true',
    );
  }
}

function createSummary(runId: string): DeliveryWorkerSummary {
  return {
    runId,
    claimed: 0,
    sent: 0,
    retried: 0,
    dead: 0,
    unknown: 0,
    failed: 0,
    deferred: 0,
  };
}

function durationMs(startedAt: Date, endedAt: Date): number {
  return Math.max(0, endedAt.getTime() - startedAt.getTime());
}

export async function runDeliveryWorker(
  dependencies: Pick<DeliveryWorkerDependencies, 'repository' | 'providers'> &
    Partial<Omit<DeliveryWorkerDependencies, 'repository' | 'providers'>>,
  options: {
    env?: Readonly<Record<string, string | undefined>>;
    providerTimeoutMs?: number;
  } = {},
): Promise<DeliveryWorkerSummary> {
  const runtime = { ...DEFAULT_RUNTIME_DEPENDENCIES, ...dependencies };

  // Validate every switch and provider credential before leasing any work.
  assertDeliveryWorkerEnabled(options.env);
  try {
    runtime.repository.validateConfiguration();
    runtime.providers.validateConfiguration();
  } catch {
    throw new DeliveryWorkerConfigurationError('configuration_error');
  }

  const runId = runtime.createRunId();
  const startedAt = runtime.now();
  const deadlineAt = startedAt.getTime() + DELIVERY_RUN_DEADLINE_MS;
  const summary = createSummary(runId);
  const jobs = await runtime.repository.claimDueJobs({
    runId,
    limit: DELIVERY_BATCH_SIZE,
    leaseSeconds: DELIVERY_LEASE_SECONDS,
    now: startedAt.toISOString(),
  });
  summary.claimed = jobs.length;

  let cursor = 0;
  async function consume(): Promise<void> {
    while (cursor < jobs.length) {
      if (runtime.now().getTime() >= deadlineAt) {
        return;
      }

      const job = jobs[cursor];
      cursor += 1;
      await processJob(job);
    }
  }

  async function processJob(job: ClaimedDeliveryJob): Promise<void> {
    const jobStartedAt = runtime.now();
    let attempt = job.attemptCount;

    const log = (outcome: string, providerCode?: string) => {
      runtime.logger.log({
        runId,
        jobId: job.id,
        surveyId: job.surveyId,
        channel: job.kind,
        attempt,
        outcome,
        durationMs: durationMs(jobStartedAt, runtime.now()),
        ...(providerCode ? { providerCode } : {}),
      });
    };

    try {
      const loaded = await runtime.repository.loadPayload(job);
      if (!loaded.ok) {
        if (loaded.disposition === 'dead') {
          const updated = await runtime.repository.markDead({
            jobId: job.id,
            leaseToken: job.leaseToken,
            errorCategory: loaded.errorCategory,
            errorCode: loaded.errorCode,
            failedAt: runtime.now().toISOString(),
          });
          if (updated) summary.dead += 1;
          else summary.failed += 1;
          log(updated ? 'dead' : 'lease_lost', loaded.errorCode);
        } else {
          const updated = await runtime.repository.markRetry({
            jobId: job.id,
            leaseToken: job.leaseToken,
            errorCategory: loaded.errorCategory,
            errorCode: loaded.errorCode,
            failedAt: runtime.now().toISOString(),
          });
          attempt = updated.attemptCount;
          if (updated.status === 'pending') summary.retried += 1;
          else summary.dead += 1;
          log(updated.status, loaded.errorCode);
        }
        return;
      }

      if (loaded.payload.kind !== job.kind) {
        const updated = await runtime.repository.markDead({
          jobId: job.id,
          leaseToken: job.leaseToken,
          errorCategory: 'payload',
          errorCode: 'delivery_kind_mismatch',
          failedAt: runtime.now().toISOString(),
        });
        if (updated) summary.dead += 1;
        else summary.failed += 1;
        log(updated ? 'dead' : 'lease_lost', 'delivery_kind_mismatch');
        return;
      }

      const validation = runtime.providers.validatePayload(loaded.payload);
      if (!validation.ok) {
        const updated = await runtime.repository.markDead({
          jobId: job.id,
          leaseToken: job.leaseToken,
          errorCategory: 'payload',
          errorCode: validation.errorCode,
          failedAt: runtime.now().toISOString(),
        });
        if (updated) summary.dead += 1;
        else summary.failed += 1;
        log(updated ? 'dead' : 'lease_lost', validation.errorCode);
        return;
      }

      const providerStarted = await runtime.repository.markProviderStarted({
        jobId: job.id,
        leaseToken: job.leaseToken,
        startedAt: runtime.now().toISOString(),
      });
      if (!providerStarted.started || providerStarted.attemptCount === null) {
        summary.failed++;
        log('lease_lost');
        return;
      }
      attempt = providerStarted.attemptCount;

      const remainingRunMs = Math.max(
        1,
        deadlineAt - runtime.now().getTime(),
      );
      const timeoutMs = Math.min(
        options.providerTimeoutMs ?? DELIVERY_PROVIDER_TIMEOUT_MS,
        remainingRunMs,
      );
      const abortController = new AbortController();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const providerTimeout = new Promise<
        Awaited<ReturnType<DeliveryProviders['send']>>
      >((resolve) => {
        timeout = setTimeout(() => {
          abortController.abort();
          resolve(
            loaded.payload.kind === 'survey_sms'
              ? {
                  outcome: 'unknown',
                  errorCategory: 'provider',
                  errorCode: 'worker_provider_timeout',
                }
              : {
                  outcome: 'retry',
                  errorCategory: 'provider',
                  errorCode: 'worker_provider_timeout',
                },
          );
        }, timeoutMs);
      });
      const result = await Promise.race([
        runtime.providers.send(loaded.payload, job.id, abortController.signal),
        providerTimeout,
      ]).finally(() => {
        if (timeout) clearTimeout(timeout);
      });
      const completedAt = runtime.now().toISOString();

      if (result.outcome === 'sent') {
        const updated = await runtime.repository.markSent({
          jobId: job.id,
          leaseToken: job.leaseToken,
          providerMessageId: result.providerMessageId,
          acceptedAt: completedAt,
        });
        if (updated) summary.sent += 1;
        else summary.failed += 1;
        log(updated ? 'sent' : 'lease_lost');
        return;
      }

      if (result.outcome === 'retry') {
        const updated = await runtime.repository.markRetry({
          jobId: job.id,
          leaseToken: job.leaseToken,
          errorCategory: result.errorCategory,
          errorCode: result.errorCode,
          failedAt: completedAt,
        });
        attempt = updated.attemptCount;
        if (updated.status === 'pending') summary.retried += 1;
        else summary.dead += 1;
        log(updated.status, result.errorCode);
        return;
      }

      if (result.outcome === 'dead') {
        const updated = await runtime.repository.markDead({
          jobId: job.id,
          leaseToken: job.leaseToken,
          errorCategory: result.errorCategory,
          errorCode: result.errorCode,
          failedAt: completedAt,
        });
        if (updated) summary.dead += 1;
        else summary.failed += 1;
        log(updated ? 'dead' : 'lease_lost', result.errorCode);
        return;
      }

      const updated = await runtime.repository.markUnknown({
        jobId: job.id,
        leaseToken: job.leaseToken,
        errorCategory: result.errorCategory,
        errorCode: result.errorCode,
        failedAt: completedAt,
      });
      if (updated) summary.unknown += 1;
      else summary.failed += 1;
      log(updated ? 'unknown' : 'lease_lost', result.errorCode);
    } catch {
      // Never attach raw database/provider errors or customer data to logs.
      // Database stale-lease rules safely recover pre-call work and fence
      // uncertain post-call work based on provider_call_started_at.
      summary.failed++;
      log('internal_failure');
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(DELIVERY_CONCURRENCY, jobs.length) },
      () => consume(),
    ),
  );

  summary.deferred = jobs.length - cursor;
  runtime.logger.log({ runId, outcome: 'run_complete' });
  return summary;
}
