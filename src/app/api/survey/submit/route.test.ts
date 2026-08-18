import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_COMMENT_LENGTH } from '@/lib/questionnaire';

const mocks = vi.hoisted(() => ({
  getSupabaseAdmin: vi.fn(),
  sendPrivateFeedbackEmail: vi.fn(),
}));

vi.mock('@/lib/supabase', () => ({
  getSupabaseAdmin: mocks.getSupabaseAdmin,
}));

vi.mock('@/lib/resend', () => ({
  sendPrivateFeedbackEmail: mocks.sendPrivateFeedbackEmail,
}));

import { POST } from './route';

type LookupResult<T> = { data: T | null; error: unknown | null };

function createLookup<T>(result: LookupResult<T>) {
  const maybeSingle = vi.fn(async () => result);
  const eq = vi.fn(() => ({ maybeSingle }));
  const select = vi.fn(() => ({ eq }));

  return { query: { select }, select, eq, maybeSingle };
}

function createFilteredUpdate<T>(result: LookupResult<T>) {
  const maybeSingle = vi.fn(async () => result);
  const select = vi.fn(() => ({ maybeSingle }));
  const eq = vi.fn();
  const is = vi.fn();
  const lt = vi.fn();
  const filters = { eq, is, lt, select };
  eq.mockReturnValue(filters);
  is.mockReturnValue(filters);
  lt.mockReturnValue(filters);
  const update = vi.fn(() => filters);

  return { query: { update }, update, eq, is, lt, select, maybeSingle };
}

