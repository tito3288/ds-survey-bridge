/**
 * Droptop "orders.finalized" webhook receiver.
 *
 * NOTE: The real DropTop payload shape has not been confirmed. The provisional
 * field paths live only in normalizeDroptopPayload() so they can be replaced
 * without changing or retesting the normalized order workflow.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { normalizeDroptopPayload } from '@/server/droptop/normalize-payload';
import {
  processNormalizedOrder,
  type NormalizedOrderDependencies,
} from '@/server/droptop/process-normalized-order';
import type { Json } from '@/types/database';

function getSmsScheduledAt(now = new Date()): string {
  const configuredDelay = process.env.SURVEY_SMS_DELAY_MINUTES?.trim() || '0';
  const delayMinutes = Number(configuredDelay);

  if (
    !/^\d+$/.test(configuredDelay) ||
    !Number.isSafeInteger(delayMinutes) ||
    delayMinutes < 0
  ) {
    throw new Error(
      'SURVEY_SMS_DELAY_MINUTES must be a non-negative whole number',
    );
  }

  const scheduledAt = new Date(now.getTime() + delayMinutes * 60_000);
  if (!Number.isFinite(scheduledAt.getTime())) {
    throw new Error('SURVEY_SMS_DELAY_MINUTES is outside the supported range');
  }

  return scheduledAt.toISOString();
}

function createDependencies(): NormalizedOrderDependencies {
  return {
    async createSurveyWithSmsJob(survey) {
      const supabase = getSupabaseAdmin();
      const { data, error } = await supabase
        .rpc('create_survey_with_sms_job', {
          p_order_id: survey.orderId,
          p_location_id: survey.locationId,
          p_customer_phone: survey.customerPhone,
          p_customer_name: survey.customerName ?? '',
          // request.json() guarantees these provider values are JSON-compatible.
          p_services: survey.services as Json,
          p_scheduled_at: getSmsScheduledAt(),
        })
        .single();

      if (error) {
        return { created: false, error };
      }

      if (!data) {
        return {
          created: false,
          error: new Error('Survey creation did not return a result'),
        };
      }

      return data.created
        ? { created: true, error: null }
        : { created: false, error: null };
    },
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
