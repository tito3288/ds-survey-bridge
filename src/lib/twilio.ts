import twilio from 'twilio';

const accountSid = process.env.TWILIO_ACCOUNT_SID!;
const authToken = process.env.TWILIO_AUTH_TOKEN!;

export const twilioClient = twilio(accountSid, authToken);

export const twilioPhoneNumber = process.env.TWILIO_PHONE_NUMBER!;

export async function sendSurveySMS(params: {
  to: string;
  customerName?: string | null;
  orderId: string;
}): Promise<string> {
  const { to, customerName, orderId } = params;

  const greeting =
    customerName && customerName.trim().length > 0
      ? `Hi ${customerName.trim()}!`
      : 'Hi there!';

  const surveyUrl = `${process.env.APP_URL}/survey/${orderId}`;
  const body = `${greeting} Thanks for visiting Drive & Shine today. How was your oil change? Tap to rate: ${surveyUrl} — Drive & Shine`;

  const message = await twilioClient.messages.create({
    body,
    from: twilioPhoneNumber,
    to,
  });

  return message.sid;
}