function createRequest(body: unknown): NextRequest {
  return new NextRequest('http://127.0.0.1/api/survey/submit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function installSupabaseQueries(...queries: object[]) {
  const from = vi.fn();
  for (const query of queries) {
    from.mockReturnValueOnce(query);
  }
  mocks.getSupabaseAdmin.mockReturnValue({ from });
  return from;
}

function installSupabaseRpc<T>(
  result: LookupResult<T>,
  ...queries: object[]
) {
  const from = vi.fn();
  for (const query of queries) {
    from.mockReturnValueOnce(query);
  }
  const single = vi.fn(async () => result);
  const rpc = vi.fn(() => ({ single }));
  mocks.getSupabaseAdmin.mockReturnValue({ from, rpc });
  return { from, rpc, single };
}

const completeAnswers = {
  waitTime: 5,
  serviceSpeed: 4,
  vehicleCleanliness: 3,
  additionalServicesExperience: 2,
  value: 4,
  teamFriendliness: 5,
};

const SURVEY_TOKEN = '11111111-1111-4111-8111-111111111111';
const UNKNOWN_SURVEY_TOKEN = '22222222-2222-4222-8222-222222222222';
const surveyRecord = {
  id: 'survey-test-id',
  location_id: 'FAKE-LOC-001',
  rating: null,
  questionnaire_submitted_at: null,
};

function completionResult(
  outcome:
    | 'completed'
    | 'already_completed'
    | 'not_found'
    | 'rating_missing'
    | 'not_private',
  rating: number | null = 2,
) {
  return {
    outcome,
    survey_id: outcome === 'not_found' ? null : surveyRecord.id,
    order_id: outcome === 'not_found' ? null : 'FAKE-INTERNAL-ORDER-001',
    rating,
    location_id: outcome === 'not_found' ? null : surveyRecord.location_id,
    delivery_job_id:
      outcome === 'completed'
        ? '44444444-4444-4444-8444-444444444444'
        : null,
  };
}

const locationRecord = {
  name: 'Fake Training Location',
  google_review_url: 'https://example.com/fake-review-location',
};

function questionnaireBody(comment?: string) {
  return {
    surveyToken: SURVEY_TOKEN,
    answers: completeAnswers,
    ...(comment === undefined ? {} : { comment }),
  };
}

beforeEach(() => {
  vi.stubEnv('GOOGLE_REVIEW_MIN_RATING', '4');
  mocks.getSupabaseAdmin.mockReset();
  mocks.sendPrivateFeedbackEmail.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('POST /api/survey/submit validation', () => {
  it('returns 400 for invalid JSON before initializing Supabase', async () => {
    const request = new NextRequest('http://127.0.0.1/api/survey/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{invalid-json',
    });

    const response = await POST(request);

    expect(response.status).toBe(400);
    expect(mocks.getSupabaseAdmin).not.toHaveBeenCalled();
  });

  it.each([
    [
      { orderId: 'raw-order-id', rating: 4 },
      'Unexpected fields in rating submission',
    ],
    [
      { surveyToken: SURVEY_TOKEN, rating: 2, answers: completeAnswers },
      'Submit either an overall rating or questionnaire answers',
    ],
    [
      {
        surveyToken: SURVEY_TOKEN,
        orderId: 'raw-order-id',
        rating: 2,
      },
      'Unexpected fields in rating submission',
    ],
    [
      { surveyToken: SURVEY_TOKEN, rating: 2, comment: 'old mixed shape' },
      'Unexpected fields in rating submission',
    ],
    [
      { surveyToken: SURVEY_TOKEN, rating: 2, extra: true },
      'Unexpected fields in rating submission',
    ],
    [
      { orderId: 'raw-order-id', answers: completeAnswers },
      'Unexpected fields in questionnaire submission',
    ],
    [
      {
        surveyToken: SURVEY_TOKEN,
        orderId: 'raw-order-id',
        answers: completeAnswers,
      },
      'Unexpected fields in questionnaire submission',
    ],
    [
      {
        ...questionnaireBody(),
        answers: { ...completeAnswers, value: undefined },
      },
      'All six questionnaire answers are required',
    ],
    [
      { ...questionnaireBody(), extra: true },
      'Unexpected fields in questionnaire submission',
    ],
  ])('rejects an invalid or mixed payload: %s', async (body, error) => {
    const response = await POST(createRequest(body));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error });
    expect(mocks.getSupabaseAdmin).not.toHaveBeenCalled();
  });

  it.each([
    { surveyToken: 'raw-order-id', rating: 4 },
    { surveyToken: '', rating: 4 },
    { surveyToken: '11111111-1111-1111-8111-111111111111', rating: 4 },
    { surveyToken: 'raw-order-id', answers: completeAnswers },
  ])(
    'returns the generic 404 for a malformed token before initializing Supabase: %s',
    async (body) => {
      const response = await POST(createRequest(body));

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'Survey not found' });
      expect(mocks.getSupabaseAdmin).not.toHaveBeenCalled();
      expect(mocks.sendPrivateFeedbackEmail).not.toHaveBeenCalled();
    },
  );

  it('rejects comments beyond 2,000 characters before database access', async () => {
    const response = await POST(
      createRequest(questionnaireBody('x'.repeat(MAX_COMMENT_LENGTH + 1))),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: `Comment must be ${MAX_COMMENT_LENGTH} characters or fewer`,
    });
    expect(mocks.getSupabaseAdmin).not.toHaveBeenCalled();
  });

  it('returns 500 for an invalid review threshold before database access', async () => {
    vi.stubEnv('GOOGLE_REVIEW_MIN_RATING', '3.5');

    const response = await POST(
      createRequest({ surveyToken: SURVEY_TOKEN, rating: 4 }),
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal server error' });
    expect(mocks.getSupabaseAdmin).not.toHaveBeenCalled();
  });
});

