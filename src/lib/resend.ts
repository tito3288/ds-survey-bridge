import { Resend } from 'resend';

export const resend = new Resend(process.env.RESEND_API_KEY!);

export const supportEmails = (
  process.env.SUPPORT_EMAIL || 'support@driveandshine.com'
)
  .split(',')
  .map((e) => e.trim())
  .filter(Boolean);

export async function sendNegativeFeedbackEmail(params: {
  orderId: string;
  rating: number;
  comment: string;
  locationId?: string;
  locationName?: string;
  customerPhone?: string;
}) {
  const { orderId, rating, comment, locationId, locationName, customerPhone } =
    params;

  const locationLine = locationName
    ? `${locationName}${locationId ? ` (${locationId})` : ''}`
    : locationId ?? 'Unknown';

  return resend.emails.send({
    // TODO: switch to 'Drive & Shine Survey <noreply@driveandshine.com>' once driveandshine.com is verified in Resend (production).
    from: 'Drive & Shine <onboarding@resend.dev>',
    to: supportEmails,
    subject: `Negative feedback received - Order ${orderId}`,
    text: [
      `A customer left negative feedback.`,
      ``,
      `Order ID: ${orderId}`,
      `Rating: ${rating}/5`,
      `Location: ${locationLine}`,
      `Customer phone: ${customerPhone ?? 'Unknown'}`,
      ``,
      `Comment:`,
      comment,
    ].join('\n'),
  });
}
