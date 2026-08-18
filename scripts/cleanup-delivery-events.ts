import { createDeliveryOperationsRepository } from '../src/server/delivery/operations-repository';
import {
  DeliveryOperationsConfigurationError,
  runDeliveryEventCleanup,
} from '../src/server/delivery/operations';

async function main(): Promise<void> {
  try {
    await runDeliveryEventCleanup({
      repository: createDeliveryOperationsRepository(),
    });
  } catch (error) {
    console.log({
      runId: 'delivery-event-cleanup-process',
      outcome: 'cleanup_failed',
      errorCode:
        error instanceof DeliveryOperationsConfigurationError
          ? error.code
          : 'delivery_event_cleanup_error',
    });
    process.exitCode = 1;
  }
}

void main();
