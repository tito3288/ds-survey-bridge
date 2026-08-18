import { getRequiredEnv } from '@/lib/env';
import {
  RESEND_APP_TAG_VALUE,
  verifyResendWebhook,
} from '@/lib/resend-webhook';
import {
  type DeliveryEventType,
  recordProviderDeliveryEvent,
} from '@/server/delivery/provider-events';
import {
  emptyWebhookResponse,
  hasContentType,
  readProviderWebhookBody,
} from '@/server/delivery/provider-webhook-http';

const RESEND_DELIVERY_EVENT_TYPES = new Set([
  'email.sent',
  'email.delivered',
  'email.delivery_delayed',
  'email.complained',
  'email.bounced',
  'email.failed',
  'email.suppressed',
]);
const SAFE_PROVIDER_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_SVIX_ID = /^[A-Za-z0-9_-]{1,255}$/;
const DELIVERY_JOB_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type VerifiedEmailEvent = {
  type: string;
  created_at: string;
  data: {
    email_id: string;
    tags?: Record<string, string>;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asRelevantEmailEvent(value: unknown): VerifiedEmailEvent | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null;
  if (!RESEND_DELIVERY_EVENT_TYPES.has(value.type)) return null;
  if (
    typeof value.created_at !== 'string' ||
    !Number.isFinite(new Date(value.created_at).getTime()) ||
    !isRecord(value.data) ||
    typeof value.data.email_id !== 'string' ||
    !SAFE_PROVIDER_ID.test(value.data.email_id) ||
    (value.data.tags !== undefined && !isRecord(value.data.tags))
  ) {
    throw new Error('Malformed signed Resend delivery event');
  }

  const tags = value.data.tags;
  if (
    tags !== undefined &&
    Object.values(tags).some((tag) => typeof tag !== 'string')
  ) {
    throw new Error('Malformed signed Resend delivery tags');
  }

  return value as VerifiedEmailEvent;
}

function mapResendEventType(type: string): DeliveryEventType {
  if (type === 'email.delivered') return 'delivered';
  if (type === 'email.delivery_delayed') return 'delayed';
  if (type === 'email.complained') return 'complained';
  if (
    type === 'email.bounced' ||
    type === 'email.failed' ||
    type === 'email.suppressed'
  ) {
    return 'failed';
  }
  return 'accepted';
}

function providerCode(type: string): string | null {
  if (type === 'email.bounced') return 'resend_bounced';
  if (type === 'email.failed') return 'resend_failed';
  if (type === 'email.suppressed') return 'resend_suppressed';
  if (type === 'email.complained') return 'resend_complained';
  return null;
}

export async function POST(request: Request) {
  if (!hasContentType(request, 'application/json')) {
    return emptyWebhookResponse(415);
  }

  const bodyResult = await readProviderWebhookBody(request);
  if (!bodyResult.ok) return emptyWebhookResponse(bodyResult.status);

  const webhookId = request.headers.get('svix-id');
  const webhookTimestamp = request.headers.get('svix-timestamp');
  const webhookSignature = request.headers.get('svix-signature');
  if (!webhookId || !webhookTimestamp || !webhookSignature) {
    return emptyWebhookResponse(403);
  }

  let webhookSecret: string;
  try {
    webhookSecret = getRequiredEnv('RESEND_WEBHOOK_SECRET');
    if (!webhookSecret.startsWith('whsec_')) throw new Error('Invalid secret');
  } catch {
    return emptyWebhookResponse(503);
  }

  let verified: unknown;
  try {
    verified = verifyResendWebhook(
      bodyResult.body,
      {
        id: webhookId,
        timestamp: webhookTimestamp,
        signature: webhookSignature,
      },
      webhookSecret,
    );
  } catch {
    return emptyWebhookResponse(403);
  }

  let event: VerifiedEmailEvent | null;
  try {
    event = asRelevantEmailEvent(verified);
  } catch {
    return emptyWebhookResponse(400);
  }
  if (!event) return emptyWebhookResponse(200);

  const tags = event.data.tags;
  if (!tags || tags.app !== RESEND_APP_TAG_VALUE) {
    return emptyWebhookResponse(200);
  }
  const deliveryJobId = tags.delivery_job_id;
  if (!deliveryJobId || !DELIVERY_JOB_ID.test(deliveryJobId)) {
    return emptyWebhookResponse(400);
  }
  if (!SAFE_SVIX_ID.test(webhookId)) return emptyWebhookResponse(400);

  try {
    await recordProviderDeliveryEvent({
      deliveryJobId,
      provider: 'resend',
      providerMessageId: event.data.email_id,
      providerEventKey: webhookId,
      eventType: mapResendEventType(event.type),
      occurredAt: new Date(event.created_at).toISOString(),
      receivedAt: new Date().toISOString(),
      providerCode: providerCode(event.type),
    });
  } catch {
    return emptyWebhookResponse(503);
  }

  return emptyWebhookResponse(200);
}
