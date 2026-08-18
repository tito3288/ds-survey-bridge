import { describe, expect, it } from 'vitest';
import { getRequiredEnv } from './env';

describe('getRequiredEnv', () => {
  it('returns a trimmed configured value', () => {
    expect(getRequiredEnv('EXAMPLE_KEY', { EXAMPLE_KEY: '  value  ' })).toBe(
      'value',
    );
  });

  it('fails clearly when a required value is missing', () => {
    expect(() => getRequiredEnv('EXAMPLE_KEY', {})).toThrow(
      'Missing required environment variable: EXAMPLE_KEY',
    );
  });
});
