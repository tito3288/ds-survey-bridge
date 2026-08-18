import { getRequiredEnv } from '@/lib/env';
import {
  getTwilioStatusCallbackUrl,
  isDeliveryJobId,
  isTwilioMessageSid,
  normalizeTwilioMessageStatus,
  validateTwilioStatusCallbackSignature,
} from '@/lib/twilio';
import {
  buildTwilioProviderEventKey,
  mapTwilioStatusToDeliveryEventType,
  recordProviderDeliveryEvent,
} from '@/server/delivery/provider-events';
import {
  emptyWebhookResponse,
  hasContentType,
  readProviderWebhookBody,
} from '@/server/delivery/provider-webhook-http';

function signatureParameters(
  body: URLSearchParams,
): Record<string, string | string[]> {
  const parameters: Record<string, string | string[]> = Object.create(null);
  for (const key of Array.from(new Set(Array.from(body.keys())))) {
    const values = body.getAll(key);
    parameters[key] = values.length === 1 ? values[0] : values;
  }
  return parameters;
}

function singleParameter(
  body: URLSearchParams,
  key: string,
  required = true,
): string | null | undefined {
  const values = body.getAll(key);
  if (values.length > 1) return undefined;
  if (values.length === 0) return required ? undefined : null;
  return values[0];
}

export async function POST(
  request: Request,
  context: { params: { deliveryJobId: string } },
) {
  if (!hasContentType(request, 'application/x-www-form-urlencoded')) {
    return emptyWebhookResponse(415);
  }

  const deliveryJobId = context.params.deliveryJobId;
  if (!isDeliveryJobId(deliveryJobId)) {
    return emptyWebhookResponse(400);
  }

  const bodyResult = await readProviderWebhookBody(request);
  if (!bodyResult.ok) return emptyWebhookResponse(bodyResult.status);

  const signature = request.headers.get('x-twilio-signature');
  if (!signature) return emptyWebhookResponse(403);

  const form = new URLSearchParams(bodyResult.body);
  let validSignature: boolean;
  try {
    validSignature = validateTwilioStatusCallbackSignature({
      signature,
      url: getTwilioStatusCallbackUrl(deliveryJobId),
      formParameters: signatureParameters(form),
    });
  } catch {
    return emptyWebhookResponse(503);
  }
  if (!validSignature) return emptyWebhookResponse(403);

  const accountSid = singleParameter(form, 'AccountSid');
  const messageSid = singleParameter(form, 'MessageSid');
  const messageStatus = singleParameter(form, 'MessageStatus');
  const errorCode = singleParameter(form, 'ErrorCode', false);
  const smsSid = singleParameter(form, 'SmsSid', false);
  const smsStatus = singleParameter(form, 'SmsStatus', false);
  let configuredAccountSid: string;
  try {
    configuredAccountSid = getRequiredEnv('TWILIO_ACCOUNT_SID');
  } catch {
    return emptyWebhookResponse(503);
  }

  if (
    typeof accountSid !== 'string' ||
    !/^AC[0-9a-f]{32}$/i.test(accountSid) ||
    accountSid !== configuredAccountSid ||
    typeof messageSid !== 'string' ||
    !isTwilioMessageSid(messageSid) ||
    typeof messageStatus !== 'string' ||
    errorCode === undefined ||
    smsSid === undefined ||
    smsStatus === undefined ||
    (smsSid !== null && smsSid !== messageSid) ||
    (smsStatus !== null && smsStatus !== messageStatus)
  ) {
    return emptyWebhookResponse(400);
  }

  const normalized = normalizeTwilioMessageStatus(messageStatus, errorCode);
  if (!normalized) return emptyWebhookResponse(400);
  const eventType = mapTwilioStatusToDeliveryEventType(normalized.status);
  if (eventType !== 'failed' && normalized.errorCode !== null) {
    return emptyWebhookResponse(400);
  }

  const receivedAt = new Date().toISOString();
  try {
    await recordProviderDeliveryEvent({
      deliveryJobId,
      provider: 'twilio',
      providerMessageId: messageSid,
      providerEventKey: buildTwilioProviderEventKey(
        messageSid,
        normalized.status,
        normalized.errorCode,
      ),
      eventType,
      occurredAt: receivedAt,
      receivedAt,
      providerCode:
        eventType === 'failed' ? normalized.errorCode : null,
    });
  } catch {
    return emptyWebhookResponse(503);
  }

  return emptyWebhookResponse(200);
}
