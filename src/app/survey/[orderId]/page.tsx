'use client';

import Image from 'next/image';
import { useState } from 'react';

type Rating = 1 | 2 | 3 | 4 | 5;
type Stage = 'rating' | 'comment' | 'done';

type SubmitPayload = {
  orderId: string;
  rating: Rating;
  comment?: string;
};

type SubmitResponse = {
  redirectUrl?: string;
  ok?: boolean;
};

const STAR_PATH =
  'M12 2.5l2.92 6.49 7.08.62-5.36 4.7 1.6 6.94L12 17.77l-6.24 3.48 1.6-6.94L2 9.61l7.08-.62L12 2.5z';

const BRAND_RED = '#C8102E';
const BRAND_BLUE = '#2c3e8c';
const BRAND_YELLOW = '#FFD700';

type SurveyPageProps = {
  params: { orderId: string };
};

export default function SurveyPage({ params }: SurveyPageProps) {
  const orderId = params.orderId;

  const [rating, setRating] = useState<Rating | null>(null);
  const [hover, setHover] = useState<Rating | null>(null);
  const [stage, setStage] = useState<Stage>('rating');
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/survey/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error('Submission failed');
      return (await res.json()) as SubmitResponse;
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRatingSubmit() {
    if (rating === null) return;
    try {
      const data = await submit({ orderId, rating });
      if (data.redirectUrl) {
        setSubmitting(true);
        window.location.href = data.redirectUrl;
        return;
      }
      setStage('comment');
    } catch {
      setError('Something went wrong. Please try again.');
    }
  }

  async function handleCommentSubmit() {
    if (rating === null) return;
    const trimmed = comment.trim();
    try {
      await submit({
        orderId,
        rating,
        ...(trimmed ? { comment: trimmed } : {}),
      });
      setStage('done');
    } catch {
      setError('Something went wrong. Please try again.');
    }
  }

  const activeStarCount = hover ?? rating ?? 0;

  return (
    <main className="flex min-h-screen items-center justify-center bg-gradient-to-b from-white to-gray-50 px-4 py-12">
      <div className="w-full max-w-md rounded-2xl border border-gray-100 bg-white p-8 shadow-sm sm:p-10">
        <Wordmark />

        {stage === 'rating' && (
          <>
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
              {([1, 2, 3, 4, 5] as Rating[]).map((n) => {
                const filled = n <= activeStarCount;
                return (
                  <button
                    key={n}
                    type="button"
                    aria-label={`Rate ${n} star${n === 1 ? '' : 's'}`}
                    aria-pressed={rating === n}
                    onClick={() => setRating(n)}
                    onMouseEnter={() => setHover(n)}
                    onFocus={() => setHover(n)}
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
              type="button"
              onClick={handleRatingSubmit}
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
          </>
        )}

        {stage === 'comment' && (
          <div className="mt-8">
            <h2 className="text-xl font-bold tracking-tight text-gray-900 sm:text-2xl">
              We&apos;re sorry to hear that.
            </h2>
            <label
              htmlFor="comment"
              className="mt-3 block text-sm text-gray-600"
            >
              Tell us what went wrong:
            </label>
            <textarea
              id="comment"
              rows={4}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              className="mt-2 w-full rounded-xl border border-gray-200 p-3 text-base text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2"
              style={{
                ['--tw-ring-color' as string]: BRAND_BLUE,
              }}
              placeholder="Your feedback..."
            />

            <button
              type="button"
              onClick={handleCommentSubmit}
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
          </div>
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
            <h2 className="mt-5 text-2xl font-bold tracking-tight text-gray-900">
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
