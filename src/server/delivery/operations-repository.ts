import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import { getRequiredEnv } from '@/lib/env';
import { getSupabaseAdmin } from '@/lib/supabase';
import type {
  DeliveryOperationsRepository,
  TwilioReconciliationCandidate,
} from '@/server/delivery/operations';
import type { Database } from '@/types/database';

type AdminClient = SupabaseClient<Database>;

export class DeliveryOperationsRepositoryError extends Error {
  constructor() {
    super('Delivery operations repository failed');
    this.name = 'DeliveryOperationsRepositoryError';
  }
}

function validateDatabaseConfiguration(
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  const configuredUrl = getRequiredEnv('NEXT_PUBLIC_SUPABASE_URL', env);
  getRequiredEnv('SUPABASE_SERVICE_ROLE_KEY', env);

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(configuredUrl);
  } catch {
    throw new Error('Invalid Supabase URL');
  }

  const isLocalHttp =
    process.env.NODE_ENV !== 'production' &&
    parsedUrl.protocol === 'http:' &&
    (parsedUrl.hostname === 'localhost' || parsedUrl.hostname === '127.0.0.1');
  const isExactOrigin =
    configuredUrl === parsedUrl.origin ||
    configuredUrl === `${parsedUrl.origin}/`;
  if (
    (parsedUrl.protocol !== 'https:' && !isLocalHttp) ||
    parsedUrl.username ||
    parsedUrl.password ||
    parsedUrl.pathname !== '/' ||
    parsedUrl.search ||
    parsedUrl.hash ||
    !isExactOrigin
  ) {
    throw new Error('Invalid Supabase URL');
  }
}

function repositoryFailure(): never {
  throw new DeliveryOperationsRepositoryError();
}

export function createDeliveryOperationsRepository(
  getClient: () => AdminClient = getSupabaseAdmin,
): DeliveryOperationsRepository {
  return {
    validateConfiguration() {
      validateDatabaseConfiguration();
    },

    async getHealthSummary(now) {
      const { data, error } = await getClient()
        .rpc('get_delivery_health_summary', { p_now: now })
        .single();
      if (error || !data) repositoryFailure();

      return {
        overdueCount: data.overdue_count,
        staleCount: data.stale_count,
        deadCount: data.dead_count,
        unknownCount: data.unknown_count,
        failedCount: data.failed_count,
        mixedCount: data.mixed_count,
        complainedCount: data.complained_count,
      };
    },

    async getTwilioReconciliationCandidates(input) {
      const { data, error } = await getClient().rpc(
        'get_twilio_reconciliation_candidates',
        { p_now: input.now, p_limit: input.limit },
      );
      if (error || !data) repositoryFailure();

      return data.map(
        (row): TwilioReconciliationCandidate => ({
          deliveryJobId: row.delivery_job_id,
          providerMessageId: row.provider_message_id,
        }),
      );
    },

    async purgeDeliveryEvents(input) {
      const { data, error } = await getClient().rpc('purge_delivery_events', {
        p_now: input.now,
        p_limit: input.limit,
      });
      if (error || data === null) repositoryFailure();
      return data;
    },
  };
}
