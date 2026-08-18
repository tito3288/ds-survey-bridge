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

export type NormalizedOrderDependencies = {
  lookupSurvey: (
    orderId: string,
  ) => Promise<{ exists: boolean; error: unknown | null }>;
  insertSurvey: (survey: PendingSurvey) => Promise<OperationResult>;
  sendSurveySms: (message: {
    to: string;
    customerName?: string;
    orderId: string;
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
    lookupSurvey,
    insertSurvey,
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

  const lookup = await lookupSurvey(order.orderId);

  if (lookup.error) {
    logger.error('[droptop webhook] survey lookup failed', lookup.error);
    return {
      status: 500,
      body: { error: 'Internal server error' },
    };
  }

  if (lookup.exists) {
    logger.log('[droptop webhook] duplicate order, skipping', {
      orderId: order.orderId,
    });
    return { status: 200, body: { ok: true, skipped: 'duplicate' } };
  }

  const insert = await insertSurvey({
    orderId: order.orderId,
    locationId: order.locationId,
    customerPhone: order.customerPhone,
    customerName: order.customerName ?? null,
    services: order.services ?? [],
  });

  if (insert.error) {
    logger.error('[droptop webhook] survey insert failed', insert.error);
    return {
      status: 500,
      body: { error: 'Internal server error' },
    };
  }

  // TODO: schedule SMS dispatch ~3 hours after finalization instead of sending immediately.
  try {
    const sid = await sendSurveySms({
      to: order.customerPhone,
      customerName: order.customerName,
      orderId: order.orderId,
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
    // The survey row remains available for a later retry. A successful webhook
    // response prevents DropTop from retrying the entire order.
  }

  return { status: 200, body: { ok: true, orderId: order.orderId } };
}
