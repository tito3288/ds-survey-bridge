import { NextRequest, NextResponse } from 'next/server';
import {
  QUESTIONNAIRE_VERSION,
  getGoogleReviewMinimumRating,
  isSurveyScore,
  shouldRouteToGoogleReview,
  validateQuestionnaire,
  type QuestionnaireAnswers,
  type SurveyScore,
} from '@/lib/questionnaire';
import { getSupabaseAdmin } from '@/lib/supabase';
import { isSurveyToken } from '@/lib/survey-token';

const SURVEY_NOT_FOUND_RESPONSE = { error: 'Survey not found' } as const;

type RatingSubmission = {
  kind: 'rating';
  surveyToken: string;
  rating: SurveyScore;
};

type QuestionnaireSubmission = {
  kind: 'questionnaire';
  surveyToken: string;
  answers: QuestionnaireAnswers;
  comment: string | null;
};

type Submission = RatingSubmission | QuestionnaireSubmission;

type SubmissionValidationResult =
  | { ok: true; value: Submission }
  | { ok: false; error: string; status?: 400 | 404 };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowedKeys.includes(key));
}

function validateSubmission(body: unknown): SubmissionValidationResult {
  if (!isRecord(body)) {
    return { ok: false, error: 'Survey submission must be an object' };
  }

  const hasRating = Object.hasOwn(body, 'rating');
  const hasAnswers = Object.hasOwn(body, 'answers');

  if (hasRating === hasAnswers) {
    return {
      ok: false,
      error: 'Submit either an overall rating or questionnaire answers',
    };
  }

  if (hasRating) {
    if (!hasOnlyKeys(body, ['surveyToken', 'rating'])) {
      return { ok: false, error: 'Unexpected fields in rating submission' };
    }
    if (!isSurveyToken(body.surveyToken)) {
      return { ok: false, error: 'Survey not found', status: 404 };
    }
    if (!isSurveyScore(body.rating)) {
      return { ok: false, error: 'rating must be an integer from 1 to 5' };
    }

    return {
      ok: true,
      value: {
        kind: 'rating',
        surveyToken: body.surveyToken,
        rating: body.rating,
      },
    };
  }

  if (!hasOnlyKeys(body, ['surveyToken', 'answers', 'comment'])) {
    return {
      ok: false,
      error: 'Unexpected fields in questionnaire submission',
    };
  }
  if (!isSurveyToken(body.surveyToken)) {
    return { ok: false, error: 'Survey not found', status: 404 };
  }

  const questionnaire = validateQuestionnaire({
    answers: body.answers,
    comment: body.comment,
  });
  if (!questionnaire.ok) {
    return questionnaire;
  }

  return {
    ok: true,
    value: {
      kind: 'questionnaire',
      surveyToken: body.surveyToken,
      ...questionnaire.value,
    },
  };
}

