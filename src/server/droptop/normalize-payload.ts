import type { NormalizedOrder } from './process-normalized-order';

// The DropTop contract is not confirmed. Keep every provisional field path in
// this adapter so the normalized order workflow does not depend on them.
type ProvisionalDroptopPayload = {
  data?: {
    id?: string;
    customer?: { name?: string; phone?: string };
    location_id?: string;
    services?: unknown[];
  };
};

/**
 * TODO: Replace these provisional field paths after DropTop supplies a real
 * orders.finalized payload sample and webhook documentation.
 */
export function normalizeDroptopPayload(body: unknown): NormalizedOrder {
  const data = (body as ProvisionalDroptopPayload | null | undefined)?.data;
  const services = data?.services;

  return {
    orderId: data?.id,
    customerName: data?.customer?.name,
    customerPhone: data?.customer?.phone,
    locationId: data?.location_id,
    services: Array.isArray(services) ? services : [],
  };
}
