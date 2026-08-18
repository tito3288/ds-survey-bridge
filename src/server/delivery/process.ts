import 'server-only';

import type { DeliveryWorkerDependencies } from '@/server/delivery/worker';
import {
  DeliveryWorkerConfigurationError,
  runDeliveryWorker,
  type DeliveryWorkerSummary,
} from '@/server/delivery/worker';
import { DELIVERY_RUN_DEADLINE_MS } from '@/server/delivery/types';

type WorkerDependencies = Pick<
  DeliveryWorkerDependencies,
  'repository' | 'providers'
> &
  Partial<Omit<DeliveryWorkerDependencies, 'repository' | 'providers'>>;

type ProcessRuntime = {
  exit(code: number): never;
  setHardTimeout(callback: () => void, milliseconds: number): unknown;
  clearHardTimeout(handle: unknown): void;
  run: typeof runDeliveryWorker;
};

const DEFAULT_PROCESS_RUNTIME: ProcessRuntime = {
  exit: (code) => process.exit(code),
  setHardTimeout: (callback, milliseconds) =>
    setTimeout(callback, milliseconds),
  clearHardTimeout: (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
  run: runDeliveryWorker,
};

/**
 * Runs exactly one cron batch, then terminates even if an aborted provider's
 * socket would otherwise keep Node alive. The worker persists a safe terminal
 * or retry state before normal exit; the hard timer is the last-resort fence.
 */
export async function runDeliveryWorkerProcess(
  dependencies: WorkerDependencies,
  options: {
    env?: Readonly<Record<string, string | undefined>>;
    runtime?: Partial<ProcessRuntime>;
  } = {},
): Promise<never> {
  const runtime = { ...DEFAULT_PROCESS_RUNTIME, ...options.runtime };
  const logger = dependencies.logger ?? {
    log: (record: Parameters<Console['log']>[0]) => console.log(record),
  };
  const hardStop = runtime.setHardTimeout(
    () => {
      logger.log({
        runId: 'worker-process',
        outcome: 'worker_failed',
        errorCode: 'run_deadline_exceeded',
      });
      runtime.exit(1);
    },
    DELIVERY_RUN_DEADLINE_MS,
  );

  let exitCode = 0;
  try {
    await runtime.run(dependencies, { env: options.env });
  } catch (error) {
    exitCode = 1;
    logger.log({
      runId: 'worker-process',
      outcome: 'worker_failed',
      errorCode:
        error instanceof DeliveryWorkerConfigurationError
          ? error.code
          : 'worker_error',
    });
  }

  runtime.clearHardTimeout(hardStop);
  return runtime.exit(exitCode);
}

export type { DeliveryWorkerSummary };
