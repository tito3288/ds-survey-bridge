import type {
  ClaimedDeliveryJob,
  DeliveryPayloadLoadResult,
} from '@/server/delivery/types';

export type DeliveryRetryResult = {
  status: 'pending' | 'dead';
  nextAttemptAt: string | null;
  attemptCount: number;
};

export interface DeliveryRepository {
  validateConfiguration(): void;

  claimDueJobs(input: {
    runId: string;
    limit: number;
    leaseSeconds: number;
    now: string;
  }): Promise<ClaimedDeliveryJob[]>;

  loadPayload(job: ClaimedDeliveryJob): Promise<DeliveryPayloadLoadResult>;

  markProviderStarted(input: {
    jobId: string;
    leaseToken: string;
    startedAt: string;
  }): Promise<{ started: boolean; attemptCount: number | null }>;

  markSent(input: {
    jobId: string;
    leaseToken: string;
    providerMessageId: string;
    acceptedAt: string;
  }): Promise<boolean>;

  markRetry(input: {
    jobId: string;
    leaseToken: string;
    errorCategory: string;
    errorCode: string;
    failedAt: string;
  }): Promise<DeliveryRetryResult>;

  markDead(input: {
    jobId: string;
    leaseToken: string;
    errorCategory: string;
    errorCode: string;
    failedAt: string;
  }): Promise<boolean>;

  markUnknown(input: {
    jobId: string;
    leaseToken: string;
    errorCategory: string;
    errorCode: string;
    failedAt: string;
  }): Promise<boolean>;
}
