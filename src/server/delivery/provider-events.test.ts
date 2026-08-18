import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import {
  buildTwilioProviderEventKey,
  mapTwilioStatusToDeliveryEventType,
  ProviderDeliveryEventRepositoryError,
  recordProviderDeliveryEvent,
} from './provider-events';

const messageSid = `SM${'a'.repeat(32)}`;

function clientReturning(
  response: { data: unknown; error: unknown },
): {
  client: SupabaseClient<Database>;
  rpc: ReturnType<typeof vi.fn>;
} {
  const single = vi.fn().mockResolvedValue(response);
  const rpc = vi.fn().mockReturnValue({ single });
  return {
    client: { rpc } as unknown as SupabaseClient<Database>,
    rpc,
  };
}

describe('provider delivery events', () => {
  it.each([
    ['accepted', 'accepted'],
    ['queued', 'accepted'],
    ['sent', 'accepted'],
    ['delivered', 'delivered'],
    ['read', 'delivered'],
    ['failed', 'failed'],
    ['partially_delivered', 'failed'],
    ['undelivered', 'failed'],
    ['canceled', 'failed'],
  ] as const)('maps Twilio %s to %s', (status, eventType) => {
    expect(mapTwilioStatusToDeliveryEventType(status)).toBe(eventType);
  });

  it('builds the same deterministic Twilio key for callbacks and polling', () => {
    expect(
      buildTwilioProviderEventKey(messageSid, 'undelivered', 30003),
    ).toBe(`message/${messageSid}/undelivered/30003`);
    expect(buildTwilioProviderEventKey(messageSid, 'delivered', null)).toBe(
      `message/${messageSid}/delivered/none`,
    );
  });

  it('records normalized events through the sole database RPC boundary', async () => {
    const { client, rpc } = clientReturning({
      data: {
        outcome: 'recorded',
        job_status: 'sent',
        downstream_status: 'delivered',
      },
      error: null,
    });
    const input = {
      deliveryJobId: '10000000-0000-4000-8000-000000000123',
      provider: 'twilio' as const,
      providerMessageId: messageSid,
      providerEventKey: `message/${messageSid}/delivered/none`,
      eventType: 'delivered' as const,
      occurredAt: '2026-08-18T12:00:00.000Z',
      receivedAt: '2026-08-18T12:00:01.000Z',
      providerCode: null,
    };

    await expect(
      recordProviderDeliveryEvent(input, () => client),
    ).resolves.toEqual({
      outcome: 'recorded',
      jobStatus: 'sent',
      downstreamStatus: 'delivered',
    });
    expect(rpc).toHaveBeenCalledWith('record_delivery_event', {
      p_delivery_job_id: input.deliveryJobId,
      p_provider: 'twilio',
      p_provider_message_id: messageSid,
      p_provider_event_key: input.providerEventKey,
      p_event_type: 'delivered',
      p_occurred_at: input.occurredAt,
      p_received_at: input.receivedAt,
      p_provider_code: '',
    });
  });

  it('exposes no raw database failure', async () => {
    const { client } = clientReturning({
      data: null,
      error: { message: 'raw database details' },
    });

    await expect(
      recordProviderDeliveryEvent(
        {
          deliveryJobId: '10000000-0000-4000-8000-000000000123',
          provider: 'resend',
          providerMessageId: 'email_fake',
          providerEventKey: 'webhook/msg_fake',
          eventType: 'failed',
          occurredAt: '2026-08-18T12:00:00.000Z',
          receivedAt: '2026-08-18T12:00:01.000Z',
          providerCode: 'resend_failed',
        },
        () => client,
      ),
    ).rejects.toEqual(new ProviderDeliveryEventRepositoryError());
  });
});
