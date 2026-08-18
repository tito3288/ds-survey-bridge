import { describe, expect, it, vi } from 'vitest';
import {
  PROVIDER_WEBHOOK_MAX_BODY_BYTES,
  readProviderWebhookBody,
} from './provider-webhook-http';

function streamedRequest(
  chunks: Uint8Array[],
  onCancel: () => void = () => undefined,
): Request {
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index];
      index += 1;
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
    cancel: onCancel,
  });

  return { body, headers: new Headers() } as Request;
}

describe('provider webhook body reader', () => {
  it('preserves the exact UTF-8 body across stream chunk boundaries', async () => {
    const encoded = new TextEncoder().encode('{"value":"café"}\n');
    const splitInsideMultibyteCharacter = encoded.indexOf(0xc3) + 1;
    const request = streamedRequest([
      encoded.slice(0, splitInsideMultibyteCharacter),
      encoded.slice(splitInsideMultibyteCharacter),
    ]);

    await expect(readProviderWebhookBody(request)).resolves.toEqual({
      ok: true,
      body: '{"value":"café"}\n',
    });
  });

  it('cancels a chunked request as soon as it crosses the byte limit', async () => {
    const onCancel = vi.fn();
    const request = streamedRequest(
      [
        new Uint8Array(PROVIDER_WEBHOOK_MAX_BODY_BYTES),
        new Uint8Array([1]),
      ],
      onCancel,
    );

    await expect(readProviderWebhookBody(request)).resolves.toEqual({
      ok: false,
      status: 413,
    });
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
