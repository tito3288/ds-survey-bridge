'use client';

import Image from 'next/image';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import {
  MAX_COMMENT_LENGTH,
  QUESTIONNAIRE_ITEMS,
  type QuestionnaireAnswers,
  type QuestionnaireKey,
  type SurveyScore,
} from '@/lib/questionnaire';
import { isSurveyToken } from '@/lib/survey-token';

type Stage =
  | 'rating'
  | 'questionnaire'
  | 'google'
  | 'privateComplete'
  | 'complete'
  | 'unavailable';

type SubmissionSource = 'rating' | 'questionnaire';

type SubmissionFailureReason = 'not-found' | 'timeout' | 'retryable';

class SubmissionError extends Error {
  constructor(readonly reason: SubmissionFailureReason) {
    super(reason);
    this.name = 'SubmissionError';
  }
}

type RatingPayload = {
  surveyToken: string;
  rating: SurveyScore;
};

type QuestionnairePayload = {
  surveyToken: string;
  answers: QuestionnaireAnswers;
  comment?: string;
};

type SubmitPayload = RatingPayload | QuestionnairePayload;

type SubmitResponse =
  | { next: 'questionnaire' }
  | { next: 'google'; url: string }
  | { next: 'complete' };

const STAR_PATH =
  'M12 2.5l2.92 6.49 7.08.62-5.36 4.7 1.6 6.94L12 17.77l-6.24 3.48 1.6-6.94L2 9.61l7.08-.62L12 2.5z';

const BRAND_RED = '#C8102E';
const BRAND_BLUE = '#2c3e8c';
const BRAND_YELLOW = '#FFD700';
const SCORES: SurveyScore[] = [1, 2, 3, 4, 5];
const SUBMISSION_TIMEOUT_MS = 15_000;
const RETRYABLE_ERROR_MESSAGE =
  'We couldn\'t save your response. Please try again.';
const TIMEOUT_ERROR_MESSAGE =
  'This is taking longer than expected. Please try again.';

type SurveyPageProps = {
  params: { surveyToken: string };
};

function isSubmitResponse(value: unknown): value is SubmitResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const response = value as { next?: unknown; url?: unknown };
  if (response.next === 'questionnaire' || response.next === 'complete') {
    return true;
  }

  return response.next === 'google' && typeof response.url === 'string';
}

function getSafeReviewUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function navigateToReview(url: string) {
  const link = document.createElement('a');
  link.href = url;
  link.target = '_self';
  link.rel = 'noopener noreferrer';
  link.referrerPolicy = 'no-referrer';
  link.click();
}

