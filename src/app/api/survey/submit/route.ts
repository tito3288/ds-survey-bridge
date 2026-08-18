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
import { sendPrivateFeedbackEmail } from '@/lib/resend';
import { getSupabaseAdmin } from '@/lib/supabase';
import { isSurveyToken } from '@/lib/survey-token';
import type { Database } from '@/types/database';

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
        'id, order_id, location_id, customer_phone, customer_name, services, rating, questionnaire_submitted_at',
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

    const update: Database['public']['Tables']['surveys']['Update'] = {
      wait_time_score: submission.answers.waitTime,
      service_speed_score: submission.answers.serviceSpeed,
      vehicle_cleanliness_score: submission.answers.vehicleCleanliness,
      additional_services_experience_score:
        submission.answers.additionalServicesExperience,
      value_score: submission.answers.value,
      team_friendliness_score: submission.answers.teamFriendliness,
      questionnaire_version: QUESTIONNAIRE_VERSION,
      questionnaire_submitted_at: new Date().toISOString(),
      comment: submission.comment,
    };

    const { data: completedSurvey, error: updateError } = await supabaseAdmin
      .from('surveys')
      .update(update)
      .eq('id', survey.id)
      .is('questionnaire_submitted_at', null)
      .lt('rating', minimumGoogleRating)
      .select(
        'id, order_id, rating, location_id, customer_phone, customer_name, services',
      )
      .maybeSingle();

    if (updateError) {
      console.error('[survey submit] questionnaire update failed', updateError);
      return NextResponse.json(
        { error: 'Internal server error' },
        { status: 500 },
      );
    }

    // A concurrent request may have completed the questionnaire or changed the
    // routing rating after our initial read. Re-read instead of treating every
    // zero-row result as a completed duplicate.
    if (!completedSurvey) {
      const { data: currentSurvey, error: currentSurveyError } =
        await supabaseAdmin
          .from('surveys')
          .select('rating, questionnaire_submitted_at, location_id')
          .eq('id', survey.id)
          .maybeSingle();

      if (currentSurveyError) {
        console.error(
          '[survey submit] survey race re-check failed',
          currentSurveyError,
        );
        return NextResponse.json(
          { error: 'Internal server error' },
          { status: 500 },
        );
      }

      if (!currentSurvey) {
        return NextResponse.json(SURVEY_NOT_FOUND_RESPONSE, { status: 404 });
      }

      if (currentSurvey.questionnaire_submitted_at) {
        return NextResponse.json({ next: 'complete' });
      }

      if (currentSurvey.rating === null) {
        return NextResponse.json(
          { error: 'Submit an overall rating before the questionnaire' },
          { status: 409 },
        );
      }

      if (!isSurveyScore(currentSurvey.rating)) {
        console.error(
          '[survey submit] stored rating is invalid',
          currentSurvey.rating,
        );
        return NextResponse.json(
          { error: 'Internal server error' },
          { status: 500 },
        );
      }

      if (
        shouldRouteToGoogleReview(
          currentSurvey.rating,
          minimumGoogleRating,
        )
      ) {
        const { data: location, error: locationError } = await supabaseAdmin
          .from('locations')
          .select('google_review_url')
          .eq('droptop_location_id', currentSurvey.location_id)
          .maybeSingle();

        if (locationError) {
          console.error(
            '[survey submit] location lookup failed',
            locationError,
          );
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

      return NextResponse.json(
        { error: 'Survey response changed; please try again' },
        { status: 409 },
      );
    }

    if (!isSurveyScore(completedSurvey.rating)) {
      console.error(
        '[survey submit] stored rating is invalid',
        completedSurvey.rating,
      );
      return NextResponse.json(
        { error: 'Internal server error' },
        { status: 500 },
      );
    }

    const { data: location, error: locationError } = await supabaseAdmin
      .from('locations')
      .select('name')
      .eq('droptop_location_id', completedSurvey.location_id)
      .maybeSingle();

    if (locationError) {
      console.error('[survey submit] location lookup failed', locationError);
    }

    try {
      await sendPrivateFeedbackEmail({
        orderId: completedSurvey.order_id,
        rating: completedSurvey.rating,
        answers: submission.answers,
        comment: submission.comment,
        locationId: completedSurvey.location_id,
        locationName: location?.name,
        customerName: completedSurvey.customer_name ?? undefined,
        customerPhone: completedSurvey.customer_phone ?? undefined,
        services: completedSurvey.services,
      });
    } catch (emailError) {
      console.error('[survey submit] email send failed', emailError);
    }

    return NextResponse.json({ next: 'complete' });
  } catch (error) {
    console.error('[survey submit] unexpected error', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}
