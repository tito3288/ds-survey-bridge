import 'server-only';

export const PROVIDER_WEBHOOK_MAX_BODY_BYTES = 64 * 1024;

export function hasContentType(request: Request, expected: string): boolean {
  const contentType = request.headers.get('content-type');
  return contentType?.split(';', 1)[0]?.trim().toLowerCase() === expected;
}

export async function readProviderWebhookBody(
  request: Request,
): Promise<
  | { ok: true; body: string }
  | { ok: false; status: 400 | 413 }
> {
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) return { ok: false, status: 400 };
    if (Number(contentLength) > PROVIDER_WEBHOOK_MAX_BODY_BYTES) {
      return { ok: false, status: 413 };
    }
  }

  const reader = request.body?.getReader();
  if (!reader) return { ok: true, body: '' };

  const decoder = new TextDecoder();
  let body = '';
  let bodyBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      bodyBytes += value.byteLength;
      if (bodyBytes > PROVIDER_WEBHOOK_MAX_BODY_BYTES) {
        await reader.cancel();
        return { ok: false, status: 413 };
      }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
  } catch {
    return { ok: false, status: 400 };
  } finally {
    reader.releaseLock();
  }
  return { ok: true, body };
}

export function emptyWebhookResponse(status: number): Response {
  return new Response(null, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
