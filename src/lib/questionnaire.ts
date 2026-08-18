export const QUESTIONNAIRE_VERSION = 1 as const;
export const SURVEY_FLOW_VERSION = 1 as const;
export const MAX_COMMENT_LENGTH = 2_000;

export type SurveyScore = 1 | 2 | 3 | 4 | 5;

export const QUESTIONNAIRE_ITEMS = [
  {
    key: 'waitTime',
    column: 'wait_time_score',
    label: 'How satisfied were you with your wait time?',
  },
  {
    key: 'serviceSpeed',
    column: 'service_speed_score',
    label: 'How satisfied were you with the speed of service?',
  },
  {
    key: 'vehicleCleanliness',
    column: 'vehicle_cleanliness_score',
    label: 'How satisfied were you with how clean we left your vehicle?',
  },
  {
    key: 'additionalServicesExperience',
    column: 'additional_services_experience_score',
    label:
      'How comfortable did you feel with recommendations for additional services?',
  },
  {
    key: 'value',
    column: 'value_score',
    label: 'How satisfied were you with the value you received?',
  },
  {
    key: 'teamFriendliness',
    column: 'team_friendliness_score',
    label: 'How friendly and welcoming was our team?',
  },
] as const;

export type QuestionnaireKey = (typeof QUESTIONNAIRE_ITEMS)[number]['key'];
export type QuestionnaireAnswers = Record<QuestionnaireKey, SurveyScore>;

export type ValidQuestionnaire = {
  answers: QuestionnaireAnswers;
  comment: string | null;
};

export type QuestionnaireValidationResult =
  | { ok: true; value: ValidQuestionnaire }
  | { ok: false; error: string };

export const DEFAULT_GOOGLE_REVIEW_MIN_RATING: SurveyScore = 4;

export function isSurveyScore(value: unknown): value is SurveyScore {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 5
  );
}

export function getGoogleReviewMinimumRating(
  rawValue: string | undefined = process.env.GOOGLE_REVIEW_MIN_RATING,
): SurveyScore {
  if (rawValue === undefined || rawValue.trim() === '') {
    return DEFAULT_GOOGLE_REVIEW_MIN_RATING;
  }

  const parsed = Number(rawValue);
  if (!isSurveyScore(parsed)) {
    throw new Error('GOOGLE_REVIEW_MIN_RATING must be an integer from 1 to 5');
  }

  return parsed;
}

export function shouldRouteToGoogleReview(
  rating: SurveyScore,
  minimumRating: SurveyScore = getGoogleReviewMinimumRating(),
): boolean {
  return rating >= minimumRating;
}

export function validateQuestionnaire(
  input: unknown,
): QuestionnaireValidationResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'Questionnaire must be an object' };
  }

  const payload = input as { answers?: unknown; comment?: unknown };
  if (
    !payload.answers ||
    typeof payload.answers !== 'object' ||
    Array.isArray(payload.answers)
  ) {
    return { ok: false, error: 'All six questionnaire answers are required' };
  }

  const rawAnswers = payload.answers as Record<string, unknown>;
  const expectedKeys = QUESTIONNAIRE_ITEMS.map((item) => item.key);
  const receivedKeys = Object.keys(rawAnswers);

  if (
    receivedKeys.length !== expectedKeys.length ||
    receivedKeys.some((key) => !expectedKeys.includes(key as QuestionnaireKey))
  ) {
    return { ok: false, error: 'All six questionnaire answers are required' };
  }

  const answers = {} as QuestionnaireAnswers;
  for (const item of QUESTIONNAIRE_ITEMS) {
    const score = rawAnswers[item.key];
    if (!isSurveyScore(score)) {
      return {
        ok: false,
        error: `${item.key} must be an integer from 1 to 5`,
      };
    }
    answers[item.key] = score;
  }

  if (
    payload.comment !== undefined &&
    payload.comment !== null &&
    typeof payload.comment !== 'string'
  ) {
    return { ok: false, error: 'Comment must be a string' };
  }

  const comment =
    typeof payload.comment === 'string' ? payload.comment.trim() : '';
  if (comment.length > MAX_COMMENT_LENGTH) {
    return {
      ok: false,
      error: `Comment must be ${MAX_COMMENT_LENGTH} characters or fewer`,
    };
  }

  return {
    ok: true,
    value: {
      answers,
      comment: comment.length > 0 ? comment : null,
    },
  };
}
