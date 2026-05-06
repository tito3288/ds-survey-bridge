import { Resend } from 'resend';

export const resend = new Resend(process.env.RESEND_API_KEY!);

export const supportEmail = process.env.SUPPORT_EMAIL || 'support@driveandshine.com';

export async function sendNegativeFeedbackEmail(params: {
  orderId: string;
  rating: number;
  comment: string;
  customerPhone?: string;
  locationName?: string;
}) {
  const { orderId, rating, comment, customerPhone, locationName } = params;

  return resend.emails.send({
    from: 'Drive & Shine Survey <noreply@driveandshine.com>',
    to: supportEmail,
    subject: `Low rating (${rating}★) - Order ${orderId}`,
    text: [
      `A customer left a low rating.`,
      ``,
      `Order ID: ${orderId}`,
      `Rating: ${rating}/5`,
      `Location: ${locationName ?? 'Unknown'}`,
      `Customer phone: ${customerPhone ?? 'Unknown'}`,
      ``,
      `Comment:`,
      comment,
    ].join('\n'),
  });
}
