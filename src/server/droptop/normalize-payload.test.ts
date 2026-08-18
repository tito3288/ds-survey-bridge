import { describe, expect, it } from 'vitest';
import { normalizeDroptopPayload } from './normalize-payload';

describe('provisional DropTop payload adapter', () => {
  it('fails safely to an empty normalized order for an unknown payload', () => {
    expect(normalizeDroptopPayload(null)).toEqual({
      orderId: undefined,
      customerName: undefined,
      customerPhone: undefined,
      locationId: undefined,
      services: [],
    });
  });
});
