// Per-phase run-duration history, used to estimate remaining time for phases
// that emit no granular progress events (clarify, prompt generation,
// implementation). Stored in localStorage so estimates survive reloads and
// improve as the user runs more tasks in this browser.

const STORAGE_KEY = 'xolvien-phase-durations'
const KEEP_LAST = 10

type DurationMap = Record<string, number[]>

function load(): DurationMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch {
    return {}
  }
}

export function recordPhaseDuration(flow: string, ms: number): void {
  if (!Number.isFinite(ms) || ms <= 0) return
  try {
    const map = load()
    map[flow] = [...(map[flow] ?? []), Math.round(ms)].slice(-KEEP_LAST)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {
    // localStorage unavailable (private mode etc.) — estimates just stay off
  }
}

// Median of past runs — robust against one unusually slow/fast run.
export function estimatePhaseMs(flow: string): number | null {
  const runs = load()[flow]
  if (!runs || runs.length === 0) return null
  const sorted = [...runs].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}
