import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { sendNegativeFeedbackEmail } from '@/lib/resend';

const FALLBACK_GOOGLE_URL = 'https://www.google.com/search?q=drive+and+shine';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null);

    if (
      !body ||
      typeof body.orderId !== 'string' ||
      body.orderId.length === 0 ||
      typeof body.rating !== 'number' ||
      !Number.isInteger(body.rating) ||
      body.rating < 1 ||
      body.rating > 5
    ) {
      return NextResponse.json(
        { error: 'orderId (string) and rating (integer 1-5) are required' },
        { status: 400 },
      );
    }

    if (body.comment !== undefined && typeof body.comment !== 'string') {
      return NextResponse.json(
        { error: 'comment must be a string' },
        { status: 400 },
      );
    }

    const { orderId, rating, comment } = body as {
      orderId: string;
      rating: number;
      comment?: string;
    };

    const { data: survey, error: surveyError } = await supabaseAdmin
      .from('surveys')
      .select('id, location_id, customer_phone')
      .eq('order_id', orderId)
      .maybeSingle();

    if (surveyError) {
      console.error('[survey submit] survey lookup failed', surveyError);
      return NextResponse.json(
        { error: 'Internal server error' },
        { status: 500 },
      );
    }

    if (!survey) {
      return NextResponse.json({ error: 'Order not found' }, { status: 404 });
    }

    const isFirstSubmit = comment === undefined;
    const update: Record<string, unknown> = { rating };
    if (isFirstSubmit) {
      update.responded_at = new Date().toISOString();
    } else {
      update.comment = comment;
    }

    const { error: updateError } = await supabaseAdmin
      .from('surveys')
      .update(update)
      .eq('order_id', orderId);

    if (updateError) {
      console.error('[survey submit] survey update failed', updateError);
      return NextResponse.json(
        { error: 'Internal server error' },
        { status: 500 },
      );
    }

    const { data: location, error: locationError } = await supabaseAdmin
      .from('locations')
      .select('name, google_review_url')
      .eq('droptop_location_id', survey.location_id)
      .maybeSingle();

    if (locationError) {
      console.error('[survey submit] location lookup failed', locationError);
    }

    if (rating >= 3) {
      return NextResponse.json({
        redirectUrl: location?.google_review_url || FALLBACK_GOOGLE_URL,
      });
    }

    if (comment) {
      try {
        await sendNegativeFeedbackEmail({
          orderId,
          rating,
          comment,
          locationId: survey.location_id,
          locationName: location?.name,
          customerPhone: survey.customer_phone ?? undefined,
        });
      } catch (emailError) {
        console.error('[survey submit] email send failed', emailError);
      }
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('[survey submit] unexpected error', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}
