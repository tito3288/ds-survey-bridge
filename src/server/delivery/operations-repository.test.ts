import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import {
  DeliveryOperationsRepositoryError,
  createDeliveryOperationsRepository,
} from './operations-repository';

type AdminClient = SupabaseClient<Database>;

describe('delivery operations repository', () => {
  it('maps the aggregate health RPC without exposing job or customer rows', async () => {
    const single = vi.fn().mockResolvedValue({
      data: {
        overdue_count: 1,
        stale_count: 2,
        dead_count: 3,
        unknown_count: 4,
        failed_count: 5,
        mixed_count: 6,
        complained_count: 7,
      },
      error: null,
    });
    const rpc = vi.fn().mockReturnValue({ single });
    const repository = createDeliveryOperationsRepository(
      () => ({ rpc }) as unknown as AdminClient,
    );

    await expect(
      repository.getHealthSummary('2026-08-18T12:00:00.000Z'),
    ).resolves.toEqual({
      overdueCount: 1,
      staleCount: 2,
      deadCount: 3,
      unknownCount: 4,
      failedCount: 5,
      mixedCount: 6,
      complainedCount: 7,
    });
    expect(rpc).toHaveBeenCalledWith('get_delivery_health_summary', {
      p_now: '2026-08-18T12:00:00.000Z',
    });
  });

  it('maps only opaque Twilio reconciliation identifiers', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [
        {
          delivery_job_id: '11111111-1111-4111-8111-111111111111',
          provider_message_id: `SM${'1'.repeat(32)}`,
        },
      ],
      error: null,
    });
    const repository = createDeliveryOperationsRepository(
      () => ({ rpc }) as unknown as AdminClient,
    );

    await expect(
      repository.getTwilioReconciliationCandidates({
        now: '2026-08-18T12:00:00.000Z',
        limit: 20,
      }),
    ).resolves.toEqual([
      {
        deliveryJobId: '11111111-1111-4111-8111-111111111111',
        providerMessageId: `SM${'1'.repeat(32)}`,
      },
    ]);
    expect(rpc).toHaveBeenCalledWith(
      'get_twilio_reconciliation_candidates',
      { p_now: '2026-08-18T12:00:00.000Z', p_limit: 20 },
    );
  });

  it('runs a bounded receipt cleanup through its service-only RPC', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: 42, error: null });
    const repository = createDeliveryOperationsRepository(
      () => ({ rpc }) as unknown as AdminClient,
    );

    await expect(
      repository.purgeDeliveryEvents({
        now: '2026-08-18T12:00:00.000Z',
        limit: 1_000,
      }),
    ).resolves.toBe(42);
  });

  it('converts raw database failures into a fixed internal error', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: { message: 'customer phone +15555550123' },
    });
    const repository = createDeliveryOperationsRepository(
      () => ({ rpc }) as unknown as AdminClient,
    );

    await expect(
      repository.getTwilioReconciliationCandidates({
        now: '2026-08-18T12:00:00.000Z',
        limit: 20,
      }),
    ).rejects.toEqual(new DeliveryOperationsRepositoryError());
  });
});
