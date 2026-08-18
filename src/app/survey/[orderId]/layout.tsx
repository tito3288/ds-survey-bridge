import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Oil Change Survey | Drive & Shine',
  description: 'Share feedback about your Drive & Shine oil change experience.',
};

export default function SurveyLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return children;
}
