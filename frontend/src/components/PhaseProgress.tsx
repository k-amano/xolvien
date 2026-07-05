import { useEffect, useMemo, useState } from 'react'
import { useLang } from '../i18n'
import { estimatePhaseMs } from '../services/phaseHistory'

function fmtMs(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`
}

interface PhaseProgressProps {
  label: string
  startedAt: number
  // History key for time-based estimation (phases with no granular events).
  flow?: string
  // Real progress when granular events exist; takes precedence over the
  // time-based estimate. null/undefined = unknown.
  progress?: { done: number; total: number } | null
  color?: string
}

// Busy-phase status line: label + live elapsed time + estimated remaining
// (from `progress` when granular events exist, else from past run durations)
// + a progress bar (determinate / time-estimated / indeterminate, in that
// order of preference). Roadmap 4.2.
export function PhaseProgress({ label, startedAt, flow, progress, color = '#94a3b8' }: PhaseProgressProps) {
  const { t } = useLang()
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  // Snapshot the historical estimate once per phase start, not per tick.
  const estimateMs = useMemo(
    () => (flow ? estimatePhaseMs(flow) : null),
    [flow, startedAt],
  )

  const elapsedMs = Math.max(0, now - startedAt)

  let fraction: number | null = null
  let remainingMs: number | null = null
  if (progress && progress.total > 0) {
    fraction = Math.min(1, progress.done / progress.total)
    // Remaining from the observed pace of this very run.
    if (progress.done > 0 && progress.done < progress.total) {
      remainingMs = (elapsedMs / progress.done) * (progress.total - progress.done)
    }
  } else if (estimateMs !== null) {
    // Time-based estimate from past runs; never claim completion.
    fraction = Math.min(0.95, elapsedMs / estimateMs)
    if (elapsedMs < estimateMs) remainingMs = estimateMs - elapsedMs
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', flex: 1, minWidth: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'baseline' }}>
        <span style={{ color }}>{label}</span>
        <span style={{ color: '#64748b', fontSize: '0.72rem', whiteSpace: 'nowrap' }}>
          {t.phaseElapsed(fmtMs(elapsedMs))}
          {remainingMs !== null && ` ・ ${t.phaseRemaining(fmtMs(remainingMs))}`}
        </span>
      </div>
      <div className="phase-progress-track">
        {fraction !== null ? (
          <div className="phase-progress-fill" style={{ width: `${Math.round(fraction * 100)}%` }} />
        ) : (
          <div className="phase-progress-fill phase-progress-indeterminate" />
        )}
      </div>
    </div>
  )
}
