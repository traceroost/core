import { gunzipSync } from 'zlib'

/** A request body as the fake cloud sees it: the sender gzips bodies over ~1 KiB. */
export function decodeBody(body: unknown, headers?: unknown): string {
  const h = new Headers(headers as ConstructorParameters<typeof Headers>[0])
  if (h.get('content-encoding') === 'gzip') return gunzipSync(body as Uint8Array).toString('utf8')
  return String(body)
}
