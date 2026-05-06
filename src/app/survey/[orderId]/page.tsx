type SurveyPageProps = {
  params: { orderId: string };
};

export default function SurveyPage({ params }: SurveyPageProps) {
  const { orderId } = params;

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-white p-6">
      <div className="w-full max-w-md text-center">
        <h1 className="text-2xl font-semibold text-gray-900">
          How was your visit?
        </h1>
        <p className="mt-2 text-sm text-gray-500">Order #{orderId}</p>

        <div className="mt-8 flex justify-center gap-2">
          {[1, 2, 3, 4, 5].map((star) => (
            <button
              key={star}
              type="button"
              className="text-4xl text-gray-300 hover:text-yellow-400 transition-colors"
              aria-label={`Rate ${star} star${star === 1 ? '' : 's'}`}
            >
              ★
            </button>
          ))}
        </div>

        <p className="mt-8 text-xs text-gray-400">
          Thanks for choosing Drive &amp; Shine.
        </p>
      </div>
    </main>
  );
}
