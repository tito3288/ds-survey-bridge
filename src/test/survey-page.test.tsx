// @vitest-environment jsdom

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import SurveyPage from '@/app/survey/[orderId]/page';
import {
  MAX_COMMENT_LENGTH,
  QUESTIONNAIRE_ITEMS,
  type QuestionnaireAnswers,
} from '@/lib/questionnaire';

const ORDER_ID = 'fake-order-123';

function apiResponse(
  body: unknown,
  ok = true,
  status = ok ? 200 : 500,
): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as Response;
}

function postedBody(callIndex: number) {
  const fetchMock = vi.mocked(fetch);
  const options = fetchMock.mock.calls[callIndex]?.[1];
  return JSON.parse(String(options?.body)) as unknown;
}

async function openQuestionnaire() {
  const user = userEvent.setup();
  const fetchMock = vi.mocked(fetch);
  fetchMock.mockResolvedValueOnce(apiResponse({ next: 'questionnaire' }));

  render(<SurveyPage params={{ orderId: ORDER_ID }} />);
  await user.click(screen.getByRole('button', { name: 'Rate 3 stars' }));
  await user.click(screen.getByRole('button', { name: 'Submit' }));

  const heading = await screen.findByRole('heading', {
    name: 'Tell us about your visit',
  });
  await waitFor(() => expect(heading).toHaveFocus());

  return { user, fetchMock };
}

async function answerEveryQuestion(
  user: ReturnType<typeof userEvent.setup>,
  scores: QuestionnaireAnswers,
) {
  for (const item of QUESTIONNAIRE_ITEMS) {
    const group = screen.getByRole('group', {
      name: new RegExp(item.label.replace(/[?]/g, '\\?')),
    });
    await user.click(
      within(group).getByRole('radio', {
        name: String(scores[item.key]),
      }),
    );
  }
}

