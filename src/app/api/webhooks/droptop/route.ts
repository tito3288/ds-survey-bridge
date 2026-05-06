import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest) {
  const payload = await request.json().catch(() => null);

  if (!payload) {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  // TODO: validate Droptop signature
  // TODO: persist order to Supabase (orderId, customerPhone, locationId, finalizedAt)
  // TODO: schedule SMS dispatch ~3 hours after finalizedAt

  console.log('[droptop webhook] received', payload);

  return NextResponse.json({ received: true });
}
