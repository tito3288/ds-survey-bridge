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

export type SurveyCreationResult =
  | {
      created: true;
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
  createSurveyWithSmsJob: (
    survey: PendingSurvey,
  ) => Promise<SurveyCreationResult>;
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
  const { createSurveyWithSmsJob, logger } = dependencies;

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

  // Survey persistence and SMS scheduling share one database transaction. The
  // database also resolves concurrent order duplicates, so the request path
  // never needs to contact Twilio or recover a partially enqueued survey.
  const creation = await createSurveyWithSmsJob({
    orderId: order.orderId,
    locationId: order.locationId,
    customerPhone: order.customerPhone,
    customerName: order.customerName ?? null,
    services: order.services ?? [],
  });

  if (creation.error) {
    logger.error(
      '[droptop webhook] survey and SMS job creation failed',
      creation.error,
    );
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

  return { status: 200, body: { ok: true, orderId: order.orderId } };
}
