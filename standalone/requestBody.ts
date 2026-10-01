/** Buffers a request body up to `maxBytes`. Resolves null as soon as the body grows past it (the
 *  rest is read and dropped), so the caller can answer 413 — with `Connection: close`, as the OTLP
 *  receiver does — without holding an unbounded upload in memory. */
export function readBodyLimited(req: NodeJS.ReadableStream, maxBytes: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let done = false
    req.on('data', (c: Buffer | string) => {
      if (done) return
      size += c.length
      if (size > maxBytes) {
        done = true
        chunks.length = 0
        resolve(null)
        return
      }
      chunks.push(typeof c === 'string' ? Buffer.from(c) : c)
    })
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks)) } })
    req.on('error', (e: Error) => { if (!done) { done = true; reject(e) } })
  })
}
