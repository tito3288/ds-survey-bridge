import { createDeliveryProviders } from '../src/server/delivery/providers';
import { runDeliveryWorkerProcess } from '../src/server/delivery/process';
import { createSupabaseDeliveryRepository } from '../src/server/delivery/supabase-repository';

void runDeliveryWorkerProcess({
  repository: createSupabaseDeliveryRepository(),
  providers: createDeliveryProviders(),
});
