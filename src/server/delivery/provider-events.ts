import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAdmin } from '@/lib/supabase';
import {
  isTwilioMessageSid,
  normalizeTwilioMessageStatus,
  type TwilioOutboundMessageStatus,
} from '@/lib/twilio';
import type { Database } from '@/types/database';

export type DeliveryProvider = 'twilio' | 'resend';
export type DeliveryEventType =
  | 'accepted'
  | 'delivered'
  | 'delayed'
  | 'failed'
  | 'complained';
export type DeliveryDownstreamStatus =
  | 'delivered'
  | 'delayed'
  | 'failed'
  | 'mixed'
  | 'complained';

export type ProviderDeliveryEventInput = {
  deliveryJobId: string;
  provider: DeliveryProvider;
  providerMessageId: string;
  providerEventKey: string;
  eventType: DeliveryEventType;
  occurredAt: string;
  receivedAt: string;
  providerCode: string | null;
};

export type ProviderDeliveryEventResult = {
  outcome:
    | 'recorded'
    | 'duplicate'
    | 'not_found'
    | 'provider_kind_mismatch'
    | 'provider_message_mismatch'
    | 'provider_message_conflict'
    | 'event_key_conflict'
    | 'event_type_mismatch';
  jobStatus: 'pending' | 'processing' | 'sent' | 'dead' | 'unknown' | null;
  downstreamStatus: DeliveryDownstreamStatus | null;
};

type AdminClient = SupabaseClient<Database>;

export class ProviderDeliveryEventRepositoryError extends Error {
  constructor() {
    super('Provider delivery event could not be recorded');
    this.name = 'ProviderDeliveryEventRepositoryError';
  }
}

export function mapTwilioStatusToDeliveryEventType(
  status: TwilioOutboundMessageStatus,
): DeliveryEventType {
  if (status === 'delivered' || status === 'read') return 'delivered';
  if (
    status === 'failed' ||
    status === 'partially_delivered' ||
    status === 'undelivered' ||
    status === 'canceled'
  ) {
    return 'failed';
  }
  return 'accepted';
}

export function buildTwilioProviderEventKey(
  messageSid: string,
  status: unknown,
  errorCode: unknown,
): string {
  if (!isTwilioMessageSid(messageSid)) {
    throw new Error('Invalid Twilio message SID');
  }
  const normalized = normalizeTwilioMessageStatus(status, errorCode);
  if (!normalized) {
    throw new Error('Invalid Twilio message status');
  }

  return `message/${messageSid}/${normalized.status}/${normalized.errorCode ?? 'none'}`;
}

export async function recordProviderDeliveryEvent(
  input: ProviderDeliveryEventInput,
  getClient: () => AdminClient = getSupabaseAdmin,
): Promise<ProviderDeliveryEventResult> {
  const { data, error } = await getClient()
    .rpc('record_delivery_event', {
      p_delivery_job_id: input.deliveryJobId,
      p_provider: input.provider,
      p_provider_message_id: input.providerMessageId,
      p_provider_event_key: input.providerEventKey,
      p_event_type: input.eventType,
      p_occurred_at: input.occurredAt,
      p_received_at: input.receivedAt,
      p_provider_code: input.providerCode ?? '',
    })
    .single();

  if (error || !data) {
    throw new ProviderDeliveryEventRepositoryError();
  }

  return {
    outcome: data.outcome as ProviderDeliveryEventResult['outcome'],
    jobStatus: data.job_status,
    downstreamStatus: data.downstream_status,
  };
}