describe('survey customer flow', () => {
  it('preserves the initial star screen and posts the compatible rating payload', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(apiResponse({ next: 'questionnaire' }));

    render(<SurveyPage params={{ orderId: ORDER_ID }} />);

    expect(
      screen.getByRole('heading', { name: 'How was your oil change?' }),
    ).toBeInTheDocument();

    const submitButton = screen.getByRole('button', { name: 'Submit' });
    expect(submitButton).toBeDisabled();

    const ratingButton = screen.getByRole('button', { name: 'Rate 3 stars' });
    ratingButton.focus();
    await user.keyboard('[Enter]');
    expect(ratingButton).toHaveAttribute('aria-pressed', 'true');
    expect(submitButton).toBeEnabled();
    await user.click(submitButton);

    await screen.findByRole('heading', { name: 'Tell us about your visit' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/survey/submit',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId: ORDER_ID, rating: 3 }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('shows the Google handoff and immediately navigates in the same tab with a visible HTTPS fallback', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.mocked(fetch);
    let clickedHref: string | undefined;
    let clickedTarget: string | undefined;
    let clickedRel: string | undefined;
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clickedHref = this.href;
      clickedTarget = this.target;
      clickedRel = this.rel;
    });
    fetchMock.mockResolvedValueOnce(
      apiResponse({
        next: 'google',
        url: 'https://example.com/fake-review-location',
      }),
    );

    render(<SurveyPage params={{ orderId: ORDER_ID }} />);
    await user.click(screen.getByRole('button', { name: 'Rate 5 stars' }));
    await user.click(screen.getByRole('button', { name: 'Submit' }));

    const heading = await screen.findByRole('heading', {
      name: 'Opening Google',
    });
    expect(heading).toHaveFocus();
    expect(
      screen.getByText('Your Drive & Shine rating has been recorded.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "You're leaving Drive & Shine to finish a public review on Google.",
      ),
    ).toBeInTheDocument();
    const fallback = screen.getByRole('link', { name: 'Continue to Google' });
    expect(fallback).toHaveAttribute(
      'href',
      'https://example.com/fake-review-location',
    );
    expect(fallback).toHaveAttribute('target', '_self');
    expect(fallback).toHaveAttribute('rel', 'noopener noreferrer');

    // Navigation happens as soon as the handoff renders; no countdown or
    // timer advancement is needed.
    await waitFor(() => expect(clickedHref).toBeDefined());
    expect(clickedHref).toBe('https://example.com/fake-review-location');
    expect(clickedTarget).toBe('_self');
    expect(clickedRel).toBe('noopener noreferrer');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    'javascript:alert(1)',
    'http://example.com/insecure-review',
    '/relative-review',
    'not a URL',
  ])('uses the neutral confirmation for an unsafe review URL: %s', async (url) => {
    const user = userEvent.setup();
    const fetchMock = vi.mocked(fetch);
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    fetchMock.mockResolvedValueOnce(apiResponse({ next: 'google', url }));

    render(<SurveyPage params={{ orderId: ORDER_ID }} />);
    await user.click(screen.getByRole('button', { name: 'Rate 5 stars' }));
    await user.click(screen.getByRole('button', { name: 'Submit' }));

    const heading = await screen.findByRole('heading', {
      name: 'Thank you for your feedback.',
    });
    expect(
      screen.getByText(
        'Your response has been recorded. You may close this page.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: 'Continue to Google' }),
    ).not.toBeInTheDocument();
    expect(clickSpy).not.toHaveBeenCalled();
    await waitFor(() => expect(heading).toHaveFocus());
  });

  it('uses the neutral confirmation when an initial rating is complete', async () => {
    const user = userEvent.setup();
    vi.mocked(fetch).mockResolvedValueOnce(
      apiResponse({ next: 'complete' }),
    );

    render(<SurveyPage params={{ orderId: ORDER_ID }} />);
    await user.click(screen.getByRole('button', { name: 'Rate 4 stars' }));
    await user.click(screen.getByRole('button', { name: 'Submit' }));

    expect(
      await screen.findByRole('heading', {
        name: 'Thank you for your feedback.',
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'Your response has been recorded. You may close this page.',
      ),
    ).toBeInTheDocument();
  });

  it('turns a 404 into a focused unavailable-link page instead of offering a retry', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      apiResponse({ error: 'Unknown order' }, false, 404),
    );

    render(<SurveyPage params={{ orderId: ORDER_ID }} />);
    await user.click(screen.getByRole('button', { name: 'Rate 2 stars' }));
    await user.click(screen.getByRole('button', { name: 'Submit' }));

    const heading = await screen.findByRole('heading', {
      name: 'This survey link is unavailable',
    });
    expect(heading).toHaveFocus();
    expect(
      screen.getByText(
        "We couldn't find a survey for this link. Please check that you opened the complete link from your text message.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Submit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it.each([409, 500])(
    'keeps the selected rating retryable after a %s response',
    async (status) => {
      const user = userEvent.setup();
      const fetchMock = vi.mocked(fetch);
      fetchMock.mockResolvedValueOnce(
        apiResponse({ error: 'Internal details must stay hidden' }, false, status),
      );

      render(<SurveyPage params={{ orderId: ORDER_ID }} />);
      const rating = screen.getByRole('button', { name: 'Rate 2 stars' });
      const submitButton = screen.getByRole('button', { name: 'Submit' });
      const form = submitButton.closest('form');
      await user.click(rating);
      await user.click(submitButton);

      expect(await screen.findByRole('alert')).toHaveTextContent(
        "We couldn't save your response. Please try again.",
      );
      expect(screen.queryByText(/Internal details/i)).not.toBeInTheDocument();
      expect(rating).toHaveAttribute('aria-pressed', 'true');
      expect(form).toHaveAttribute('aria-busy', 'false');

      fetchMock.mockResolvedValueOnce(apiResponse({ next: 'questionnaire' }));
      await user.click(submitButton);
      const questionnaireHeading = await screen.findByRole('heading', {
        name: 'Tell us about your visit',
      });
      expect(questionnaireHeading).toHaveFocus();
      expect(postedBody(0)).toEqual(postedBody(1));
    },
  );

  it('marks the rating form busy and blocks changes and duplicate submissions while pending', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.mocked(fetch);
    let resolveRequest: ((response: Response) => void) | undefined;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveRequest = resolve;
        }),
    );

    render(<SurveyPage params={{ orderId: ORDER_ID }} />);
    const rating = screen.getByRole('button', { name: 'Rate 4 stars' });
    await user.click(rating);
    const submitButton = screen.getByRole('button', { name: 'Submit' });
    const form = submitButton.closest('form');
    expect(form).not.toBeNull();
    fireEvent.submit(form as HTMLFormElement);
    fireEvent.submit(form as HTMLFormElement);

    expect(await screen.findByRole('button', { name: 'Submitting…' })).toBeDisabled();
    expect(form).toHaveAttribute('aria-busy', 'true');
    expect(rating).toBeDisabled();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveRequest?.(apiResponse({ next: 'complete' }));
    await screen.findByRole('heading', {
      name: 'Thank you for your feedback.',
    });
  });

  it('shows six named native radio groups with the required scale guidance', async () => {
    const { user } = await openQuestionnaire();

    expect(
      screen.getByText(/For every question, 1 is poor and 5 is excellent/i),
    ).toBeInTheDocument();

    for (const item of QUESTIONNAIRE_ITEMS) {
      const group = screen.getByRole('group', {
        name: new RegExp(item.label.replace(/[?]/g, '\\?')),
      });
      const radios = within(group).getAllByRole('radio');
      expect(radios).toHaveLength(5);
      expect(radios.every((radio) => radio.hasAttribute('required'))).toBe(
        true,
      );
      expect(within(group).getByText('1 = Poor')).toBeInTheDocument();
      expect(within(group).getByText('5 = Excellent')).toBeInTheDocument();
    }

    const firstGroup = screen.getByRole('group', {
      name: /How satisfied were you with your wait time\?/,
    });
    const firstRadio = within(firstGroup).getByRole('radio', { name: '1' });
    firstRadio.focus();
    await user.keyboard('[Space]');
    expect(firstRadio).toBeChecked();
  });

  it('rejects a partial questionnaire and focuses the first unanswered question', async () => {
    const { user, fetchMock } = await openQuestionnaire();
    const firstGroup = screen.getByRole('group', {
      name: /How satisfied were you with your wait time\?/,
    });

    await user.click(screen.getByRole('button', { name: 'Submit feedback' }));

    expect(
      screen.getByRole('alert'),
    ).toHaveTextContent('Please answer all six questions');
    const firstRadio = within(firstGroup).getByRole('radio', { name: '1' });
    expect(firstRadio).toHaveFocus();
    expect(firstRadio).toHaveAttribute('aria-invalid', 'true');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('posts the exact six-answer payload with a trimmed optional comment', async () => {
    const { user, fetchMock } = await openQuestionnaire();
    fetchMock.mockResolvedValueOnce(apiResponse({ next: 'complete' }));
    const scores: QuestionnaireAnswers = {
      waitTime: 1,
      serviceSpeed: 2,
      vehicleCleanliness: 3,
      additionalServicesExperience: 4,
      value: 5,
      teamFriendliness: 4,
    };

    await answerEveryQuestion(user, scores);
    await user.type(
      screen.getByRole('textbox', { name: /Anything we can improve?/i }),
      '  More frequent progress updates  ',
    );
    await user.click(screen.getByRole('button', { name: 'Submit feedback' }));

    const doneHeading = await screen.findByRole('heading', {
      name: 'Thank you for helping us improve.',
    });
    expect(
      screen.getByText(
        'Your feedback has been recorded. Our team will use it to improve future visits. You may close this page.',
      ),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(postedBody(1)).toEqual({
      orderId: ORDER_ID,
      answers: scores,
      comment: 'More frequent progress updates',
    });
    await waitFor(() => expect(doneHeading).toHaveFocus());
  });

  it('omits a blank comment and caps customer input at 2,000 characters', async () => {
    const { user, fetchMock } = await openQuestionnaire();
    fetchMock.mockResolvedValueOnce(apiResponse({ next: 'complete' }));
    const scores: QuestionnaireAnswers = {
      waitTime: 5,
      serviceSpeed: 5,
      vehicleCleanliness: 5,
      additionalServicesExperience: 5,
      value: 5,
      teamFriendliness: 5,
    };
    await answerEveryQuestion(user, scores);
    const comment = screen.getByRole('textbox', {
      name: /Anything we can improve?/i,
    });

    fireEvent.change(comment, {
      target: { value: 'x'.repeat(MAX_COMMENT_LENGTH + 1) },
    });
    expect(comment).toHaveValue('x'.repeat(MAX_COMMENT_LENGTH));
    expect(
      screen.getByText('2,000 / 2,000 characters'),
    ).toBeInTheDocument();

    fireEvent.change(comment, { target: { value: '   ' } });
    await user.click(screen.getByRole('button', { name: 'Submit feedback' }));
    await screen.findByRole('heading', {
      name: 'Thank you for helping us improve.',
    });

    expect(postedBody(1)).toEqual({ orderId: ORDER_ID, answers: scores });
  });

  it('preserves every answer and the comment after an error so submission can be retried', async () => {
    const { user, fetchMock } = await openQuestionnaire();
    const scores: QuestionnaireAnswers = {
      waitTime: 2,
      serviceSpeed: 3,
      vehicleCleanliness: 4,
      additionalServicesExperience: 5,
      value: 1,
      teamFriendliness: 2,
    };
    await answerEveryQuestion(user, scores);
    const comment = screen.getByRole('textbox', {
      name: /Anything we can improve?/i,
    });
    await user.type(comment, 'Please keep this feedback');
    fetchMock.mockRejectedValueOnce(new Error('temporary failure'));

    await user.click(screen.getByRole('button', { name: 'Submit feedback' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "We couldn't save your response. Please try again.",
    );

    for (const item of QUESTIONNAIRE_ITEMS) {
      const group = screen.getByRole('group', {
        name: new RegExp(item.label.replace(/[?]/g, '\\?')),
      });
      expect(
        within(group).getByRole('radio', {
          name: String(scores[item.key]),
        }),
      ).toBeChecked();
    }
    expect(comment).toHaveValue('Please keep this feedback');

    fetchMock.mockResolvedValueOnce(apiResponse({ next: 'complete' }));
    await user.click(screen.getByRole('button', { name: 'Submit feedback' }));
    await screen.findByRole('heading', {
      name: 'Thank you for helping us improve.',
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(postedBody(1)).toEqual(postedBody(2));
  });

  it('preserves all questionnaire input after a 409 and retries with the identical payload', async () => {
    const { user, fetchMock } = await openQuestionnaire();
    const scores: QuestionnaireAnswers = {
      waitTime: 5,
      serviceSpeed: 4,
      vehicleCleanliness: 3,
      additionalServicesExperience: 2,
      value: 1,
      teamFriendliness: 5,
    };
    await answerEveryQuestion(user, scores);
    const comment = screen.getByRole('textbox', {
      name: /Anything we can improve?/i,
    });
    await user.type(comment, 'Please preserve this concurrency feedback');
    fetchMock.mockResolvedValueOnce(
      apiResponse({ error: 'Survey response changed' }, false, 409),
    );

    await user.click(screen.getByRole('button', { name: 'Submit feedback' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      "We couldn't save your response. Please try again.",
    );
    for (const item of QUESTIONNAIRE_ITEMS) {
      const group = screen.getByRole('group', {
        name: new RegExp(item.label.replace(/[?]/g, '\\?')),
      });
      expect(
        within(group).getByRole('radio', {
          name: String(scores[item.key]),
        }),
      ).toBeChecked();
    }
    expect(comment).toHaveValue('Please preserve this concurrency feedback');

    fetchMock.mockResolvedValueOnce(apiResponse({ next: 'complete' }));
    await user.click(screen.getByRole('button', { name: 'Submit feedback' }));
    await screen.findByRole('heading', {
      name: 'Thank you for helping us improve.',
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(postedBody(1)).toEqual({
      orderId: ORDER_ID,
      answers: scores,
      comment: 'Please preserve this concurrency feedback',
    });
    expect(postedBody(2)).toEqual(postedBody(1));
  });

  it('prevents double submission while the questionnaire request is pending', async () => {
    const { user, fetchMock } = await openQuestionnaire();
    const scores: QuestionnaireAnswers = {
      waitTime: 4,
      serviceSpeed: 4,
      vehicleCleanliness: 4,
      additionalServicesExperience: 4,
      value: 4,
      teamFriendliness: 4,
    };
    await answerEveryQuestion(user, scores);

    let resolveRequest: ((response: Response) => void) | undefined;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveRequest = resolve;
        }),
    );

    const submitButton = screen.getByRole('button', {
      name: 'Submit feedback',
    });
    const form = submitButton.closest('form');
    expect(form).not.toBeNull();
    fireEvent.submit(form as HTMLFormElement);
    fireEvent.submit(form as HTMLFormElement);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      await screen.findByRole('button', { name: 'Submitting…' }),
    ).toBeDisabled();
    expect(form).toHaveAttribute('aria-busy', 'true');

    resolveRequest?.(apiResponse({ next: 'complete' }));
    await screen.findByRole('heading', {
      name: 'Thank you for helping us improve.',
    });
  });

  it('keeps the selected rating available when a malformed response must be retried', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(apiResponse({ ok: true }));

    render(<SurveyPage params={{ orderId: ORDER_ID }} />);
    const rating = screen.getByRole('button', { name: 'Rate 2 stars' });
    await user.click(rating);
    await user.click(screen.getByRole('button', { name: 'Submit' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      "We couldn't save your response. Please try again.",
    );
    expect(rating).toHaveAttribute('aria-pressed', 'true');
  });

  it('keeps the selected rating after malformed JSON and permits a retry', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('provider response details');
      },
    } as unknown as Response);

    render(<SurveyPage params={{ orderId: ORDER_ID }} />);
    const rating = screen.getByRole('button', { name: 'Rate 1 star' });
    await user.click(rating);
    await user.click(screen.getByRole('button', { name: 'Submit' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      "We couldn't save your response. Please try again.",
    );
    expect(screen.queryByText(/provider response/i)).not.toBeInTheDocument();
    expect(rating).toHaveAttribute('aria-pressed', 'true');

    fetchMock.mockResolvedValueOnce(apiResponse({ next: 'questionnaire' }));
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    expect(
      await screen.findByRole('heading', { name: 'Tell us about your visit' }),
    ).toHaveFocus();
  });

  it('aborts at 15 seconds, shows the timeout message, and preserves the rating', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.mocked(fetch);
      fetchMock.mockImplementationOnce(
        (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            signal?.addEventListener(
              'abort',
              () => reject(new DOMException('Aborted', 'AbortError')),
              { once: true },
            );
          }),
      );

      render(<SurveyPage params={{ orderId: ORDER_ID }} />);
      const rating = screen.getByRole('button', { name: 'Rate 3 stars' });
      fireEvent.click(rating);
      const submitButton = screen.getByRole('button', { name: 'Submit' });
      const form = submitButton.closest('form');
      fireEvent.submit(form as HTMLFormElement);

      expect(form).toHaveAttribute('aria-busy', 'true');
      const signal = fetchMock.mock.calls[0]?.[1]?.signal;
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal?.aborted).toBe(false);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(14_999);
      });
      expect(signal?.aborted).toBe(false);
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(signal?.aborted).toBe(true);
      expect(screen.getByRole('alert')).toHaveTextContent(
        'This is taking longer than expected. Please try again.',
      );
      expect(rating).toHaveAttribute('aria-pressed', 'true');
      expect(form).toHaveAttribute('aria-busy', 'false');
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the existing invalid-link message without contacting the API', () => {
    const fetchMock = vi.mocked(fetch);
    render(<SurveyPage params={{ orderId: '' }} />);

    expect(
      screen.getByRole('heading', { name: 'Invalid survey link' }),
    ).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
