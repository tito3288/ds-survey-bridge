import 'server-only';

import { Resend } from 'resend';
import { getRequiredEnv } from '@/lib/env';
import {
  QUESTIONNAIRE_ITEMS,
  type QuestionnaireAnswers,
  type SurveyScore,
} from '@/lib/questionnaire';
import type { Json } from '@/types/database';

let resendClient: Resend | undefined;

function getResendClient(): Resend {
  if (!resendClient) {
    resendClient = new Resend(getRequiredEnv('RESEND_API_KEY'));
  }

  return resendClient;
}

function getSupportEmails(): string[] {
  return (process.env.SUPPORT_EMAIL || 'support@driveandshine.com')
    .split(',')
    .map((email) => email.trim())
    .filter(Boolean);
}

function formatServices(services: Json | null | undefined): string {
  if (typeof services === 'string') {
    return services.trim() || 'Unknown';
  }

  if (!Array.isArray(services)) {
    return 'Unknown';
  }

  const names = services.flatMap((service) => {
    if (typeof service === 'string') {
      const name = service.trim();
      return name ? [name] : [];
    }

    if (service && typeof service === 'object' && !Array.isArray(service)) {
      const name = service.name;
      return typeof name === 'string' && name.trim() ? [name.trim()] : [];
    }

    return [];
  });

  return names.length > 0 ? names.join(', ') : 'Unknown';
}

export async function sendPrivateFeedbackEmail(params: {
  orderId: string;
  rating: SurveyScore;
  answers: QuestionnaireAnswers;
  comment?: string | null;
  locationId?: string;
  locationName?: string;
  customerName?: string;
  customerPhone?: string;
  services?: Json | null;
}) {
  const {
    orderId,
    rating,
    answers,
    comment,
    locationId,
    locationName,
    customerName,
    customerPhone,
    services,
  } = params;

  const locationLine = locationName
    ? `${locationName}${locationId ? ` (${locationId})` : ''}`
    : locationId ?? 'Unknown';
  const normalizedComment = comment?.trim() || 'Not provided';
  const scoreLines = QUESTIONNAIRE_ITEMS.map(
    (item) => `${item.label} ${answers[item.key]}/5`,
  );

  return getResendClient().emails.send({
    // TODO: switch to 'Drive & Shine Survey <noreply@driveandshine.com>' once driveandshine.com is verified in Resend (production).
    from: 'Drive & Shine <onboarding@resend.dev>',
    to: getSupportEmails(),
    subject: `Private oil change survey feedback - Order ${orderId}`,
    text: [
      `A customer completed the private oil change questionnaire.`,
      ``,
      `Order ID: ${orderId}`,
      `Overall rating: ${rating}/5`,
      `Location: ${locationLine}`,
      `Customer name: ${customerName ?? 'Unknown'}`,
      `Customer phone: ${customerPhone ?? 'Unknown'}`,
      `Services: ${formatServices(services)}`,
      ``,
      `Questionnaire scores (1 = Poor, 5 = Excellent):`,
      ...scoreLines,
      ``,
      `Anything we can improve?`,
      normalizedComment,
    ].join('\n'),
  });
}
