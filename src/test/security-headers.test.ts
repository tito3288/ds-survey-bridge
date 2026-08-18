import { describe, expect, it } from 'vitest';
import { metadata } from '@/app/survey/[surveyToken]/layout';

// The Next.js configuration is intentionally JavaScript so it can be loaded
// directly by the framework before TypeScript compilation.
import nextConfig from '../../next.config.mjs';

type HeaderEntry = { key: string; value: string };
type HeaderRule = { source: string; headers: HeaderEntry[] };

async function getHeaderRules(): Promise<HeaderRule[]> {
  if (typeof nextConfig.headers !== 'function') {
    throw new Error('Next.js privacy headers are not configured');
  }

  return (await nextConfig.headers()) as HeaderRule[];
}

function asHeaderMap(rule: HeaderRule) {
  return Object.fromEntries(
    rule.headers.map(({ key, value }) => [key.toLowerCase(), value]),
  );
}

describe('survey privacy headers', () => {
  it('marks survey metadata as private and non-indexable', () => {
    expect(metadata.referrer).toBe('no-referrer');
    expect(metadata.robots).toMatchObject({
      index: false,
      follow: false,
      nocache: true,
      googleBot: {
        index: false,
        follow: false,
        noarchive: true,
        noimageindex: true,
      },
    });
  });

  it('prevents survey pages from being cached, indexed, framed, or used as referrers', async () => {
    const rules = await getHeaderRules();
    const surveyRule = rules.find((rule) => rule.source === '/survey/:path*');

    expect(surveyRule).toBeDefined();
    expect(asHeaderMap(surveyRule!)).toMatchObject({
      'cache-control': 'private, no-store, max-age=0',
      'referrer-policy': 'no-referrer',
      'x-robots-tag': 'noindex, nofollow, noarchive, noimageindex',
      'x-frame-options': 'DENY',
      'x-content-type-options': 'nosniff',
      'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    });
  });

  it('prevents survey API responses from being cached or used as referrers', async () => {
    const rules = await getHeaderRules();
    const apiRule = rules.find(
      (rule) => rule.source === '/api/survey/:path*',
    );

    expect(apiRule).toBeDefined();
    expect(asHeaderMap(apiRule!)).toMatchObject({
      'cache-control': 'private, no-store, max-age=0',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    });
  });
});
