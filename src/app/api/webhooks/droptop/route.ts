/**
 * Droptop "orders.finalized" webhook receiver.
 *
 * NOTE: The real DropTop payload shape has not been confirmed. The provisional
 * field paths live only in normalizeDroptopPayload() so they can be replaced
 * without changing or retesting the normalized order workflow.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { sendSurveySMS } from '@/lib/twilio';
import { normalizeDroptopPayload } from '@/server/droptop/normalize-payload';
import {
  processNormalizedOrder,
  type NormalizedOrderDependencies,
} from '@/server/droptop/process-normalized-order';
import type { Json } from '@/types/database';

function createDependencies(): NormalizedOrderDependencies {
  return {
    async createSurvey(survey) {
      const supabase = getSupabaseAdmin();
      const { data, error } = await supabase
        .from('surveys')
        .upsert(
          {
            order_id: survey.orderId,
            location_id: survey.locationId,
            customer_phone: survey.customerPhone,
            customer_name: survey.customerName,
            // request.json() guarantees these provider values are JSON-compatible.
            services: survey.services as Json,
          },
          { onConflict: 'order_id', ignoreDuplicates: true },
        )
        .select('survey_token')
        .maybeSingle();

      if (error) {
        return { created: false, error };
      }

      // ON CONFLICT DO NOTHING returns no representation for the losing
      // concurrent request, which is how the caller distinguishes a duplicate.
      if (!data) {
        return { created: false, error: null };
      }

      const surveyToken = data.survey_token;
      if (typeof surveyToken !== 'string' || surveyToken.length === 0) {
        return {
          created: false,
          error: new Error('Survey creation did not return a survey token'),
        };
      }

      return { created: true, surveyToken, error: null };
    },
    sendSurveySms: sendSurveySMS,
    async markSurveySent(orderId, sentAt) {
      const supabase = getSupabaseAdmin();
      const { error } = await supabase
        .from('surveys')
        .update({ sent_at: sentAt })
        .eq('order_id', orderId);

      return { error };
    },
    now: () => new Date(),
    logger: console,
  };
}

export async function POST(request: NextRequest) {
  try {
    const payload = await request.json().catch(() => null);
    if (!payload) {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const result = await processNormalizedOrder(
      normalizeDroptopPayload(payload),
      createDependencies(),
    );

    return NextResponse.json(result.body, { status: result.status });
  } catch (error) {
    console.error('[droptop webhook] unexpected error', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}
