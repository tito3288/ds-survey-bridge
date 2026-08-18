import { describe, expect, it, vi } from 'vitest';

const providerEnvNames = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_PHONE_NUMBER',
  'APP_URL',
  'RESEND_API_KEY',
] as const;

describe('external provider boundaries', () => {
  it('can be imported without credentials or network access', async () => {
    vi.resetModules();
    for (const name of providerEnvNames) {
      vi.stubEnv(name, '');
    }

    const [supabaseModule, twilioModule, resendModule] = await Promise.all([
      import('./supabase'),
      import('./twilio'),
      import('./resend'),
    ]);

    expect(supabaseModule.getSupabaseAdmin).toBeTypeOf('function');
    expect(twilioModule.sendSurveySMS).toBeTypeOf('function');
    expect(resendModule.sendPrivateFeedbackEmail).toBeTypeOf('function');
  });
});
