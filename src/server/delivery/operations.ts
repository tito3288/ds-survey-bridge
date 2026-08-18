import 'server-only';

import { randomUUID } from 'node:crypto';
import type { DeliveryEventType } from '@/server/delivery/provider-events';

export const DELIVERY_RECONCILIATION_BATCH_SIZE = 20;
export const DELIVERY_RECONCILIATION_CONCURRENCY = 5;
export const DELIVERY_EVENT_RETENTION_DAYS = 90;
export const DELIVERY_EVENT_CLEANUP_BATCH_SIZE = 1_000;

export type DeliveryHealthSummary = {
  overdueCount: number;
  staleCount: number;
  deadCount: number;
  unknownCount: number;
  failedCount: number;
  mixedCount: number;
  complainedCount: number;
};

export type TwilioReconciliationCandidate = {
  deliveryJobId: string;
  providerMessageId: string;
};

export type DeliveryOperationLog = {
  runId: string;
  outcome: string;
  jobId?: string;
  provider?: 'twilio';
  status?: string;
  providerCode?: string;
  count?: number;
  overdueCount?: number;
  staleCount?: number;
  deadCount?: number;
  unknownCount?: number;
  failedCount?: number;
  mixedCount?: number;
  complainedCount?: number;
};

export interface DeliveryOperationsRepository {
  validateConfiguration(): void;
  getHealthSummary(now: string): Promise<DeliveryHealthSummary>;
  getTwilioReconciliationCandidates(input: {
    now: string;
    limit: number;
  }): Promise<TwilioReconciliationCandidate[]>;
  purgeDeliveryEvents(input: {
    now: string;
    limit: number;
  }): Promise<number>;
}

type ProviderEventResult = {
  outcome: string;
  jobStatus: string | null;
  downstreamStatus: string | null;
};

type TwilioStatus = { status: string; errorCode: string | null };

export class DeliveryOperationsConfigurationError extends Error {
  constructor(readonly code: string) {
    super('Delivery operations configuration is invalid');
    this.name = 'DeliveryOperationsConfigurationError';
  }
}

function assertEnabled(
  name: string,
  env: Readonly<Record<string, string | undefined>>,
): void {
  if (env[name] !== 'true') {
    throw new DeliveryOperationsConfigurationError(
      `${name.replace(/_ENABLED$/, '').toLowerCase()}_disabled`,
    );
  }
}

function hasAttention(summary: DeliveryHealthSummary): boolean {
  return Object.values(summary).some((count) => count > 0);
}