function getSafeGoogleReviewUrl(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null);
    const validation = validateSubmission(body);

    if (!validation.ok) {
      return NextResponse.json(
        { error: validation.error },
        { status: validation.status ?? 400 },
      );
    }

    const minimumGoogleRating = getGoogleReviewMinimumRating();
    const submission = validation.value;
    const supabaseAdmin = getSupabaseAdmin();

    const { data: survey, error: surveyError } = await supabaseAdmin
      .from('surveys')
      .select(
        'id, location_id, rating, questionnaire_submitted_at',
      )
      .eq('survey_token', submission.surveyToken)
      .maybeSingle();

    if (surveyError) {
      console.error('[survey submit] survey lookup failed', surveyError);
      return NextResponse.json(
        { error: 'Internal server error' },
        { status: 500 },
      );
    }

    if (!survey) {
      return NextResponse.json(SURVEY_NOT_FOUND_RESPONSE, { status: 404 });
    }

    if (submission.kind === 'rating') {
      if (survey.questionnaire_submitted_at) {
        return NextResponse.json({ next: 'complete' });
      }

      const { data: updatedSurvey, error: updateError } = await supabaseAdmin
        .from('surveys')
        .update({
          rating: submission.rating,
          responded_at: new Date().toISOString(),
        })
        .eq('id', survey.id)
        .is('questionnaire_submitted_at', null)
        .select('id')
        .maybeSingle();

      if (updateError) {
        console.error('[survey submit] rating update failed', updateError);
        return NextResponse.json(
          { error: 'Internal server error' },
          { status: 500 },
        );
      }

      // A questionnaire submission may have completed after the initial read.
      // In that case its stored rating and answers remain authoritative.
      if (!updatedSurvey) {
        return NextResponse.json({ next: 'complete' });
      }

      if (
        !shouldRouteToGoogleReview(submission.rating, minimumGoogleRating)
      ) {
        return NextResponse.json({ next: 'questionnaire' });
      }

      const { data: location, error: locationError } = await supabaseAdmin
        .from('locations')
        .select('google_review_url')
        .eq('droptop_location_id', survey.location_id)
        .maybeSingle();

      if (locationError) {
        console.error('[survey submit] location lookup failed', locationError);
        return NextResponse.json(
          { error: 'Internal server error' },
          { status: 500 },
        );
      }

      const googleReviewUrl = getSafeGoogleReviewUrl(
        location?.google_review_url,
      );
      if (!googleReviewUrl) {
        return NextResponse.json({ next: 'complete' });
      }

      return NextResponse.json({ next: 'google', url: googleReviewUrl });
    }

    if (survey.questionnaire_submitted_at) {
      return NextResponse.json({ next: 'complete' });
    }

    if (survey.rating === null) {
      return NextResponse.json(
        { error: 'Submit an overall rating before the questionnaire' },
        { status: 409 },
      );
    }

    if (!isSurveyScore(survey.rating)) {
      console.error('[survey submit] stored rating is invalid', survey.rating);
      return NextResponse.json(
        { error: 'Internal server error' },
        { status: 500 },
      );
    }

    if (shouldRouteToGoogleReview(survey.rating, minimumGoogleRating)) {
      const { data: location, error: locationError } = await supabaseAdmin
        .from('locations')
        .select('google_review_url')
        .eq('droptop_location_id', survey.location_id)
        .maybeSingle();

      if (locationError) {
        console.error('[survey submit] location lookup failed', locationError);
        return NextResponse.json(
          { error: 'Internal server error' },
          { status: 500 },
        );
      }

      const googleReviewUrl = getSafeGoogleReviewUrl(
        location?.google_review_url,
      );
      return googleReviewUrl
        ? NextResponse.json({ next: 'google', url: googleReviewUrl })
        : NextResponse.json({ next: 'complete' });
    }

    const { data: completion, error: completionError } = await supabaseAdmin
      .rpc('complete_questionnaire_with_email_job', {
        p_survey_id: survey.id,
        p_private_rating_maximum: minimumGoogleRating - 1,
        p_wait_time_score: submission.answers.waitTime,
        p_service_speed_score: submission.answers.serviceSpeed,
        p_vehicle_cleanliness_score: submission.answers.vehicleCleanliness,
        p_additional_services_experience_score:
          submission.answers.additionalServicesExperience,
        p_value_score: submission.answers.value,
        p_team_friendliness_score: submission.answers.teamFriendliness,
        p_questionnaire_version: QUESTIONNAIRE_VERSION,
        p_comment: submission.comment ?? '',
        p_completed_at: new Date().toISOString(),
      })
      .single();

    if (completionError) {
      console.error(
        '[survey submit] questionnaire completion failed',
        completionError,
      );
      return NextResponse.json(
        { error: 'Internal server error' },
        { status: 500 },
      );
    }

    if (!completion) {
      console.error('[survey submit] questionnaire completion returned no result');
      return NextResponse.json(
        { error: 'Internal server error' },
        { status: 500 },
      );
    }

    if (
      completion.outcome === 'completed' ||
      completion.outcome === 'already_completed'
    ) {
      return NextResponse.json({ next: 'complete' });
    }

    if (completion.outcome === 'not_found') {
      return NextResponse.json(SURVEY_NOT_FOUND_RESPONSE, { status: 404 });
    }

    if (completion.outcome === 'rating_missing') {
      return NextResponse.json(
        { error: 'Submit an overall rating before the questionnaire' },
        { status: 409 },
      );
    }

    if (
      completion.outcome !== 'not_private' ||
      !isSurveyScore(completion.rating) ||
      !completion.location_id ||
      !shouldRouteToGoogleReview(completion.rating, minimumGoogleRating)
    ) {
      console.error('[survey submit] invalid questionnaire completion result', {
        outcome: completion.outcome,
        hasLocationId: Boolean(completion.location_id),
        rating: completion.rating,
      });
      return NextResponse.json(
        { error: 'Internal server error' },
        { status: 500 },
      );
    }

    const { data: location, error: locationError } = await supabaseAdmin
      .from('locations')
      .select('google_review_url')
      .eq('droptop_location_id', completion.location_id)
      .maybeSingle();

    if (locationError) {
      console.error('[survey submit] location lookup failed', locationError);
      return NextResponse.json(
        { error: 'Internal server error' },
        { status: 500 },
      );
    }

    const googleReviewUrl = getSafeGoogleReviewUrl(location?.google_review_url);
    return googleReviewUrl
      ? NextResponse.json({ next: 'google', url: googleReviewUrl })
      : NextResponse.json({ next: 'complete' });
  } catch (error) {
    console.error('[survey submit] unexpected error', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}
