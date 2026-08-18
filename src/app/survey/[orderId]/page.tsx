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

type Stage = 'rating' | 'questionnaire' | 'done';

type RatingPayload = {
  orderId: string;
  rating: SurveyScore;
};

type QuestionnairePayload = {
  orderId: string;
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

type SurveyPageProps = {
  params: { orderId: string };
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
  link.click();
}

export default function SurveyPage({ params }: SurveyPageProps) {
  const orderId = params.orderId;

  const [rating, setRating] = useState<SurveyScore | null>(null);
  const [hover, setHover] = useState<SurveyScore | null>(null);
  const [stage, setStage] = useState<Stage>('rating');
  const [answers, setAnswers] = useState<Partial<QuestionnaireAnswers>>({});
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [missingQuestion, setMissingQuestion] =
    useState<QuestionnaireKey | null>(null);
  const submissionInFlight = useRef(false);
  const stageHeading = useRef<HTMLHeadingElement>(null);
  const firstScoreInputs = useRef<
    Partial<Record<QuestionnaireKey, HTMLInputElement>>
  >({});

  useEffect(() => {
    if (stage !== 'rating') {
      stageHeading.current?.focus();
    }
  }, [stage]);

  if (!orderId) {
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
    submissionInFlight.current = true;
    setSubmitting(true);
    setError(null);

    try {
      const response = await fetch('/api/survey/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error('Submission failed');
      }

      const data: unknown = await response.json();
      if (!isSubmitResponse(data)) {
        throw new Error('Unexpected submission response');
      }

      return data;
    } finally {
      submissionInFlight.current = false;
      setSubmitting(false);
    }
  }

  function handleNextStep(response: SubmitResponse) {
    if (response.next === 'questionnaire') {
      setStage('questionnaire');
      return;
    }

    if (response.next === 'google') {
      const safeUrl = getSafeReviewUrl(response.url);
      if (safeUrl) {
        submissionInFlight.current = true;
        setSubmitting(true);
        navigateToReview(safeUrl);
        return;
      }
    }

    setStage('done');
  }

  async function handleRatingSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (rating === null || submissionInFlight.current) return;

    try {
      const response = await submit({ orderId, rating });
      handleNextStep(response);
    } catch {
      setError('Something went wrong. Please try again.');
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
        orderId,
        answers: completeAnswers,
        ...(trimmedComment ? { comment: trimmedComment } : {}),
      });
      handleNextStep(response);
    } catch {
      setError('Something went wrong. Please try again.');
    }
  }

  const activeStarCount = hover ?? rating ?? 0;

  return (
    <main className="flex min-h-screen items-center justify-center bg-gradient-to-b from-white to-gray-50 px-4 py-12">
      <div
        className={`w-full rounded-2xl border border-gray-100 bg-white shadow-sm ${
          stage === 'questionnaire'
            ? 'max-w-2xl p-6 sm:p-10'
            : 'max-w-md p-8 sm:p-10'
        }`}
      >
        <Wordmark />

        {stage === 'rating' && (
          <form onSubmit={handleRatingSubmit}>
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
                    onClick={() => setRating(score)}
                    onMouseEnter={() => setHover(score)}
                    onFocus={() => setHover(score)}
                    onBlur={() => setHover(null)}
                    className="rounded-full p-2 transition-transform hover:scale-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
                    style={{
                      ['--tw-ring-color' as string]: BRAND_YELLOW,
                    }}
                  >
                    <svg
                      viewBox="0 0 24 24"
                      className="h-10 w-10 transition-colors sm:h-12 sm:w-12"
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
              className="mt-8 w-full rounded-xl px-6 py-4 text-base font-semibold text-white shadow-sm transition-colors disabled:cursor-not-allowed disabled:bg-gray-300"
              style={{
                backgroundColor:
                  rating === null || submitting ? undefined : BRAND_RED,
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
          <form className="mt-8" onSubmit={handleQuestionnaireSubmit} noValidate>
            <h2
              ref={stageHeading}
              tabIndex={-1}
              className="text-2xl font-bold tracking-tight text-gray-900 outline-none sm:text-3xl"
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
                            className="flex min-h-12 cursor-pointer items-center justify-center rounded-lg border border-gray-300 bg-white text-base font-semibold text-gray-700 transition-colors hover:border-gray-400 peer-checked:border-transparent peer-checked:text-white peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2"
                            style={{
                              backgroundColor:
                                answers[item.key] === score
                                  ? BRAND_BLUE
                                  : undefined,
                              ['--tw-outline-color' as string]: BRAND_BLUE,
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
                aria-describedby="comment-count"
                onChange={(event) =>
                  setComment(event.target.value.slice(0, MAX_COMMENT_LENGTH))
                }
                className="mt-2 w-full rounded-xl border border-gray-200 p-3 text-base text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2"
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
              className="mt-6 w-full rounded-xl px-6 py-4 text-base font-semibold text-white shadow-sm transition-colors disabled:cursor-not-allowed disabled:bg-gray-300"
              style={{
                backgroundColor: submitting ? undefined : BRAND_RED,
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

        {stage === 'done' && (
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
              ref={stageHeading}
              tabIndex={-1}
              className="mt-5 text-2xl font-bold tracking-tight text-gray-900 outline-none"
            >
              Thank you for your feedback
            </h2>
            <p className="mt-2 text-sm text-gray-500">
              We&apos;ll use it to improve your next visit.
            </p>
          </div>
        )}

        <Footer />
      </div>
    </main>
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
