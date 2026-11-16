export async function boundedBody(
  source: Pick<Request, "body" | "headers">,
  maxBytes: number,
): Promise<Uint8Array> {
  if (Number(source.headers.get("content-length") ?? 0) > maxBytes)
    throw new Error("PAYLOAD_TOO_LARGE");
  if (!source.body) return new Uint8Array();
  const reader = source.body.getReader(),
    chunks: Uint8Array[] = [];
  let length = 0,
    timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void reader.cancel();
  }, 10000);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (timedOut) throw new Error("BODY_TIMEOUT");
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        throw new Error("PAYLOAD_TOO_LARGE");
      }
      chunks.push(value);
    }
    const output = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return output;
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}