describe('POST /api/survey/submit initial rating', () => {
  it.each([
    { surveyToken: UNKNOWN_SURVEY_TOKEN, rating: 4 },
    {
      surveyToken: UNKNOWN_SURVEY_TOKEN,
      answers: completeAnswers,
    },
  ])('returns the generic 404 for an unknown survey link: %s', async (body) => {
    const surveyLookup = createLookup({ data: null, error: null });
    installSupabaseQueries(surveyLookup.query);

    const response = await POST(createRequest(body));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Survey not found' });
    expect(surveyLookup.eq).toHaveBeenCalledWith(
      'survey_token',
      UNKNOWN_SURVEY_TOKEN,
    );
    expect(mocks.sendPrivateFeedbackEmail).not.toHaveBeenCalled();
  });

  it('returns 500 when the survey lookup fails', async () => {
    const surveyLookup = createLookup({
      data: null,
      error: new Error('database unavailable'),
    });
    installSupabaseQueries(surveyLookup.query);

    const response = await POST(
      createRequest({ surveyToken: SURVEY_TOKEN, rating: 4 }),
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal server error' });
  });

  it.each([1, 2, 3])(
    'stores rating %i and opens the private questionnaire by default',
    async (rating) => {
    const surveyLookup = createLookup({ data: surveyRecord, error: null });
    const update = createFilteredUpdate({
      data: { id: 'survey-test-id' },
      error: null,
    });
    installSupabaseQueries(surveyLookup.query, update.query);

    const response = await POST(
      createRequest({ surveyToken: SURVEY_TOKEN, rating }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ next: 'questionnaire' });
    expect(update.update).toHaveBeenCalledWith({
      rating,
      responded_at: expect.any(String),
    });
    expect(update.eq).toHaveBeenCalledWith('id', 'survey-test-id');
    expect(update.is).toHaveBeenCalledWith('questionnaire_submitted_at', null);
    expect(surveyLookup.eq).toHaveBeenCalledWith('survey_token', SURVEY_TOKEN);
    expect(mocks.sendPrivateFeedbackEmail).not.toHaveBeenCalled();
    },
  );

  it.each([4, 5])(
    'stores rating %i and returns the mapped Google URL by default',
    async (rating) => {
    const surveyLookup = createLookup({ data: surveyRecord, error: null });
    const update = createFilteredUpdate({
      data: { id: 'survey-test-id' },
      error: null,
    });
    const locationLookup = createLookup({
      data: locationRecord,
      error: null,
    });
    installSupabaseQueries(
      surveyLookup.query,
      update.query,
      locationLookup.query,
    );

    const response = await POST(
      createRequest({ surveyToken: SURVEY_TOKEN, rating }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      next: 'google',
      url: 'https://example.com/fake-review-location',
    });
    },
  );

  it('honors an alternate configured review threshold', async () => {
    vi.stubEnv('GOOGLE_REVIEW_MIN_RATING', '5');
    const surveyLookup = createLookup({ data: surveyRecord, error: null });
    const update = createFilteredUpdate({
      data: { id: 'survey-test-id' },
      error: null,
    });
    installSupabaseQueries(surveyLookup.query, update.query);

    const response = await POST(
      createRequest({ surveyToken: SURVEY_TOKEN, rating: 4 }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ next: 'questionnaire' });
  });

  it.each([
    { location: null, caseLabel: 'missing mapping' },
    {
      location: {
        ...locationRecord,
        google_review_url: 'javascript:alert(1)',
      },
      caseLabel: 'unsafe mapping',
    },
    {
      location: {
        ...locationRecord,
        google_review_url: 'http://example.com/insecure-review-location',
      },
      caseLabel: 'non-HTTPS mapping',
    },
  ])('fails safely with a $caseLabel', async ({ location }) => {
    const surveyLookup = createLookup({ data: surveyRecord, error: null });
    const update = createFilteredUpdate({
      data: { id: 'survey-test-id' },
      error: null,
    });
    const locationLookup = createLookup({ data: location, error: null });
    installSupabaseQueries(
      surveyLookup.query,
      update.query,
      locationLookup.query,
    );

    const response = await POST(
      createRequest({ surveyToken: SURVEY_TOKEN, rating: 5 }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ next: 'complete' });
  });

  it('returns 500 when the rating cannot be stored', async () => {
    const surveyLookup = createLookup({ data: surveyRecord, error: null });
    const update = createFilteredUpdate({
      data: null,
      error: new Error('update failed'),
    });
    installSupabaseQueries(surveyLookup.query, update.query);

    const response = await POST(
      createRequest({ surveyToken: SURVEY_TOKEN, rating: 2 }),
    );

    expect(response.status).toBe(500);
    expect(mocks.sendPrivateFeedbackEmail).not.toHaveBeenCalled();
  });

  it('does not overwrite a questionnaire that is already complete', async () => {
    const surveyLookup = createLookup({
      data: {
        ...surveyRecord,
        rating: 2,
        questionnaire_submitted_at: '2026-08-18T12:00:00.000Z',
      },
      error: null,
    });
    installSupabaseQueries(surveyLookup.query);

    const response = await POST(
      createRequest({ surveyToken: SURVEY_TOKEN, rating: 5 }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ next: 'complete' });
    expect(mocks.sendPrivateFeedbackEmail).not.toHaveBeenCalled();
  });

  it('does not overwrite a questionnaire completed during the rating update', async () => {
    const surveyLookup = createLookup({ data: surveyRecord, error: null });
    const update = createFilteredUpdate({ data: null, error: null });
    installSupabaseQueries(surveyLookup.query, update.query);

    const response = await POST(
      createRequest({ surveyToken: SURVEY_TOKEN, rating: 5 }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ next: 'complete' });
    expect(update.is).toHaveBeenCalledWith('questionnaire_submitted_at', null);
    expect(mocks.sendPrivateFeedbackEmail).not.toHaveBeenCalled();
  });

  it('returns 500 instead of guessing when the location lookup fails', async () => {
    const surveyLookup = createLookup({ data: surveyRecord, error: null });
    const update = createFilteredUpdate({
      data: { id: 'survey-test-id' },
      error: null,
    });
    const locationLookup = createLookup({
      data: null,
      error: new Error('location query failed'),
    });
    installSupabaseQueries(
      surveyLookup.query,
      update.query,
      locationLookup.query,
    );

    const response = await POST(
      createRequest({ surveyToken: SURVEY_TOKEN, rating: 5 }),
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal server error' });
  });
});

describe('POST /api/survey/submit questionnaire', () => {
  it('atomically stores all six scores and enqueues one private email job', async () => {
    const surveyLookup = createLookup({
      data: { ...surveyRecord, rating: 2 },
      error: null,
    });
    const { rpc } = installSupabaseRpc(
      { data: completionResult('completed'), error: null },
      surveyLookup.query,
    );

    const response = await POST(
      createRequest(questionnaireBody('  Fictional private feedback  ')),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ next: 'complete' });
    expect(rpc).toHaveBeenCalledWith(
      'complete_questionnaire_with_email_job',
      {
        p_survey_id: 'survey-test-id',
        p_private_rating_maximum: 3,
        p_wait_time_score: 5,
        p_service_speed_score: 4,
        p_vehicle_cleanliness_score: 3,
        p_additional_services_experience_score: 2,
        p_value_score: 4,
        p_team_friendliness_score: 5,
        p_questionnaire_version: 1,
        p_comment: 'Fictional private feedback',
        p_completed_at: expect.any(String),
      },
    );
    expect(mocks.sendPrivateFeedbackEmail).not.toHaveBeenCalled();
  });

  it('accepts the low rating observed by the atomic completion function', async () => {
    const surveyLookup = createLookup({
      data: { ...surveyRecord, rating: 1 },
      error: null,
    });
    const { rpc } = installSupabaseRpc(
      { data: completionResult('completed', 3), error: null },
      surveyLookup.query,
    );

    const response = await POST(createRequest(questionnaireBody()));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ next: 'complete' });
    expect(rpc).toHaveBeenCalledOnce();
    expect(mocks.sendPrivateFeedbackEmail).not.toHaveBeenCalled();
  });

  it.each([undefined, '   '])(
    'normalizes an absent or blank comment before enqueueing: %s',
    async (comment) => {
      const surveyLookup = createLookup({
        data: { ...surveyRecord, rating: 1 },
        error: null,
      });
      const { rpc } = installSupabaseRpc(
        { data: completionResult('completed', 1), error: null },
        surveyLookup.query,
      );

      const response = await POST(createRequest(questionnaireBody(comment)));

      expect(response.status).toBe(200);
      expect(rpc).toHaveBeenCalledWith(
        'complete_questionnaire_with_email_job',
        expect.objectContaining({ p_comment: '' }),
      );
      expect(mocks.sendPrivateFeedbackEmail).not.toHaveBeenCalled();
    },
  );

  it('requires an initial overall rating', async () => {
    const surveyLookup = createLookup({ data: surveyRecord, error: null });
    installSupabaseQueries(surveyLookup.query);

    const response = await POST(createRequest(questionnaireBody()));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'Submit an overall rating before the questionnaire',
    });
    expect(mocks.sendPrivateFeedbackEmail).not.toHaveBeenCalled();
  });

  it('uses the stored rating to avoid accepting a high-rating questionnaire', async () => {
    const surveyLookup = createLookup({
      data: { ...surveyRecord, rating: 4 },
      error: null,
    });
    const locationLookup = createLookup({
      data: locationRecord,
      error: null,
    });
    installSupabaseQueries(surveyLookup.query, locationLookup.query);

    const response = await POST(createRequest(questionnaireBody()));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      next: 'google',
      url: 'https://example.com/fake-review-location',
    });
    expect(mocks.sendPrivateFeedbackEmail).not.toHaveBeenCalled();
  });

  it('treats an already completed questionnaire as a successful retry', async () => {
    const surveyLookup = createLookup({
      data: {
        ...surveyRecord,
        rating: 2,
        questionnaire_submitted_at: '2026-08-18T12:00:00.000Z',
      },
      error: null,
    });
    installSupabaseQueries(surveyLookup.query);

    const response = await POST(
      createRequest(questionnaireBody('Different answers must not win')),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ next: 'complete' });
    expect(mocks.sendPrivateFeedbackEmail).not.toHaveBeenCalled();
  });

  it('treats a concurrent completed result as an idempotent retry', async () => {
    const surveyLookup = createLookup({
      data: { ...surveyRecord, rating: 2 },
      error: null,
    });
    const { rpc } = installSupabaseRpc(
      { data: completionResult('already_completed'), error: null },
      surveyLookup.query,
    );

    const response = await POST(createRequest(questionnaireBody()));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ next: 'complete' });
    expect(rpc).toHaveBeenCalledOnce();
    expect(mocks.sendPrivateFeedbackEmail).not.toHaveBeenCalled();
  });

  it('routes to Google when atomic completion observes a concurrent high rating', async () => {
    const surveyLookup = createLookup({
      data: { ...surveyRecord, rating: 2 },
      error: null,
    });
    const locationLookup = createLookup({
      data: locationRecord,
      error: null,
    });
    installSupabaseRpc(
      { data: completionResult('not_private', 4), error: null },
      surveyLookup.query,
      locationLookup.query,
    );

    const response = await POST(createRequest(questionnaireBody()));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      next: 'google',
      url: 'https://example.com/fake-review-location',
    });
    expect(mocks.sendPrivateFeedbackEmail).not.toHaveBeenCalled();
  });

  it('fails safely when a concurrent high rating has no Google link', async () => {
    const surveyLookup = createLookup({
      data: { ...surveyRecord, rating: 2 },
      error: null,
    });
    const locationLookup = createLookup({ data: null, error: null });
    installSupabaseRpc(
      { data: completionResult('not_private', 5), error: null },
      surveyLookup.query,
      locationLookup.query,
    );

    const response = await POST(createRequest(questionnaireBody()));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ next: 'complete' });
    expect(mocks.sendPrivateFeedbackEmail).not.toHaveBeenCalled();
  });

  it('returns the generic 404 when the survey disappears during completion', async () => {
    const surveyLookup = createLookup({
      data: { ...surveyRecord, rating: 2 },
      error: null,
    });
    installSupabaseRpc(
      { data: completionResult('not_found', null), error: null },
      surveyLookup.query,
    );

    const response = await POST(createRequest(questionnaireBody()));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Survey not found' });
    expect(mocks.sendPrivateFeedbackEmail).not.toHaveBeenCalled();
  });

  it('returns a retryable conflict if the rating disappears during completion', async () => {
    const surveyLookup = createLookup({
      data: { ...surveyRecord, rating: 2 },
      error: null,
    });
    installSupabaseRpc(
      { data: completionResult('rating_missing', null), error: null },
      surveyLookup.query,
    );

    const response = await POST(createRequest(questionnaireBody()));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'Submit an overall rating before the questionnaire',
    });
    expect(mocks.sendPrivateFeedbackEmail).not.toHaveBeenCalled();
  });

  it('returns 500 without an email job when atomic completion fails', async () => {
    const surveyLookup = createLookup({
      data: { ...surveyRecord, rating: 2 },
      error: null,
    });
    installSupabaseRpc(
      { data: null, error: new Error('transaction failed') },
      surveyLookup.query,
    );

    const response = await POST(createRequest(questionnaireBody()));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal server error' });
    expect(mocks.sendPrivateFeedbackEmail).not.toHaveBeenCalled();
  });

  it('returns 500 when atomic completion returns no result', async () => {
    const surveyLookup = createLookup({
      data: { ...surveyRecord, rating: 2 },
      error: null,
    });
    installSupabaseRpc({ data: null, error: null }, surveyLookup.query);

    const response = await POST(createRequest(questionnaireBody()));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal server error' });
    expect(mocks.sendPrivateFeedbackEmail).not.toHaveBeenCalled();
  });

  it('returns 500 for an invalid atomic completion result', async () => {
    const surveyLookup = createLookup({
      data: { ...surveyRecord, rating: 2 },
      error: null,
    });
    installSupabaseRpc(
      {
        data: {
          ...completionResult('not_private', 2),
          location_id: null,
        },
        error: null,
      },
      surveyLookup.query,
    );

    const response = await POST(createRequest(questionnaireBody()));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal server error' });
    expect(mocks.sendPrivateFeedbackEmail).not.toHaveBeenCalled();
  });
});
