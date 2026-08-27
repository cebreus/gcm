const MAX_RESPONSE_BODY_BYTES = 1024 * 1024;

export async function readResponseBody(response: Response): Promise<string> {
  if (!response.body) return response.text();
  let bytesRead = 0;
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform: function (chunk, controller): void {
        bytesRead += chunk.byteLength;
        if (bytesRead > MAX_RESPONSE_BODY_BYTES) throw new Error('response body too large');
        controller.enqueue(chunk);
      },
    }),
  );
  return new Response(body).text();
}
