import {
  fetchSurveySmsStatus,
  validateSurveySmsConfiguration,
  type TwilioOutboundMessageStatus,
} from '../src/lib/twilio';
import { createDeliveryOperationsRepository } from '../src/server/delivery/operations-repository';
import {
  DeliveryOperationsConfigurationError,
  runTwilioReconciliation,
} from '../src/server/delivery/operations';
import {
  buildTwilioProviderEventKey,
  mapTwilioStatusToDeliveryEventType,
  recordProviderDeliveryEvent,
} from '../src/server/delivery/provider-events';

async function main(): Promise<void> {
  try {
    const result = await runTwilioReconciliation({
      repository: createDeliveryOperationsRepository(),
      validateTwilioConfiguration: validateSurveySmsConfiguration,
      fetchTwilioStatus: fetchSurveySmsStatus,
      mapTwilioStatus: (status) =>
        mapTwilioStatusToDeliveryEventType(
          status as TwilioOutboundMessageStatus,
        ),
      createTwilioEventKey: ({ messageSid, status, errorCode }) =>
        buildTwilioProviderEventKey(messageSid, status, errorCode),
      recordProviderEvent: recordProviderDeliveryEvent,
    });
    process.exitCode = result.failed > 0 ? 1 : 0;
  } catch (error) {
    console.log({
      runId: 'twilio-reconciliation-process',
      outcome: 'reconciliation_failed',
      errorCode:
        error instanceof DeliveryOperationsConfigurationError
          ? error.code
          : 'twilio_reconciliation_error',
    });
    process.exitCode = 1;
  }
}

void main();
