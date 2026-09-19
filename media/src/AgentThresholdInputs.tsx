import {
  AGENT_PROFILE_FIELD_META,
  type AgentProfileMetric,
  type AgentSource,
  type AgentThresholdProfiles,
} from './agentProfiles'
import type { ComponentChildren } from 'preact'
import { useEffect, useState } from 'preact/hooks'

export const DISPLAY_AGENT_ORDER: AgentSource[] = ['copilot', 'claude_code', 'codex', 'opencode', 'cursor']

interface AgentThresholdInputsProps {
  profiles: AgentThresholdProfiles
  metrics: AgentProfileMetric[]
  onChange: (source: AgentSource, metric: AgentProfileMetric, value: number) => void
}

interface AgentThresholdNumberInputsProps {
  profiles: AgentThresholdProfiles
  metricName: string
  unit: string
  values: Record<AgentSource, number>
  min: number
  max: number
  onChange: (source: AgentSource, value: number) => void
}

interface ThresholdNumberTextInputProps {
  value: number
  min: number
  max: number
  width: number
  ariaLabel: string
  onChange: (value: number) => void
}

function ThresholdShell({ label, children }: { label: string; children: ComponentChildren }) {
  return (
    <div style="display:grid;gap:6px;font-size:12px;margin:8px 0">
      <div class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:.4px;font-weight:700">{label}</div>
      {children}
    </div>
  )
}

function thresholdLabel(): string {
  return 'Agent Thresholds'
}

function parseThresholdDraft(value: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(value)) return null
  const next = Number(value)
  if (!Number.isSafeInteger(next) || next < min || next > max) return null
  return next
}

function thresholdInputStyle(width: number, invalid: boolean): string {
  return 'width:' + width + 'px;background:var(--bg);color:var(--fg,inherit);border:1px solid '
    + (invalid ? 'var(--error)' : 'var(--border)')
    + ';border-radius:3px;padding:2px 6px;font-size:12px'
}

export function ThresholdNumberTextInput({ value, min, max, width, ariaLabel, onChange }: ThresholdNumberTextInputProps) {
  const [draft, setDraft] = useState(String(value))

  useEffect(() => {
    setDraft(String(value))
  }, [value])

  const invalid = draft !== '' && parseThresholdDraft(draft, min, max) === null

  return (
    <input
      type="text"
      inputMode="numeric"
      pattern="[0-9]*"
      value={draft}
      aria-label={ariaLabel}
      aria-invalid={invalid ? 'true' : 'false'}
      title={'Enter a number from ' + min.toLocaleString() + ' to ' + max.toLocaleString()}
      onChange={e => {
        const nextDraft = (e.target as HTMLInputElement).value
        if (!/^\d*$/.test(nextDraft)) return
        setDraft(nextDraft)
        const next = parseThresholdDraft(nextDraft, min, max)
        if (next !== null) {
          onChange(next)
        }
      }}
      onBlur={() => {
        if (parseThresholdDraft(draft, min, max) === null) {
          setDraft(String(value))
        }
      }}
      style={thresholdInputStyle(width, invalid)}
    />
  )
}

function AgentName({ source, profiles }: { source: AgentSource; profiles: AgentThresholdProfiles }) {
  const profile = profiles[source]
  return (
    <span style="display:flex;align-items:center;gap:5px;white-space:nowrap">
      <span style={'display:inline-block;width:7px;height:7px;border-radius:50%;background:' + profile.color} />
      <span>{profile.label}</span>
    </span>
  )
}

export function AgentThresholdInputs({ profiles, metrics, onChange }: AgentThresholdInputsProps) {
  return (
    <>
      {metrics.map(metric => {
        const meta = AGENT_PROFILE_FIELD_META[metric]
        return (
          <ThresholdShell key={metric} label={thresholdLabel()}>
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
              {DISPLAY_AGENT_ORDER.map(source => (
                <label key={source} style="display:flex;align-items:center;gap:6px;background:var(--panel-bg);border:1px solid var(--border);border-radius:4px;padding:4px 6px">
                  <AgentName source={source} profiles={profiles} />
                  <ThresholdNumberTextInput
                    value={profiles[source][metric]}
                    min={meta.min}
                    max={meta.max}
                    width={50}
                    ariaLabel={profiles[source].label + ' ' + meta.label}
                    onChange={next => onChange(source, metric, next)}
                  />
                  <span class="muted">{meta.unit}</span>
                </label>
              ))}
            </div>
          </ThresholdShell>
        )
      })}
    </>
  )
}

export function AgentThresholdNumberInputs({
  profiles,
  metricName,
  unit,
  values,
  min,
  max,
  onChange,
}: AgentThresholdNumberInputsProps) {
  return (
    <ThresholdShell label={thresholdLabel()}>
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        {DISPLAY_AGENT_ORDER.map(source => (
          <label key={source} style="display:flex;align-items:center;gap:6px;background:var(--panel-bg);border:1px solid var(--border);border-radius:4px;padding:4px 6px">
            <AgentName source={source} profiles={profiles} />
            <ThresholdNumberTextInput
              value={values[source]}
              min={min}
              max={max}
              width={62}
              ariaLabel={profiles[source].label + ' ' + metricName}
              onChange={next => onChange(source, next)}
            />
            <span class="muted">{unit}</span>
          </label>
        ))}
      </div>
    </ThresholdShell>
  )
}
