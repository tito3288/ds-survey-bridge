import twilio from 'twilio';

const accountSid = process.env.TWILIO_ACCOUNT_SID!;
const authToken = process.env.TWILIO_AUTH_TOKEN!;

export const twilioClient = twilio(accountSid, authToken);

export const twilioPhoneNumber = process.env.TWILIO_PHONE_NUMBER!;

export async function sendSurveySms(toPhoneNumber: string, surveyUrl: string) {
  return twilioClient.messages.create({
    body: `Thanks for visiting Drive & Shine! How was your experience? Rate us here: ${surveyUrl}`,
    from: twilioPhoneNumber,
    to: toPhoneNumber,
  });
}
