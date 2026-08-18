import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import nock from 'nock';
import { afterAll, afterEach, beforeAll, beforeEach, vi } from 'vitest';

const fakeProviderEnvironment = {
  APP_URL: 'http://127.0.0.1:3000',
  NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:55321',
  SUPABASE_SERVICE_ROLE_KEY: 'fake-local-service-role-key',
  TWILIO_ACCOUNT_SID: 'AC00000000000000000000000000000000',
  TWILIO_AUTH_TOKEN: 'fake-local-auth-token',
  TWILIO_PHONE_NUMBER: '+15555550100',
  SURVEY_SMS_DELAY_MINUTES: '0',
  DELIVERY_WORKER_ENABLED: 'false',
  RESEND_API_KEY: 're_fake_local_key',
  SUPPORT_EMAIL: 'support@example.test',
} as const;

beforeAll(() => {
  nock.disableNetConnect();
});

beforeEach(() => {
  for (const [name, value] of Object.entries(fakeProviderEnvironment)) {
    vi.stubEnv(name, value);
  }

  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.reject(
        new Error(
          'Unexpected network request in a test. Mock fetch explicitly before making the request.',
        ),
      ),
    ),
  );
});

afterEach(() => {
  nock.abortPendingRequests();
  nock.cleanAll();
  if (typeof document !== 'undefined') {
    cleanup();
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

afterAll(() => {
  nock.enableNetConnect();
});
