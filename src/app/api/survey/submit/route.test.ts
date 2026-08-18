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
const INTERNAL_ORDER_ID = 'FAKE-INTERNAL-ORDER-001';

const surveyRecord = {
  id: 'survey-test-id',
  order_id: INTERNAL_ORDER_ID,
  location_id: 'FAKE-LOC-001',
  customer_name: 'Fictional Customer',
  customer_phone: '+15555550123',
  services: [{ name: 'Synthetic Oil Change' }],
  rating: null,
  questionnaire_submitted_at: null,
};

function completedSurveyRecord(rating: number) {
  return {
    id: surveyRecord.id,
    order_id: surveyRecord.order_id,
    rating,
    location_id: surveyRecord.location_id,
    customer_name: surveyRecord.customer_name,
    customer_phone: surveyRecord.customer_phone,
    services: surveyRecord.services,
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
  it('atomically stores all six scores and emails the stored overall rating', async () => {
    const surveyLookup = createLookup({
      data: { ...surveyRecord, rating: 2 },
      error: null,
    });
    const update = createFilteredUpdate({
      data: completedSurveyRecord(2),
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
    mocks.sendPrivateFeedbackEmail.mockResolvedValue({ id: 'email-test-id' });

    const response = await POST(
      createRequest(questionnaireBody('  Fictional private feedback  ')),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ next: 'complete' });
    expect(update.update).toHaveBeenCalledWith({
      wait_time_score: 5,
      service_speed_score: 4,
      vehicle_cleanliness_score: 3,
      additional_services_experience_score: 2,
      value_score: 4,
      team_friendliness_score: 5,
      questionnaire_version: 1,
      questionnaire_submitted_at: expect.any(String),
      comment: 'Fictional private feedback',
    });
    expect(update.eq).toHaveBeenCalledWith('id', 'survey-test-id');
    expect(update.is).toHaveBeenCalledWith('questionnaire_submitted_at', null);
    expect(update.lt).toHaveBeenCalledWith('rating', 4);
    expect(update.select).toHaveBeenCalledWith(
      'id, order_id, rating, location_id, customer_phone, customer_name, services',
    );
    expect(mocks.sendPrivateFeedbackEmail).toHaveBeenCalledWith({
      orderId: INTERNAL_ORDER_ID,
      rating: 2,
      answers: completeAnswers,
      comment: 'Fictional private feedback',
      locationId: 'FAKE-LOC-001',
      locationName: 'Fake Training Location',
      customerName: 'Fictional Customer',
      customerPhone: '+15555550123',
      services: [{ name: 'Synthetic Oil Change' }],
    });
  });

  it('emails the low rating returned by the atomic update after a concurrent low-rating change', async () => {
    const surveyLookup = createLookup({
      data: { ...surveyRecord, rating: 1 },
      error: null,
    });
    const update = createFilteredUpdate({
      data: completedSurveyRecord(3),
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
    mocks.sendPrivateFeedbackEmail.mockResolvedValue({ id: 'email-test-id' });

    const response = await POST(createRequest(questionnaireBody()));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ next: 'complete' });
    expect(mocks.sendPrivateFeedbackEmail).toHaveBeenCalledWith(
      expect.objectContaining({ rating: 3 }),
    );
  });

  it('accepts no written comment and still sends the private email', async () => {
    const surveyLookup = createLookup({
      data: { ...surveyRecord, rating: 1 },
      error: null,
    });
    const update = createFilteredUpdate({
      data: completedSurveyRecord(1),
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
    mocks.sendPrivateFeedbackEmail.mockResolvedValue({ id: 'email-test-id' });

    const response = await POST(createRequest(questionnaireBody()));

    expect(response.status).toBe(200);
    expect(update.update).toHaveBeenCalledWith(
      expect.objectContaining({ comment: null }),
    );
    expect(mocks.sendPrivateFeedbackEmail).toHaveBeenCalledWith(
      expect.objectContaining({ comment: null }),
    );
  });

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

  it('treats a zero update plus completed re-read as an idempotent retry', async () => {
    const surveyLookup = createLookup({
      data: { ...surveyRecord, rating: 2 },
      error: null,
    });
    const update = createFilteredUpdate({ data: null, error: null });
    const currentSurveyLookup = createLookup({
      data: {
        rating: 2,
        questionnaire_submitted_at: '2026-08-18T12:00:00.000Z',
        location_id: 'FAKE-LOC-001',
      },
      error: null,
    });
    installSupabaseQueries(
      surveyLookup.query,
      update.query,
      currentSurveyLookup.query,
    );

    const response = await POST(createRequest(questionnaireBody()));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ next: 'complete' });
    expect(mocks.sendPrivateFeedbackEmail).not.toHaveBeenCalled();
  });

  it('routes to Google when a zero update re-reads a concurrent high rating', async () => {
    const surveyLookup = createLookup({
      data: { ...surveyRecord, rating: 2 },
      error: null,
    });
    const update = createFilteredUpdate({ data: null, error: null });
    const currentSurveyLookup = createLookup({
      data: {
        rating: 4,
        questionnaire_submitted_at: null,
        location_id: 'FAKE-LOC-001',
      },
      error: null,
    });
    const locationLookup = createLookup({
      data: locationRecord,
      error: null,
    });
    installSupabaseQueries(
      surveyLookup.query,
      update.query,
      currentSurveyLookup.query,
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

  it('returns a retryable conflict when a zero update re-reads an incomplete low rating', async () => {
    const surveyLookup = createLookup({
      data: { ...surveyRecord, rating: 2 },
      error: null,
    });
    const update = createFilteredUpdate({ data: null, error: null });
    const currentSurveyLookup = createLookup({
      data: {
        rating: 3,
        questionnaire_submitted_at: null,
        location_id: 'FAKE-LOC-001',
      },
      error: null,
    });
    installSupabaseQueries(
      surveyLookup.query,
      update.query,
      currentSurveyLookup.query,
    );

    const response = await POST(createRequest(questionnaireBody()));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'Survey response changed; please try again',
    });
    expect(mocks.sendPrivateFeedbackEmail).not.toHaveBeenCalled();
  });

  it('returns the generic 404 when a survey disappears during a questionnaire update', async () => {
    const surveyLookup = createLookup({
      data: { ...surveyRecord, rating: 2 },
      error: null,
    });
    const update = createFilteredUpdate({ data: null, error: null });
    const currentSurveyLookup = createLookup({ data: null, error: null });
    installSupabaseQueries(
      surveyLookup.query,
      update.query,
      currentSurveyLookup.query,
    );

    const response = await POST(createRequest(questionnaireBody()));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Survey not found' });
    expect(mocks.sendPrivateFeedbackEmail).not.toHaveBeenCalled();
  });

  it('does not notify when the atomic questionnaire update fails', async () => {
    const surveyLookup = createLookup({
      data: { ...surveyRecord, rating: 2 },
      error: null,
    });
    const update = createFilteredUpdate({
      data: null,
      error: new Error('update failed'),
    });
    installSupabaseQueries(surveyLookup.query, update.query);

    const response = await POST(createRequest(questionnaireBody()));

    expect(response.status).toBe(500);
    expect(mocks.sendPrivateFeedbackEmail).not.toHaveBeenCalled();
  });

  it('keeps stored feedback successful when email delivery fails', async () => {
    const surveyLookup = createLookup({
      data: { ...surveyRecord, rating: 3 },
      error: null,
    });
    const update = createFilteredUpdate({
      data: completedSurveyRecord(3),
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
    mocks.sendPrivateFeedbackEmail.mockRejectedValue(
      new Error('email unavailable'),
    );

    const response = await POST(createRequest(questionnaireBody()));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ next: 'complete' });
  });

  it('still notifies with the location ID when its display-name lookup fails', async () => {
    const surveyLookup = createLookup({
      data: { ...surveyRecord, rating: 2 },
      error: null,
    });
    const update = createFilteredUpdate({
      data: completedSurveyRecord(2),
      error: null,
    });
    const locationLookup = createLookup({
      data: null,
      error: new Error('location unavailable'),
    });
    installSupabaseQueries(
      surveyLookup.query,
      update.query,
      locationLookup.query,
    );
    mocks.sendPrivateFeedbackEmail.mockResolvedValue({ id: 'email-test-id' });

    const response = await POST(createRequest(questionnaireBody()));

    expect(response.status).toBe(200);
    expect(mocks.sendPrivateFeedbackEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        locationId: 'FAKE-LOC-001',
        locationName: undefined,
      }),
    );
  });
});
