/**
 * Droptop "orders.finalized" webhook receiver.
 *
 * NOTE: This is a placeholder implementation. The real Droptop payload shape
 * has not been confirmed yet — field paths in extractOrderFromPayload() below
 * are best guesses based on a sample structure provided by the team. Once
 * Droptop sends a real sample, update extractOrderFromPayload() to match.
 */

import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { sendSurveySMS } from '@/lib/twilio';

type NormalizedOrder = {
  orderId?: string;
  customerName?: string;
  customerPhone?: string;
  locationId?: string;
  services?: unknown[];
};

// TODO: replace with real Droptop field paths once payload is confirmed.
type DroptopPayload = {
  data?: {
    id?: string;
    customer?: { name?: string; phone?: string };
    location_id?: string;
    services?: unknown[];
  };
};

function extractOrderFromPayload(body: unknown): NormalizedOrder {
  const data = (body as DroptopPayload | null | undefined)?.data;
  const customer = data?.customer;
  const rawServices = data?.services;
  return {
    orderId: data?.id,                       // TODO: confirm
    customerName: customer?.name,            // TODO: confirm
    customerPhone: customer?.phone,          // TODO: confirm
    locationId: data?.location_id,           // TODO: confirm
    services: Array.isArray(rawServices) ? rawServices : [], // TODO: confirm
  };
}

function isOilChange(services: unknown[]): boolean {
  return services.some((s) => {
    if (!s || typeof s !== 'object') return false;
    const name = (s as { name?: unknown }).name;
    return typeof name === 'string' && name.toLowerCase().includes('oil change');
  });
}

export async function POST(request: NextRequest) {
  try {
    const payload = await request.json().catch(() => null);
    if (!payload) {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const order = extractOrderFromPayload(payload);

    if (!order.orderId || !order.customerPhone || !order.locationId) {
      console.warn('[droptop webhook] missing required fields, skipping', {
        hasOrderId: !!order.orderId,
        hasPhone: !!order.customerPhone,
        hasLocation: !!order.locationId,
      });
      return NextResponse.json({ ok: true, skipped: 'missing_fields' });
    }

    if (!isOilChange(order.services ?? [])) {
      console.log('[droptop webhook] skipping non-oil-change order', {
        orderId: order.orderId,
      });
      return NextResponse.json({ ok: true, skipped: 'not_oil_change' });
    }

    const { data: existing, error: lookupError } = await supabaseAdmin
      .from('surveys')
      .select('id')
      .eq('order_id', order.orderId)
      .maybeSingle();

    if (lookupError) {
      console.error('[droptop webhook] survey lookup failed', lookupError);
      return NextResponse.json(
        { error: 'Internal server error' },
        { status: 500 },
      );
    }

    if (existing) {
      console.log('[droptop webhook] duplicate order, skipping', {
        orderId: order.orderId,
      });
      return NextResponse.json({ ok: true, skipped: 'duplicate' });
    }

    const { error: insertError } = await supabaseAdmin.from('surveys').insert({
      order_id: order.orderId,
      location_id: order.locationId,
      customer_phone: order.customerPhone,
      customer_name: order.customerName ?? null,
      services: order.services ?? [],
    });

    if (insertError) {
      console.error('[droptop webhook] survey insert failed', insertError);
      return NextResponse.json(
        { error: 'Internal server error' },
        { status: 500 },
      );
    }

    // TODO: schedule SMS dispatch ~3 hours after finalizedAt instead of sending immediately.
    try {
      const sid = await sendSurveySMS({
        to: order.customerPhone,
        customerName: order.customerName,
        orderId: order.orderId,
      });
      console.log('[droptop webhook] SMS sent', {
        orderId: order.orderId,
        sid,
      });

      const { error: sentAtError } = await supabaseAdmin
        .from('surveys')
        .update({ sent_at: new Date().toISOString() })
        .eq('order_id', order.orderId);

      if (sentAtError) {
        console.error('[droptop webhook] sent_at update failed', sentAtError);
      }
    } catch (smsError) {
      console.error('[droptop webhook] SMS send failed', smsError);
      // Row is saved; can retry later via cron. Return 200 so Droptop doesn't retry the whole webhook.
    }

    return NextResponse.json({ ok: true, orderId: order.orderId });
  } catch (error) {
    console.error('[droptop webhook] unexpected error', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}
