import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSupabaseAdmin: vi.fn(),
  normalizeDroptopPayload: vi.fn(),
}));

vi.mock('@/lib/supabase', () => ({
  getSupabaseAdmin: mocks.getSupabaseAdmin,
}));

vi.mock('@/server/droptop/normalize-payload', () => ({
  normalizeDroptopPayload: mocks.normalizeDroptopPayload,
}));

import { POST } from './route';

function createRequest(body: string): NextRequest {
  return new NextRequest('http://127.0.0.1/api/webhooks/droptop', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
}

beforeEach(() => {
  vi.stubEnv('SURVEY_SMS_DELAY_MINUTES', '0');
  mocks.getSupabaseAdmin.mockReset();
  mocks.normalizeDroptopPayload.mockReset();
  mocks.normalizeDroptopPayload.mockReturnValue({});
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('POST /api/webhooks/droptop', () => {
  it('returns 400 for invalid JSON before initializing providers', async () => {
    const response = await POST(createRequest('{invalid-json'));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid JSON body' });
    expect(mocks.getSupabaseAdmin).not.toHaveBeenCalled();
  });

  it('acknowledges a missing-field event without touching providers', async () => {
    const response = await POST(createRequest('{}'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      skipped: 'missing_fields',
    });
    expect(mocks.getSupabaseAdmin).not.toHaveBeenCalled();
  });

  it('atomically creates a survey and immediate SMS job without calling Twilio', async () => {
    mocks.normalizeDroptopPayload.mockReturnValue({
      orderId: 'fake-order-123',
      customerName: 'Fake Customer',
      customerPhone: '+15555550123',
      locationId: 'FAKE-LOC-001',
      services: [{ name: 'Fake Oil Change' }],
    });

    const single = vi.fn(async () => ({
      data: {
        created: true,
        survey_id: '33333333-3333-4333-8333-333333333333',
        survey_token: '00000000-0000-4000-8000-000000000123',
        delivery_job_id: '44444444-4444-4444-8444-444444444444',
      },
      error: null,
    }));
    const rpc = vi.fn(
      (name: string, params: Record<string, unknown>) => {
        void name;
        void params;
        return { single };
      },
    );
    mocks.getSupabaseAdmin.mockReturnValue({ rpc });

    const response = await POST(createRequest('{"provider":"unconfirmed"}'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      orderId: 'fake-order-123',
    });
    expect(rpc).toHaveBeenCalledWith(
      'create_survey_with_sms_job',
      {
        p_order_id: 'fake-order-123',
        p_location_id: 'FAKE-LOC-001',
        p_customer_phone: '+15555550123',
        p_customer_name: 'Fake Customer',
        p_services: [{ name: 'Fake Oil Change' }],
        p_scheduled_at: expect.any(String),
      },
    );
    const scheduledAt = new Date(
      rpc.mock.calls[0]?.[1].p_scheduled_at as string,
    );
    expect(Math.abs(scheduledAt.getTime() - Date.now())).toBeLessThan(5_000);
  });

  it('atomically acknowledges a duplicate order without sending another SMS', async () => {
    mocks.normalizeDroptopPayload.mockReturnValue({
      orderId: 'fake-order-duplicate',
      customerName: 'Fake Customer',
      customerPhone: '+15555550123',
      locationId: 'FAKE-LOC-001',
      services: [{ name: 'Fake Oil Change' }],
    });

    const single = vi.fn(async () => ({
      data: {
        created: false,
        survey_id: null,
        survey_token: null,
        delivery_job_id: null,
      },
      error: null,
    }));
    const rpc = vi.fn(() => ({ single }));
    mocks.getSupabaseAdmin.mockReturnValue({ rpc });

    const response = await POST(createRequest('{"provider":"unconfirmed"}'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      skipped: 'duplicate',
    });
    expect(rpc).toHaveBeenCalledWith(
      'create_survey_with_sms_job',
      expect.objectContaining({ p_order_id: 'fake-order-duplicate' }),
    );
    expect(rpc).toHaveBeenCalledOnce();
  });

  it('returns a safe internal error when atomic creation fails', async () => {
    mocks.normalizeDroptopPayload.mockReturnValue({
      orderId: 'fake-order-database-error',
      customerPhone: '+15555550123',
      locationId: 'FAKE-LOC-001',
      services: [{ name: 'Fake Oil Change' }],
    });

    const single = vi.fn(async () => ({
      data: null,
      error: {
        code: 'XX000',
        message: 'database unavailable',
      },
    }));
    const rpc = vi.fn(() => ({ single }));
    mocks.getSupabaseAdmin.mockReturnValue({ rpc });

    const response = await POST(createRequest('{"provider":"unconfirmed"}'));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal server error' });
  });

  it('applies a configured delay when scheduling the SMS job', async () => {
    vi.stubEnv('SURVEY_SMS_DELAY_MINUTES', '15');
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-18T12:00:00.000Z'));
    mocks.normalizeDroptopPayload.mockReturnValue({
      orderId: 'fake-order-delayed',
      customerPhone: '+15555550123',
      locationId: 'FAKE-LOC-001',
      services: [{ name: 'Fake Oil Change' }],
    });
    const single = vi.fn(async () => ({
      data: {
        created: true,
        survey_id: '33333333-3333-4333-8333-333333333333',
        survey_token: '00000000-0000-4000-8000-000000000123',
        delivery_job_id: '44444444-4444-4444-8444-444444444444',
      },
      error: null,
    }));
    const rpc = vi.fn(() => ({ single }));
    mocks.getSupabaseAdmin.mockReturnValue({ rpc });

    const response = await POST(createRequest('{}'));

    expect(response.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith(
      'create_survey_with_sms_job',
      expect.objectContaining({
        p_customer_name: '',
        p_scheduled_at: '2026-08-18T12:15:00.000Z',
      }),
    );
    vi.useRealTimers();
  });

  it('rejects malformed SMS delay configuration before calling the RPC', async () => {
    vi.stubEnv('SURVEY_SMS_DELAY_MINUTES', '3.5');
    mocks.normalizeDroptopPayload.mockReturnValue({
      orderId: 'fake-order-bad-config',
      customerPhone: '+15555550123',
      locationId: 'FAKE-LOC-001',
      services: [{ name: 'Fake Oil Change' }],
    });
    const rpc = vi.fn();
    mocks.getSupabaseAdmin.mockReturnValue({ rpc });

    const response = await POST(createRequest('{}'));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal server error' });
    expect(rpc).not.toHaveBeenCalled();
  });
});
