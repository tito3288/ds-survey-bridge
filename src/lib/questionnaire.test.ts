import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GOOGLE_REVIEW_MIN_RATING,
  MAX_COMMENT_LENGTH,
  QUESTIONNAIRE_ITEMS,
  SURVEY_FLOW_VERSION,
  getGoogleReviewMinimumRating,
  shouldRouteToGoogleReview,
  validateQuestionnaire,
} from './questionnaire';

const completeAnswers = {
  waitTime: 5,
  serviceSpeed: 4,
  vehicleCleanliness: 3,
  additionalServicesExperience: 5,
  value: 4,
  teamFriendliness: 5,
};

describe('questionnaire contract', () => {
  it('keeps the six version-one questions in their intended order', () => {
    expect(SURVEY_FLOW_VERSION).toBe(1);
    expect(QUESTIONNAIRE_ITEMS.map((item) => item.key)).toEqual([
      'waitTime',
      'serviceSpeed',
      'vehicleCleanliness',
      'additionalServicesExperience',
      'value',
      'teamFriendliness',
    ]);
    expect(QUESTIONNAIRE_ITEMS.map((item) => item.label)).toEqual([
      'How satisfied were you with your wait time?',
      'How satisfied were you with the speed of service?',
      'How satisfied were you with how clean we left your vehicle?',
      'How comfortable did you feel with recommendations for additional services?',
      'How satisfied were you with the value you received?',
      'How friendly and welcoming was our team?',
    ]);
  });

  it('accepts all six scores and normalizes an optional comment', () => {
    expect(
      validateQuestionnaire({ answers: completeAnswers, comment: '  Helpful  ' }),
    ).toEqual({
      ok: true,
      value: { answers: completeAnswers, comment: 'Helpful' },
    });

    expect(validateQuestionnaire({ answers: completeAnswers })).toEqual({
      ok: true,
      value: { answers: completeAnswers, comment: null },
    });
  });

  it.each([0, 1.5, 6, '5', null])(
    'rejects an invalid score: %s',
    (invalidScore) => {
      expect(
        validateQuestionnaire({
          answers: { ...completeAnswers, waitTime: invalidScore },
        }),
      ).toEqual({
        ok: false,
        error: 'waitTime must be an integer from 1 to 5',
      });
    },
  );

  it('rejects missing or unexpected answer keys', () => {
    const partial: Partial<typeof completeAnswers> = { ...completeAnswers };
    delete partial.value;

    expect(validateQuestionnaire({ answers: partial }).ok).toBe(false);
    expect(
      validateQuestionnaire({ answers: { ...completeAnswers, other: 5 } }).ok,
    ).toBe(false);
  });

  it('rejects comments longer than the agreed limit', () => {
    expect(
      validateQuestionnaire({
        answers: completeAnswers,
        comment: 'x'.repeat(MAX_COMMENT_LENGTH + 1),
      }),
    ).toEqual({
      ok: false,
      error: `Comment must be ${MAX_COMMENT_LENGTH} characters or fewer`,
    });
  });
});

describe('review threshold configuration', () => {
  it('defaults to four without encoding the threshold in the database', () => {
    expect(getGoogleReviewMinimumRating(undefined)).toBe(
      DEFAULT_GOOGLE_REVIEW_MIN_RATING,
    );
    expect(shouldRouteToGoogleReview(3, 4)).toBe(false);
    expect(shouldRouteToGoogleReview(4, 4)).toBe(true);
    expect(shouldRouteToGoogleReview(5, 4)).toBe(true);
  });

  it('accepts a configured 1-5 threshold and rejects invalid settings', () => {
    expect(getGoogleReviewMinimumRating('5')).toBe(5);
    expect(() => getGoogleReviewMinimumRating('3.5')).toThrow(
      'GOOGLE_REVIEW_MIN_RATING must be an integer from 1 to 5',
    );
  });
});
