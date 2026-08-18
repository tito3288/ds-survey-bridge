export type NormalizedOrder = {
  orderId?: string;
  customerName?: string;
  customerPhone?: string;
  locationId?: string;
  services?: unknown[];
};

export type PendingSurvey = {
  orderId: string;
  locationId: string;
  customerPhone: string;
  customerName: string | null;
  services: unknown[];
};

type OperationResult = {
  error: unknown | null;
};

export type SurveyCreationResult =
  | {
      created: true;
      surveyToken: string;
      error: null;
    }
  | {
      created: false;
      error: null;
    }
  | {
      created: false;
      error: unknown;
    };

export type NormalizedOrderDependencies = {
  createSurvey: (survey: PendingSurvey) => Promise<SurveyCreationResult>;
  sendSurveySms: (message: {
    to: string;
    customerName?: string;
    surveyToken: string;
  }) => Promise<string>;
  markSurveySent: (
    orderId: string,
    sentAt: string,
  ) => Promise<OperationResult>;
  now: () => Date;
  logger: Pick<Console, 'log' | 'warn' | 'error'>;
};

export type NormalizedOrderResult =
  | {
      status: 200;
      body: {
        ok: true;
        skipped: 'missing_fields' | 'not_oil_change' | 'duplicate';
      };
    }
  | {
      status: 200;
      body: { ok: true; orderId: string };
    }
  | {
      status: 500;
      body: { error: 'Internal server error' };
    };

function isOilChange(services: unknown[]): boolean {
  return services.some((service) => {
    if (!service || typeof service !== 'object') return false;

    const name = (service as { name?: unknown }).name;
    return (
      typeof name === 'string' && name.toLowerCase().includes('oil change')
    );
  });
}

/**
 * Handles an order after the provider-specific payload has been normalized.
 * Keeping this provider-neutral prevents tests from treating the provisional
 * DropTop field paths as an established webhook contract.
 */
export async function processNormalizedOrder(
  order: NormalizedOrder,
  dependencies: NormalizedOrderDependencies,
): Promise<NormalizedOrderResult> {
  const {
    createSurvey,
    sendSurveySms,
    markSurveySent,
    now,
    logger,
  } = dependencies;

  if (!order.orderId || !order.customerPhone || !order.locationId) {
    logger.warn('[droptop webhook] missing required fields, skipping', {
      hasOrderId: !!order.orderId,
      hasPhone: !!order.customerPhone,
      hasLocation: !!order.locationId,
    });
    return { status: 200, body: { ok: true, skipped: 'missing_fields' } };
  }

  if (!isOilChange(order.services ?? [])) {
    logger.log('[droptop webhook] skipping non-oil-change order', {
      orderId: order.orderId,
    });
    return { status: 200, body: { ok: true, skipped: 'not_oil_change' } };
  }

  // A single insert protected by surveys.order_id's unique constraint makes
  // duplicate detection race-safe. A separate lookup can allow two concurrent
  // deliveries to both observe "missing" and both attempt to send.
  const creation = await createSurvey({
    orderId: order.orderId,
    locationId: order.locationId,
    customerPhone: order.customerPhone,
    customerName: order.customerName ?? null,
    services: order.services ?? [],
  });

  if (creation.error) {
    logger.error('[droptop webhook] survey insert failed', creation.error);
    return {
      status: 500,
      body: { error: 'Internal server error' },
    };
  }

  if (!creation.created) {
    logger.log('[droptop webhook] duplicate order, skipping', {
      orderId: order.orderId,
    });
    return { status: 200, body: { ok: true, skipped: 'duplicate' } };
  }

  // TODO: schedule SMS dispatch ~3 hours after finalization instead of sending immediately.
  try {
    const sid = await sendSurveySms({
      to: order.customerPhone,
      customerName: order.customerName,
      surveyToken: creation.surveyToken,
    });
    logger.log('[droptop webhook] SMS sent', {
      orderId: order.orderId,
      sid,
    });

    const sentAt = await markSurveySent(order.orderId, now().toISOString());

    if (sentAt.error) {
      logger.error('[droptop webhook] sent_at update failed', sentAt.error);
    }
  } catch (smsError) {
    logger.error('[droptop webhook] SMS send failed', smsError);
    // Keep the unsent survey record for Batch 5's durable delivery recovery.
    // A successful webhook response prevents DropTop from replaying the order.
  }

  return { status: 200, body: { ok: true, orderId: order.orderId } };
}
