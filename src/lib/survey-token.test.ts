import { describe, expect, it } from 'vitest';
import { isSurveyToken } from './survey-token';

describe('survey token validation', () => {
  it.each([
    '11111111-1111-4111-8111-111111111111',
    'A8098C1A-F86E-4F6E-8C7A-4D6112A5C9E7',
  ])('accepts a version 4 UUID: %s', (value) => {
    expect(isSurveyToken(value)).toBe(true);
  });

  it.each([
    undefined,
    null,
    123,
    '',
    'raw-order-id',
    '11111111-1111-1111-8111-111111111111',
    '11111111-1111-4111-7111-111111111111',
    ' 11111111-1111-4111-8111-111111111111 ',
  ])('rejects a non-token value: %s', (value) => {
    expect(isSurveyToken(value)).toBe(false);
  });
});