export default function SurveyPage({ params }: SurveyPageProps) {
  const surveyToken = params.surveyToken;
  const validSurveyToken = isSurveyToken(surveyToken);

  const [rating, setRating] = useState<SurveyScore | null>(null);
  const [hover, setHover] = useState<SurveyScore | null>(null);
  const [stage, setStage] = useState<Stage>(
    validSurveyToken ? 'rating' : 'unavailable',
  );
  const [answers, setAnswers] = useState<Partial<QuestionnaireAnswers>>({});
  const [comment, setComment] = useState('');
  const [googleReviewUrl, setGoogleReviewUrl] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [missingQuestion, setMissingQuestion] =
    useState<QuestionnaireKey | null>(null);
  const submissionInFlight = useRef(false);
  const automaticReviewNavigationStarted = useRef(false);
  const stageHeading = useRef<HTMLHeadingElement>(null);
  const firstScoreInputs = useRef<
    Partial<Record<QuestionnaireKey, HTMLInputElement>>
  >({});

  useEffect(() => {
    if (stage !== 'rating') {
      stageHeading.current?.focus();
    }

    if (
      stage === 'google' &&
      googleReviewUrl &&
      !automaticReviewNavigationStarted.current
    ) {
      automaticReviewNavigationStarted.current = true;
      navigateToReview(googleReviewUrl);
    }
  }, [googleReviewUrl, stage]);

  if (!surveyToken) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-white px-4 py-12">
        <div className="w-full max-w-md rounded-2xl border border-gray-100 bg-white p-8 text-center shadow-sm">
          <Wordmark />
          <h2 className="mt-8 text-2xl font-bold text-gray-900">
            Invalid survey link
          </h2>
          <p className="mt-3 text-sm text-gray-500">
            This link is missing required information. Please check your text
            message and try again.
          </p>
          <Footer />
        </div>
      </main>
    );
  }

  async function submit(payload: SubmitPayload): Promise<SubmitResponse> {
    const controller = new AbortController();
    let timedOut = false;
    const timeoutId = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, SUBMISSION_TIMEOUT_MS);

    submissionInFlight.current = true;
    setSubmitting(true);
    setError(null);

    try {
      const response = await fetch('/api/survey/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (response.status === 404) {
        throw new SubmissionError('not-found');
      }

      if (!response.ok) {
        throw new SubmissionError('retryable');
      }

      const data: unknown = await response.json();
      if (!isSubmitResponse(data)) {
        throw new SubmissionError('retryable');
      }

      return data;
    } catch (submissionError) {
      if (submissionError instanceof SubmissionError) {
        throw submissionError;
      }

      throw new SubmissionError(timedOut ? 'timeout' : 'retryable');
    } finally {
      window.clearTimeout(timeoutId);
      submissionInFlight.current = false;
      setSubmitting(false);
    }
  }

  function handleNextStep(
    response: SubmitResponse,
    source: SubmissionSource,
  ) {
    if (response.next === 'questionnaire') {
      setStage('questionnaire');
      return;
    }

    if (response.next === 'google') {
      const safeUrl = getSafeReviewUrl(response.url);
      if (safeUrl) {
        automaticReviewNavigationStarted.current = false;
        setGoogleReviewUrl(safeUrl);
        setStage('google');
        return;
      }

      setStage('complete');
      return;
    }

    setStage(source === 'questionnaire' ? 'privateComplete' : 'complete');
  }

  function handleSubmissionError(submissionError: unknown) {
    if (
      submissionError instanceof SubmissionError &&
      submissionError.reason === 'not-found'
    ) {
      setStage('unavailable');
      return;
    }

    setError(
      submissionError instanceof SubmissionError &&
        submissionError.reason === 'timeout'
        ? TIMEOUT_ERROR_MESSAGE
        : RETRYABLE_ERROR_MESSAGE,
    );
  }

  async function handleRatingSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (rating === null || submissionInFlight.current) return;

    try {
      const response = await submit({ surveyToken, rating });
      handleNextStep(response, 'rating');
    } catch (submissionError) {
      handleSubmissionError(submissionError);
    }
  }

  async function handleQuestionnaireSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submissionInFlight.current) return;

    const firstMissing = QUESTIONNAIRE_ITEMS.find(
      (item) => answers[item.key] === undefined,
    );

    if (firstMissing) {
      setMissingQuestion(firstMissing.key);
      setError('Please answer all six questions before submitting.');
      firstScoreInputs.current[firstMissing.key]?.focus();
      return;
    }

    const completeAnswers = answers as QuestionnaireAnswers;
    const trimmedComment = comment.trim();

    try {
      const response = await submit({
        surveyToken,
        answers: completeAnswers,
        ...(trimmedComment ? { comment: trimmedComment } : {}),
      });
      handleNextStep(response, 'questionnaire');
    } catch (submissionError) {
      handleSubmissionError(submissionError);
    }
  }

  const activeStarCount = hover ?? rating ?? 0;

  return (
    <main className="flex min-h-screen items-center justify-center bg-gradient-to-b from-white to-gray-50 px-4 py-12">
      <div
        className={`w-full rounded-2xl border border-gray-100 bg-white shadow-sm ${
          stage === 'questionnaire'
            ? 'max-w-2xl p-6 sm:p-10'
            : 'max-w-md p-6 sm:p-10'
        }`}
      >
        <Wordmark />

        {stage === 'rating' && (
          <form onSubmit={handleRatingSubmit} aria-busy={submitting}>
            <div className="mt-8 text-center">
              <h2 className="text-2xl font-bold tracking-tight text-gray-900 sm:text-3xl">
                How was your oil change?
              </h2>
              <p className="mt-2 text-sm text-gray-500">
                Your feedback helps us serve you better
              </p>
            </div>

            <div
              className="mt-8 flex justify-center gap-1 sm:gap-2"
              onMouseLeave={() => setHover(null)}
            >
              {SCORES.map((score) => {
                const filled = score <= activeStarCount;
                return (
                  <button
                    key={score}
                    type="button"
                    aria-label={`Rate ${score} star${score === 1 ? '' : 's'}`}
                    aria-pressed={rating === score}
                    disabled={submitting}
                    onClick={() => {
                      setRating(score);
                      setError(null);
                    }}
                    onMouseEnter={() => setHover(score)}
                    onFocus={() => setHover(score)}
                    onBlur={() => setHover(null)}
                    className="rounded-full p-1 transition-transform hover:scale-110 focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed motion-reduce:transition-none motion-reduce:hover:scale-100 sm:p-2"
                    style={{
                      outlineColor: BRAND_BLUE,
                    }}
                  >
                    <svg
                      viewBox="0 0 24 24"
                      className="h-9 w-9 transition-colors sm:h-12 sm:w-12"
                      fill={filled ? BRAND_YELLOW : 'none'}
                      stroke={filled ? BRAND_YELLOW : '#D1D5DB'}
                      strokeWidth={1.5}
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d={STAR_PATH} />
                    </svg>
                  </button>
                );
              })}
            </div>

            <div role="status" aria-live="polite" className="sr-only">
              {rating
                ? `${rating} of 5 stars selected`
                : 'No rating selected'}
            </div>

            <button
              type="submit"
              disabled={rating === null || submitting}
              className="mt-8 w-full rounded-xl px-6 py-4 text-base font-semibold text-white shadow-sm transition-colors focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:bg-gray-300 motion-reduce:transition-none"
              style={{
                backgroundColor:
                  rating === null || submitting ? undefined : BRAND_RED,
                outlineColor: BRAND_BLUE,
              }}
            >
              {submitting ? 'Submitting…' : 'Submit'}
            </button>

            {error && (
              <p className="mt-3 text-center text-sm text-red-600" role="alert">
                {error}
              </p>
            )}
          </form>
        )}

        {stage === 'questionnaire' && (
          <form
            className="mt-8"
            onSubmit={handleQuestionnaireSubmit}
            noValidate
            aria-busy={submitting}
          >
            <h2
              ref={stageHeading}
              tabIndex={-1}
              className="text-2xl font-bold tracking-tight text-gray-900 focus:rounded-sm focus:outline focus:outline-2 focus:outline-offset-4 sm:text-3xl"
              style={{ outlineColor: BRAND_BLUE }}
            >
              Tell us about your visit
            </h2>
            <p className="mt-2 text-sm text-gray-600">
              Please answer all six questions. For every question, 1 is poor
              and 5 is excellent.
            </p>

            <div className="mt-8 space-y-8">
              {QUESTIONNAIRE_ITEMS.map((item, itemIndex) => (
                <fieldset
                  key={item.key}
                  aria-describedby={`${item.key}-scale`}
                  className="rounded-xl border border-gray-200 p-4 sm:p-5"
                >
                  <legend className="px-1 text-base font-semibold text-gray-900">
                    {itemIndex + 1}. {item.label}
                  </legend>
                  <div className="mt-4 grid grid-cols-5 gap-2 sm:gap-3">
                    {SCORES.map((score) => {
                      const inputId = `${item.key}-${score}`;
                      return (
                        <div key={score} className="relative">
                          <input
                            ref={(input) => {
                              if (score === 1 && input) {
                                firstScoreInputs.current[item.key] = input;
                              }
                            }}
                            id={inputId}
                            type="radio"
                            name={item.key}
                            value={score}
                            checked={answers[item.key] === score}
                            required
                            disabled={submitting}
                            aria-invalid={
                              missingQuestion === item.key ? true : undefined
                            }
                            onChange={() => {
                              setAnswers((current) => ({
                                ...current,
                                [item.key]: score,
                              }));
                              if (missingQuestion === item.key) {
                                setMissingQuestion(null);
                                setError(null);
                              }
                            }}
                            className="peer sr-only"
                          />
                          <label
                            htmlFor={inputId}
                            className="flex min-h-12 cursor-pointer items-center justify-center rounded-lg border border-gray-300 bg-white text-base font-semibold text-gray-700 transition-colors hover:border-gray-400 peer-checked:border-transparent peer-checked:text-white peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-disabled:cursor-not-allowed peer-disabled:opacity-70 motion-reduce:transition-none"
                            style={{
                              backgroundColor:
                                answers[item.key] === score
                                  ? BRAND_BLUE
                                  : undefined,
                              ['--tw-outline-color' as string]: BRAND_BLUE,
                              outlineColor: BRAND_BLUE,
                            }}
                          >
                            {score}
                          </label>
                        </div>
                      );
                    })}
                  </div>
                  <p
                    id={`${item.key}-scale`}
                    className="mt-2 flex justify-between text-xs font-medium text-gray-500"
                  >
                    <span>1 = Poor</span>
                    <span>5 = Excellent</span>
                  </p>
                </fieldset>
              ))}
            </div>

            <div className="mt-8">
              <label
                htmlFor="comment"
                className="block text-base font-semibold text-gray-900"
              >
                Anything we can improve?{' '}
                <span className="font-normal text-gray-500">(optional)</span>
              </label>
              <textarea
                id="comment"
                rows={5}
                value={comment}
                maxLength={MAX_COMMENT_LENGTH}
                disabled={submitting}
                aria-describedby="comment-count"
                onChange={(event) =>
                  setComment(event.target.value.slice(0, MAX_COMMENT_LENGTH))
                }
                className="mt-2 w-full rounded-xl border border-gray-200 p-3 text-base text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 disabled:cursor-not-allowed disabled:bg-gray-50"
                style={{
                  ['--tw-ring-color' as string]: BRAND_BLUE,
                }}
                placeholder="Share any additional feedback…"
              />
              <p
                id="comment-count"
                className="mt-1 text-right text-xs text-gray-500"
                aria-live="polite"
              >
                {comment.length.toLocaleString()} /{' '}
                {MAX_COMMENT_LENGTH.toLocaleString()} characters
              </p>
            </div>

            <button
              type="submit"
              disabled={submitting}
              className="mt-6 w-full rounded-xl px-6 py-4 text-base font-semibold text-white shadow-sm transition-colors focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:bg-gray-300 motion-reduce:transition-none"
              style={{
                backgroundColor: submitting ? undefined : BRAND_RED,
                outlineColor: BRAND_BLUE,
              }}
            >
              {submitting ? 'Submitting…' : 'Submit feedback'}
            </button>

            {error && (
              <p className="mt-3 text-center text-sm text-red-600" role="alert">
                {error}
              </p>
            )}
          </form>
        )}

        {stage === 'google' && googleReviewUrl && (
          <div className="mt-8 text-center">
            <h2
              ref={stageHeading}
              tabIndex={-1}
              className="text-2xl font-bold tracking-tight text-gray-900 focus:rounded-sm focus:outline focus:outline-2 focus:outline-offset-4"
              style={{ outlineColor: BRAND_BLUE }}
            >
              Opening Google
            </h2>
            <p className="mt-3 text-sm text-gray-600">
              Your Drive &amp; Shine rating has been recorded.
            </p>
            <p className="mt-2 text-sm text-gray-600">
              You&apos;re leaving Drive &amp; Shine to finish a public review on
              Google.
            </p>
            <a
              href={googleReviewUrl}
              target="_self"
              rel="noopener noreferrer"
              referrerPolicy="no-referrer"
              className="mt-6 inline-flex min-h-12 items-center justify-center rounded-xl px-6 py-3 text-base font-semibold text-white shadow-sm focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
              style={{ backgroundColor: BRAND_RED, outlineColor: BRAND_BLUE }}
            >
              Continue to Google
            </a>
          </div>
        )}

        {stage === 'privateComplete' && (
          <Confirmation
            heading="Thank you for helping us improve."
            message="Your feedback has been recorded. Our team will use it to improve future visits. You may close this page."
            headingRef={stageHeading}
          />
        )}

        {stage === 'complete' && (
          <Confirmation
            heading="Thank you for your feedback."
            message="Your response has been recorded. You may close this page."
            headingRef={stageHeading}
          />
        )}

        {stage === 'unavailable' && (
          <div className="mt-8 text-center">
            <h2
              ref={stageHeading}
              tabIndex={-1}
              className="text-2xl font-bold tracking-tight text-gray-900 focus:rounded-sm focus:outline focus:outline-2 focus:outline-offset-4"
              style={{ outlineColor: BRAND_BLUE }}
            >
              This survey link is unavailable
            </h2>
            <p className="mt-3 text-sm text-gray-600">
              We couldn&apos;t find a survey for this link. Please check that you
              opened the complete link from your text message.
            </p>
          </div>
        )}

        <Footer />
      </div>
    </main>
  );
}

