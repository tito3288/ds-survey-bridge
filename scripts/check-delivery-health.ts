import { createDeliveryOperationsRepository } from '../src/server/delivery/operations-repository';
import {
  DeliveryOperationsConfigurationError,
  runDeliveryHealthCheck,
} from '../src/server/delivery/operations';

async function main(): Promise<void> {
  try {
    const result = await runDeliveryHealthCheck({
      repository: createDeliveryOperationsRepository(),
    });
    process.exitCode = result.healthy ? 0 : 1;
  } catch (error) {
    console.log({
      runId: 'delivery-health-process',
      outcome: 'health_check_failed',
      errorCode:
        error instanceof DeliveryOperationsConfigurationError
          ? error.code
          : 'delivery_health_error',
    });
    process.exitCode = 1;
  }
}

void main();
