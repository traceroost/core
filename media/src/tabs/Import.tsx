import { useEffect, useRef, useState } from 'preact/hooks'
import { vscode } from '../state'
import { getAgentColor, getAgentSourceLabel } from '../utils'

type Phase = 'idle' | 'preview' | 'importing' | 'done'

interface ParsedSession {
  sessionId: string
  source: string
  startTime?: string
  [key: string]: unknown
}

interface ImportPreview {
  fileName: string
  fileSize: number
  sessions: ParsedSession[]
  bySource: Record<string, number>
  minDate: string
  maxDate: string
}

interface ImportDoneState {
  imported: number
  skipped: number
  failed: number
  total: number
}

const VALID_SOURCES = new Set(['copilot', 'claude_code', 'codex', 'opencode'])

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
  } catch { return iso }
}

export function Import() {
  const [phase, setPhase] = useState<Phase>('idle')
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [progress, setProgress] = useState<{ imported: number; total: number }>({ imported: 0, total: 0 })
  const [doneState, setDoneState] = useState<ImportDoneState | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    function handler(event: MessageEvent) {
      const msg = event.data as { type: string; imported?: number; total?: number; skipped?: number; failed?: number }
      if (msg.type === 'importProgress') {
        setProgress({ imported: msg.imported ?? 0, total: msg.total ?? 0 })
      } else if (msg.type === 'importDone') {
        setDoneState({ imported: msg.imported ?? 0, skipped: msg.skipped ?? 0, failed: msg.failed ?? 0, total: msg.total ?? 0 })
        setPhase('done')
      } else if (msg.type === 'importError') {
        setError(`Import failed: ${(msg as { message?: string }).message ?? 'unknown error'}`)
        setPhase('preview')
      }
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [])

  function parseFile(file: File) {
    setError(null)
    const reader = new FileReader()
    reader.onload = (e) => {
      try {
        const text = e.target?.result as string
        const data = JSON.parse(text)
        if (!Array.isArray(data)) throw new Error('Expected a JSON array — is this a TraceRoost export file?')
        if (data.length === 0) throw new Error('The file contains no traces')

        const sessions: ParsedSession[] = data.map((item: unknown, i: number) => {
          if (typeof item !== 'object' || item === null) throw new Error(`Item ${i + 1} is not an object`)
          const s = item as Record<string, unknown>
          if (typeof s['sessionId'] !== 'string' || !s['sessionId']) throw new Error(`Item ${i + 1} is missing sessionId`)
          if (typeof s['source'] !== 'string' || !VALID_SOURCES.has(s['source'])) throw new Error(`Item ${i + 1} has unrecognized source: "${s['source']}"`)
          return s as ParsedSession
        })

        const bySource: Record<string, number> = {}
        let minDate = ''
        let maxDate = ''
        for (const s of sessions) {
          bySource[s.source] = (bySource[s.source] ?? 0) + 1
          if (s.startTime) {
            if (!minDate || s.startTime < minDate) minDate = s.startTime
            if (!maxDate || s.startTime > maxDate) maxDate = s.startTime
          }
        }

        setPreview({ fileName: file.name, fileSize: file.size, sessions, bySource, minDate, maxDate })
        setPhase('preview')
      } catch (err) {
        setError(`Could not read file: ${(err as Error).message}`)
      }
    }
    reader.readAsText(file)
  }

  function onFileInput(e: Event) {
    const input = e.target as HTMLInputElement
    if (input.files?.[0]) parseFile(input.files[0])
    input.value = ''
  }

  function onDrop(e: DragEvent) {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer?.files[0]
    if (file) parseFile(file)
  }

  async function doImport() {
    if (!preview) return
    setPhase('importing')
    setProgress({ imported: 0, total: preview.sessions.length })
    if (vscode && !window.__STANDALONE__) {
      vscode.postMessage({ type: 'importSessionData', sessions: preview.sessions })
    } else {
      try {
        const BATCH = 50
        const total = preview.sessions.length
        let imported = 0
        let skipped = 0
        for (let i = 0; i < preview.sessions.length; i += BATCH) {
          const batch = preview.sessions.slice(i, i + BATCH)
          const r = await fetch('/api/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessions: batch }),
          })
          if (!r.ok) throw new Error(`Server responded ${r.status}`)
          const result = await r.json() as { imported: number; skipped: number; failed: number }
          imported += result.imported
          skipped += result.skipped
          setProgress({ imported, total })
        }
        setDoneState({ imported, skipped, failed: 0, total })
        setPhase('done')
      } catch (err) {
        setError(`Import failed: ${(err as Error).message}`)
        setPhase('preview')
      }
    }
  }

  function reset() {
    setPhase('idle')
    setPreview(null)
    setDoneState(null)
    setError(null)
    setProgress({ imported: 0, total: 0 })
  }

  if (phase === 'idle') {
    return (
      <div id="import-content">
        <div
          class={'import-drop-zone' + (dragOver ? ' import-drop-zone-hover' : '')}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          onClick={() => fileInputRef.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click() }}
        >
          <svg class="import-drop-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
          </svg>
          <p class="import-drop-primary">Drop a TraceRoost export file here</p>
          <p class="import-drop-secondary">or <span class="import-drop-link">click to browse</span> — accepts <code>.json</code> export files</p>
          <input ref={fileInputRef} type="file" accept=".json" style="display:none" onChange={onFileInput} />
        </div>
        {error && <p class="import-error">{error}</p>}
      </div>
    )
  }

  if (phase === 'preview' && preview) {
    const isLarge = preview.sessions.length > 200
    const dateRange = preview.minDate && preview.maxDate
      ? preview.minDate.slice(0, 10) === preview.maxDate.slice(0, 10)
        ? formatDate(preview.minDate)
        : `${formatDate(preview.minDate)} – ${formatDate(preview.maxDate)}`
      : null

    return (
      <div id="import-content">
        <div class="import-preview-card">
          <div class="import-preview-header">
            <span class="import-preview-filename">{preview.fileName}</span>
            <span class="import-preview-filesize">{formatBytes(preview.fileSize)}</span>
          </div>

          <div class="import-preview-stats">
            <span class="import-preview-count">{preview.sessions.length}</span>
            <span class="import-preview-count-label"> traces</span>
            {dateRange && <span class="import-preview-dates">{dateRange}</span>}
          </div>

          <div class="import-source-pills">
            {Object.entries(preview.bySource).map(([source, count]) => (
              <span
                key={source}
                class="import-source-pill"
                style={`border-color:${getAgentColor(source)};color:${getAgentColor(source)}`}
              >
                {getAgentSourceLabel(source)} {count}
              </span>
            ))}
          </div>

          <p class="import-dedup-note">Traces already in your database will be skipped.</p>

          {isLarge && (
            <div class="import-large-warning">
              Large import — this will be processed in batches and may take a few seconds.
            </div>
          )}

          <div class="import-preview-actions">
            <button class="export-btn" onClick={doImport}>
              Import {preview.sessions.length} session{preview.sessions.length !== 1 ? 's' : ''}
            </button>
            <button class="export-btn export-btn-secondary" onClick={reset}>Cancel</button>
          </div>
        </div>
        {error && <p class="import-error" style="margin-top:12px">{error}</p>}
      </div>
    )
  }

  if (phase === 'importing') {
    const total = progress.total
    const done = progress.imported
    const pct = total > 0 ? Math.round((done / total) * 100) : 0
    return (
      <div id="import-content">
        <div class="import-preview-card">
          <p class="import-progress-label">Importing…</p>
          <div class="import-progress-track">
            <div class="import-progress-fill" style={`width:${pct}%`} />
          </div>
          <p class="import-progress-text">{done} / {total}</p>
        </div>
      </div>
    )
  }

  if (phase === 'done' && doneState) {
    return (
      <div id="import-content">
        <div class="import-preview-card import-done-card">
          <div class="import-done-icon">✓</div>
          <p class="import-done-title">Import complete</p>
          <p class="import-done-detail">
            {doneState.imported} trace{doneState.imported !== 1 ? 's' : ''} imported
            {doneState.skipped > 0 ? `, ${doneState.skipped} already existed` : ''}
            {doneState.failed > 0 ? `, ${doneState.failed} failed to write` : ''}
          </p>
          <button class="export-btn export-btn-secondary import-again-btn" onClick={reset}>
            Import another file
          </button>
        </div>
      </div>
    )
  }

  return null
}
