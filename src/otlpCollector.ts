import * as http from 'http'
import * as vscode from 'vscode'
import { SessionStore } from './sessionStore'
import { isAllowedHostHeader, isAllowedOrigin, isAllowedOtlpContentType } from './httpSecurity'
import { OtlpIngest } from './otlpIngest'

const MAX_BODY_BYTES = 50 * 1024 * 1024 // 50 MB

export class OtlpCollector {
  private server!: http.Server
  private ingestionEnabled = true
  // Parsing and its cross-payload Codex/gen_ai state, shared with the standalone server.
  private readonly ingest: OtlpIngest

  constructor(
    private port: number,
    store: SessionStore,
    private output: vscode.OutputChannel
  ) {
    this.ingest = new OtlpIngest(store)
  }

  setIngestionEnabled(on: boolean) {
    this.ingestionEnabled = on
  }

  async start() {
    this.server = http.createServer((req, res) => {
      // Bound to 127.0.0.1 with no token, so the only callers to keep out are web pages open in
      // the user's browser: a DNS-rebinding page (wrong Host), or any site POSTing fake spans
      // cross-origin — it would send an Origin, and to avoid a CORS preflight it must use a
      // "simple" Content-Type like text/plain. Planted spans end up in MCP tool output that agents
      // are told to read, so this is a prompt-injection path, not just junk data.
      if (!isAllowedHostHeader(req.headers.host, '127.0.0.1')) {
        this.log(req.method ?? '?', req.url ?? '/', 403, 0, 'invalid Host header')
        res.writeHead(403); res.end(); return
      }
      if (!isAllowedOrigin(req.headers.origin)) {
        this.log(req.method ?? '?', req.url ?? '/', 403, 0, 'cross-origin request refused')
        res.writeHead(403); res.end(); return
      }
      if (req.method === 'POST' && !isAllowedOtlpContentType(req.headers['content-type'])) {
        this.log('POST', req.url ?? '/', 415, 0, `unsupported Content-Type ${req.headers['content-type']}`)
        res.writeHead(415); res.end(); return
      }

      const chunks: Buffer[] = []
      let size = 0
      let aborted = false

      req.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > MAX_BODY_BYTES) {
          aborted = true
          req.destroy()
          this.log(req.method ?? '?', req.url ?? '/', 413, size, 'body too large')
          res.writeHead(413)
          res.end()
          return
        }
        chunks.push(chunk)
      })

      req.on('error', (err) => {
        this.log(req.method ?? '?', req.url ?? '/', 400, size, `request error: ${err.message}`)
        if (!res.headersSent) {
          res.writeHead(400)
          res.end()
        }
      })

      req.on('end', () => {
        if (aborted || req.destroyed) {return}
        try {
          this.handleBody(req, res, chunks)
        } catch (err) {
          // Malformed-but-parseable OTLP must never leave the socket hanging or crash the host.
          this.log(req.method ?? '?', req.url ?? '/', 400, size, `malformed payload: ${err instanceof Error ? err.message : String(err)}`)
          if (!res.headersSent) { res.writeHead(400) }
          res.end()
        }
      })
    })

    this.server.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') {
        this.output.appendLine(`[OTLP] ERR server: ${err.message}`)
      }
    })
    
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.port, '127.0.0.1', () => {
        this.server.removeListener('error', reject)
        resolve()
      })
    })
  }

  private handleBody(req: http.IncomingMessage, res: http.ServerResponse, chunks: Buffer[]) {
    const body = Buffer.concat(chunks).toString('utf-8')
    const bodyLen = body.length
    
    if (req.method === 'GET' && req.url === '/traceroost/plugin') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ traceroost: true, kind: 'plugin' }))
      return
    }

    if (req.method !== 'POST') {
      this.log(req.method ?? '?', req.url ?? '/', 200, bodyLen, 'ignored (non-POST)')
      res.writeHead(200)
      res.end()
      return
    }

    let payload: unknown
    try {
      payload = JSON.parse(body)
    } catch {
      this.log('POST', req.url ?? '/', 200, bodyLen, 'non-JSON payload (protobuf?)')
      res.writeHead(200)
      res.end()
      return
    }

    if (!this.ingestionEnabled) {
      res.writeHead(200)
      res.end()
      return
    }

    let summary: string
    if (req.url === '/v1/traces' || this.ingest.isOtlpTracePayload(payload)) {
      const count = this.ingest.processTraces(payload, req.url ?? '/v1/traces')
      summary = `${count} span${count !== 1 ? 's' : ''} ingested`
    } else if (req.url === '/v1/logs' || this.ingest.isOtlpLogPayload(payload)) {
      const count = this.ingest.processLogs(payload)
      summary = `${count} log${count !== 1 ? 's' : ''} ingested`
    } else if (req.url === '/v1/metrics' || this.ingest.isOtlpMetricPayload(payload)) {
      const { metrics, points } = this.ingest.processMetrics(payload)
      summary = `${metrics} metric${metrics !== 1 ? 's' : ''}, ${points} point${points !== 1 ? 's' : ''}`
    } else {
      summary = 'unrecognized payload'
    }

    this.log('POST', req.url ?? '/', 200, bodyLen, summary)
    res.writeHead(200)
    res.end()
  }

  /** Single structured log line per request: method, path, status, size, summary */
  private log(method: string, path: string, status: number, bytes: number, summary: string) {
    this.output.appendLine(`[OTLP] ${method} ${path} ${status} ${bytes}B → ${summary}`)
  }

  async stop() {
    return new Promise<void>((resolve) => {
      if (!this.server) {
        resolve()
        return
      }
      this.server.close(() => resolve())
      // Force close after 2 seconds
      setTimeout(() => resolve(), 2000)
    })
  }
}
