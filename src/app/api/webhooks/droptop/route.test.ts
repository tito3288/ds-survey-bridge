import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSupabaseAdmin: vi.fn(),
  sendSurveySMS: vi.fn(),
  normalizeDroptopPayload: vi.fn(),
}));

vi.mock('@/lib/supabase', () => ({
  getSupabaseAdmin: mocks.getSupabaseAdmin,
}));

vi.mock('@/lib/twilio', () => ({
  sendSurveySMS: mocks.sendSurveySMS,
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
  mocks.getSupabaseAdmin.mockReset();
  mocks.sendSurveySMS.mockReset();
  mocks.normalizeDroptopPayload.mockReset();
  mocks.normalizeDroptopPayload.mockReturnValue({});
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('POST /api/webhooks/droptop', () => {
  it('returns 400 for invalid JSON before initializing providers', async () => {
    const response = await POST(createRequest('{invalid-json'));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid JSON body' });
    expect(mocks.getSupabaseAdmin).not.toHaveBeenCalled();
    expect(mocks.sendSurveySMS).not.toHaveBeenCalled();
  });

  it('acknowledges a missing-field event without touching providers', async () => {
    const response = await POST(createRequest('{}'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      skipped: 'missing_fields',
    });
    expect(mocks.getSupabaseAdmin).not.toHaveBeenCalled();
    expect(mocks.sendSurveySMS).not.toHaveBeenCalled();
  });

  it('wires normalized orders to local persistence and SMS boundaries', async () => {
    mocks.normalizeDroptopPayload.mockReturnValue({
      orderId: 'fake-order-123',
      customerName: 'Fake Customer',
      customerPhone: '+15555550123',
      locationId: 'FAKE-LOC-001',
      services: [{ name: 'Fake Oil Change' }],
    });

    const maybeSingle = vi.fn(async () => ({ data: null, error: null }));
    const lookupQuery = {
      select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle })) })),
    };
    const insert = vi.fn(async () => ({ error: null }));
    const insertQuery = { insert };
    const sentAtEq = vi.fn(async () => ({ error: null }));
    const update = vi.fn(() => ({ eq: sentAtEq }));
    const updateQuery = { update };
    const from = vi
      .fn()
      .mockReturnValueOnce(lookupQuery)
      .mockReturnValueOnce(insertQuery)
      .mockReturnValueOnce(updateQuery);
    mocks.getSupabaseAdmin.mockReturnValue({ from });
    mocks.sendSurveySMS.mockResolvedValue('SM_fake_123');

    const response = await POST(createRequest('{"provider":"unconfirmed"}'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      orderId: 'fake-order-123',
    });
    expect(insert).toHaveBeenCalledWith({
      order_id: 'fake-order-123',
      location_id: 'FAKE-LOC-001',
      customer_phone: '+15555550123',
      customer_name: 'Fake Customer',
      services: [{ name: 'Fake Oil Change' }],
    });
    expect(mocks.sendSurveySMS).toHaveBeenCalledWith({
      to: '+15555550123',
      customerName: 'Fake Customer',
      orderId: 'fake-order-123',
    });
    expect(update).toHaveBeenCalledWith({ sent_at: expect.any(String) });
  });
});