type ConfirmationProps = {
  heading: string;
  message: string;
  headingRef: React.RefObject<HTMLHeadingElement>;
};

function Confirmation({ heading, message, headingRef }: ConfirmationProps) {
  return (
    <div className="mt-8 text-center">
      <div
        className="mx-auto flex h-14 w-14 items-center justify-center rounded-full"
        style={{ backgroundColor: BRAND_YELLOW }}
        aria-hidden="true"
      >
        <svg
          viewBox="0 0 24 24"
          className="h-8 w-8"
          fill="none"
          stroke="#1F2937"
          strokeWidth={3}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M5 12l5 5L20 7" />
        </svg>
      </div>
      <h2
        ref={headingRef}
        tabIndex={-1}
        className="mt-5 text-2xl font-bold tracking-tight text-gray-900 focus:rounded-sm focus:outline focus:outline-2 focus:outline-offset-4"
        style={{ outlineColor: BRAND_BLUE }}
      >
        {heading}
      </h2>
      <p className="mt-3 text-sm text-gray-600">{message}</p>
    </div>
  );
}

function Wordmark() {
  return (
    <div className="flex justify-center">
      <Image
        src="/imgi_2_Main-Logo-w-White-Border_May25_RGB.png"
        alt="Drive & Shine"
        width={220}
        height={140}
        priority
        className="h-auto w-44 sm:w-52"
      />
    </div>
  );
}

function Footer() {
  return (
    <footer className="mt-10 border-t border-gray-100 pt-5 text-center">
      <p className="text-xs font-semibold text-gray-500">Drive &amp; Shine</p>
      <p className="mt-1 text-[11px] text-gray-400">
        © {new Date().getFullYear()} Drive &amp; Shine. All rights reserved.
      </p>
    </footer>
  );
}
