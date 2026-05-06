import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);

  if (!body || typeof body.orderId !== 'string' || typeof body.rating !== 'number') {
    return NextResponse.json({ error: 'orderId and rating are required' }, { status: 400 });
  }

  const { orderId, rating, comment } = body as {
    orderId: string;
    rating: number;
    comment?: string;
  };

  // TODO: look up order + location in Supabase
  // TODO: persist response to Supabase
  // TODO: if rating >= 3, return location's Google review URL
  // TODO: if rating < 3, send email to support@driveandshine.com via Resend

  if (rating >= 3) {
    return NextResponse.json({
      redirectUrl: 'https://www.google.com/search?q=drive+and+shine',
    });
  }

  console.log('[survey submit] low rating', { orderId, rating, comment });
  return NextResponse.json({ ok: true });
}