export async function runDeliveryHealthCheck(
  dependencies: {
    repository: DeliveryOperationsRepository;
    now?: () => Date;
    createRunId?: () => string;
    logger?: { log(record: DeliveryOperationLog): void };
  },
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<{ healthy: boolean; summary: DeliveryHealthSummary }> {
  assertEnabled('DELIVERY_HEALTH_ENABLED', env);
  dependencies.repository.validateConfiguration();

  const now = dependencies.now ?? (() => new Date());
  const runId = (dependencies.createRunId ?? randomUUID)();
  const logger = dependencies.logger ?? { log: console.log };
  const summary = await dependencies.repository.getHealthSummary(
    now().toISOString(),
  );
  const healthy = !hasAttention(summary);

  logger.log({
    runId,
    outcome: healthy ? 'healthy' : 'attention_required',
    ...summary,
  });
  return { healthy, summary };
}

export async function runDeliveryEventCleanup(
  dependencies: {
    repository: DeliveryOperationsRepository;
    now?: () => Date;
    createRunId?: () => string;
    logger?: { log(record: DeliveryOperationLog): void };
  },
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<{ deleted: number }> {
  assertEnabled('DELIVERY_EVENT_CLEANUP_ENABLED', env);
  dependencies.repository.validateConfiguration();

  const now = dependencies.now ?? (() => new Date());
  const runId = (dependencies.createRunId ?? randomUUID)();
  const logger = dependencies.logger ?? { log: console.log };
  const deleted = await dependencies.repository.purgeDeliveryEvents({
    now: now().toISOString(),
    limit: DELIVERY_EVENT_CLEANUP_BATCH_SIZE,
  });

  logger.log({ runId, outcome: 'cleanup_complete', count: deleted });
  return { deleted };
}

export async function runTwilioReconciliation(
  dependencies: {
    repository: DeliveryOperationsRepository;
    validateTwilioConfiguration(): void;
    fetchTwilioStatus(messageSid: string): Promise<TwilioStatus>;
    mapTwilioStatus(status: string): DeliveryEventType | null;
    createTwilioEventKey(input: TwilioStatus & { messageSid: string }): string;
    recordProviderEvent(input: {
      deliveryJobId: string;
      provider: 'twilio';
      providerMessageId: string;
      providerEventKey: string;
      eventType: DeliveryEventType;
      occurredAt: string;
      receivedAt: string;
      providerCode: string | null;
    }): Promise<ProviderEventResult>;
    now?: () => Date;
    createRunId?: () => string;
    logger?: { log(record: DeliveryOperationLog): void };
  },
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<{
  checked: number;
  recorded: number;
  ignored: number;
  failed: number;
}> {
  assertEnabled('DELIVERY_RECONCILER_ENABLED', env);
  dependencies.repository.validateConfiguration();
  try {
    dependencies.validateTwilioConfiguration();
  } catch {
    throw new DeliveryOperationsConfigurationError(
      'twilio_configuration_error',
    );
  }

  const now = dependencies.now ?? (() => new Date());
  const runId = (dependencies.createRunId ?? randomUUID)();
  const logger = dependencies.logger ?? { log: console.log };
  const candidates =
    await dependencies.repository.getTwilioReconciliationCandidates({
      now: now().toISOString(),
      limit: DELIVERY_RECONCILIATION_BATCH_SIZE,
    });
  const summary = {
    checked: candidates.length,
    recorded: 0,
    ignored: 0,
    failed: 0,
  };
  let cursor = 0;

  async function consume(): Promise<void> {
    while (cursor < candidates.length) {
      const candidate = candidates[cursor];
      cursor += 1;

      try {
        const providerStatus = await dependencies.fetchTwilioStatus(
          candidate.providerMessageId,
        );
        const eventType = dependencies.mapTwilioStatus(providerStatus.status);
        if (!eventType) {
          summary.ignored += 1;
          logger.log({
            runId,
            jobId: candidate.deliveryJobId,
            provider: 'twilio',
            status: providerStatus.status,
            outcome: 'unsupported_status',
          });
          continue;
        }

        const observedAt = now().toISOString();
        const result = await dependencies.recordProviderEvent({
          deliveryJobId: candidate.deliveryJobId,
          provider: 'twilio',
          providerMessageId: candidate.providerMessageId,
          providerEventKey: dependencies.createTwilioEventKey({
            messageSid: candidate.providerMessageId,
            ...providerStatus,
          }),
          eventType,
          occurredAt: observedAt,
          receivedAt: observedAt,
          providerCode: providerStatus.errorCode,
        });

        if (result.outcome === 'recorded') summary.recorded += 1;
        else summary.ignored += 1;
        logger.log({
          runId,
          jobId: candidate.deliveryJobId,
          provider: 'twilio',
          status: providerStatus.status,
          outcome: result.outcome,
          ...(providerStatus.errorCode
            ? { providerCode: providerStatus.errorCode }
            : {}),
        });
      } catch {
        summary.failed += 1;
        logger.log({
          runId,
          jobId: candidate.deliveryJobId,
          provider: 'twilio',
          outcome: 'reconciliation_failed',
        });
      }
    }
  }

  await Promise.all(
    Array.from(
      {
        length: Math.min(
          DELIVERY_RECONCILIATION_CONCURRENCY,
          candidates.length,
        ),
      },
      () => consume(),
    ),
  );
  logger.log({
    runId,
    outcome: 'reconciliation_complete',
    count: candidates.length,
  });
  return summary;
}
