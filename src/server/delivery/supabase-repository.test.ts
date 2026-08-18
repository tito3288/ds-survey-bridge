import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import type { Database } from '@/types/database';
import { createSupabaseDeliveryRepository } from './supabase-repository';
import type { ClaimedDeliveryJob } from './types';

const job: ClaimedDeliveryJob = {
  id: '00000000-0000-4000-8000-000000000001',
  surveyId: '10000000-0000-4000-8000-000000000001',
  kind: 'survey_sms',
  attemptCount: 0,
  leaseToken: '20000000-0000-4000-8000-000000000001',
};

function asClient(value: unknown): SupabaseClient<Database> {
  return value as SupabaseClient<Database>;
}

function createQuery(result: unknown) {
  const maybeSingle = vi.fn().mockResolvedValue(result);
  const eq = vi.fn(() => ({ maybeSingle }));
  const select = vi.fn(() => ({ eq }));
  return { select, eq, maybeSingle };
}

describe('Supabase delivery repository', () => {
  it('claims only queue metadata and maps the lease-fenced RPC contract', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [
        {
          id: job.id,
          survey_id: job.surveyId,
          kind: 'survey_sms',
          status: 'processing',
          scheduled_at: '2026-08-18T12:00:00.000Z',
          next_attempt_at: '2026-08-18T12:00:00.000Z',
          attempt_count: 0,
          lease_token: job.leaseToken,
          lease_expires_at: '2026-08-18T12:10:00.000Z',
        },
      ],
      error: null,
    });
    const repository = createSupabaseDeliveryRepository(() =>
      asClient({ rpc }),
    );

    const claimed = await repository.claimDueJobs({
      runId: '30000000-0000-4000-8000-000000000001',
      limit: 20,
      leaseSeconds: 600,
      now: '2026-08-18T12:00:00.000Z',
    });

    expect(rpc).toHaveBeenCalledWith('claim_delivery_jobs', {
      p_run_id: '30000000-0000-4000-8000-000000000001',
      p_limit: 20,
      p_lease_seconds: 600,
      p_now: '2026-08-18T12:00:00.000Z',
    });
    expect(claimed).toEqual([job]);
    expect(Object.keys(claimed[0]).sort()).toEqual(
      ['attemptCount', 'id', 'kind', 'leaseToken', 'surveyId'].sort(),
    );
  });

  it('loads authoritative SMS data from the survey only after claiming', async () => {
    const surveys = createQuery({
      data: {
        order_id: 'ORDER-FAKE',
        location_id: 'FAKE-LOC',
        customer_phone: '+15555550123',
        customer_name: 'Fake Customer',
        services: [],
        survey_token: '00000000-0000-4000-8000-000000000123',
        rating: null,
        comment: null,
        wait_time_score: null,
        service_speed_score: null,
        vehicle_cleanliness_score: null,
        additional_services_experience_score: null,
        value_score: null,
        team_friendliness_score: null,
      },
      error: null,
    });
    const repository = createSupabaseDeliveryRepository(() =>
      asClient({ from: vi.fn(() => surveys) }),
    );

    await expect(repository.loadPayload(job)).resolves.toEqual({
      ok: true,
      payload: {
        kind: 'survey_sms',
        surveyToken: '00000000-0000-4000-8000-000000000123',
        customerPhone: '+15555550123',
        customerName: 'Fake Customer',
      },
    });
  });

  it('loads every private-feedback field plus the mapped location name', async () => {
    const surveys = createQuery({
      data: {
        order_id: 'ORDER-FAKE',
        location_id: 'FAKE-LOC',
        customer_phone: '+15555550123',
        customer_name: 'Fake Customer',
        services: [{ name: 'Oil Change' }],
        survey_token: '00000000-0000-4000-8000-000000000123',
        rating: 2,
        comment: 'Please explain recommendations.',
        wait_time_score: 1,
        service_speed_score: 2,
        vehicle_cleanliness_score: 3,
        additional_services_experience_score: 4,
        value_score: 5,
        team_friendliness_score: 2,
      },
      error: null,
    });
    const locations = createQuery({
      data: { name: 'Fake Training Location' },
      error: null,
    });
    const from = vi.fn((table: string) =>
      table === 'surveys' ? surveys : locations,
    );
    const repository = createSupabaseDeliveryRepository(() =>
      asClient({ from }),
    );

    const result = await repository.loadPayload({
      ...job,
      kind: 'private_feedback_email',
    });

    expect(result).toEqual({
      ok: true,
      payload: {
        kind: 'private_feedback_email',
        orderId: 'ORDER-FAKE',
        rating: 2,
        answers: {
          waitTime: 1,
          serviceSpeed: 2,
          vehicleCleanliness: 3,
          additionalServicesExperience: 4,
          value: 5,
          teamFriendliness: 2,
        },
        comment: 'Please explain recommendations.',
        locationId: 'FAKE-LOC',
        locationName: 'Fake Training Location',
        customerName: 'Fake Customer',
        customerPhone: '+15555550123',
        services: [{ name: 'Oil Change' }],
      },
    });
    expect(locations.eq).toHaveBeenCalledWith(
      'droptop_location_id',
      'FAKE-LOC',
    );
  });

  it('classifies database read failures as retryable without raw errors', async () => {
    const surveys = createQuery({
      data: null,
      error: { message: 'raw database response with PII' },
    });
    const repository = createSupabaseDeliveryRepository(() =>
      asClient({ from: vi.fn(() => surveys) }),
    );

    const result = await repository.loadPayload(job);

    expect(result).toEqual({
      ok: false,
      disposition: 'retry',
      errorCategory: 'payload',
      errorCode: 'survey_read_failed',
    });
    expect(JSON.stringify(result)).not.toContain('raw database response');
  });

  it('dead-letters an incomplete authoritative questionnaire', async () => {
    const surveys = createQuery({
      data: {
        order_id: 'ORDER-FAKE',
        location_id: 'FAKE-LOC',
        customer_phone: '+15555550123',
        customer_name: null,
        services: [],
        survey_token: '00000000-0000-4000-8000-000000000123',
        rating: 2,
        comment: null,
        wait_time_score: 1,
        service_speed_score: null,
        vehicle_cleanliness_score: 3,
        additional_services_experience_score: 4,
        value_score: 5,
        team_friendliness_score: 2,
      },
      error: null,
    });
    const repository = createSupabaseDeliveryRepository(() =>
      asClient({ from: vi.fn(() => surveys) }),
    );

    await expect(
      repository.loadPayload({ ...job, kind: 'private_feedback_email' }),
    ).resolves.toEqual({
      ok: false,
      disposition: 'dead',
      errorCategory: 'payload',
      errorCode: 'invalid_email_payload',
    });
  });

  it('passes sanitized outcomes through every lease-fenced marker RPC', async () => {
    const rpc = vi.fn((name: string) => {
      if (name === 'mark_delivery_job_provider_started') {
        return {
          single: vi.fn().mockResolvedValue({
            data: { started: true, attempt_count: 1 },
            error: null,
          }),
        };
      }
      if (name === 'mark_delivery_job_retry') {
        return {
          single: vi.fn().mockResolvedValue({
            data: {
              status: 'pending',
              next_attempt_at: '2026-08-18T12:05:00.000Z',
              attempt_count: 1,
            },
            error: null,
          }),
        };
      }
      return Promise.resolve({ data: true, error: null });
    });
    const repository = createSupabaseDeliveryRepository(() =>
      asClient({ rpc }),
    );
    const base = {
      jobId: job.id,
      leaseToken: job.leaseToken,
    };

    await repository.markProviderStarted({
      ...base,
      startedAt: '2026-08-18T12:00:00.000Z',
    });
    await repository.markSent({
      ...base,
      providerMessageId: 'SM_fake',
      acceptedAt: '2026-08-18T12:00:01.000Z',
    });
    await repository.markRetry({
      ...base,
      errorCategory: 'provider',
      errorCode: 'twilio_503',
      failedAt: '2026-08-18T12:00:01.000Z',
    });
    await repository.markDead({
      ...base,
      errorCategory: 'payload',
      errorCode: 'invalid_payload',
      failedAt: '2026-08-18T12:00:01.000Z',
    });
    await repository.markUnknown({
      ...base,
      errorCategory: 'provider',
      errorCode: 'twilio_econnreset',
      failedAt: '2026-08-18T12:00:01.000Z',
    });

    expect(rpc.mock.calls.map(([name]) => name)).toEqual([
      'mark_delivery_job_provider_started',
      'mark_delivery_job_sent',
      'mark_delivery_job_retry',
      'mark_delivery_job_dead',
      'mark_delivery_job_unknown',
    ]);
  });
});
