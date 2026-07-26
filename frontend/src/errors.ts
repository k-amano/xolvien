// Cause-based error codes shared with the backend (app/errors.py). The frontend
// looks up human-friendly copy by code (see i18n errorCatalog); the raw detail
// is shown only in the left log pane, never in the error banner.

export const ERROR_CODES = [
  'CONTAINER_NOT_RUNNING',
  'TIMEOUT',
  'CLAUDE_API_ERROR',
  'CLAUDE_AUTH_FAILED',
  'CLAUDE_CLI_ERROR',
  'CLAUDE_PERMISSION_LOOP',
  'UPLOAD_NOT_AVAILABLE',
  'SPEC_NOT_READ',
  'GIT_AUTH_FAILED',
  'GIT_PUSH_REJECTED',
  'TEST_INFRA_ERROR',
  'NETWORK_ERROR',
  'UNKNOWN',
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

function isErrorCode(s: string): s is ErrorCode {
  return (ERROR_CODES as readonly string[]).includes(s)
}

// Ordered (code, pattern) rules — first match wins. Mirrors the backend rules in
// app/errors.py; keep the two in sync.
const RULES: [ErrorCode, RegExp][] = [
  ['NETWORK_ERROR', /failed to fetch|networkerror|load failed/i],
  ['TIMEOUT', /timed out|timeout|no output for/i],
  ['CONTAINER_NOT_RUNNING', /not running|no container|container .* not found|did not start/i],
  ['CLAUDE_PERMISSION_LOOP', /repeated .* times|aborting to prevent infinite loop/i],
  ['CLAUDE_AUTH_FAILED', /oauth.*(revoked|expired)|authentication_error|failed to authenticate|invalid (api |x-api-)key|please run \/login|not logged in/i],
  ['GIT_AUTH_FAILED', /authentication failed|could not read username|permission denied \(publickey\)|fatal: could not read/i],
  ['GIT_PUSH_REJECTED', /\[rejected\]|non-fast-forward|failed to push|updates were rejected/i],
  ['TEST_INFRA_ERROR', /eacces|eperm|enoent|enospc|cannot find module|command not found/i],
  ['CLAUDE_API_ERROR', /anthropic|claude api|rate limit|overloaded|api error|\b529\b|\b429\b/i],
]

/**
 * Classify an error from HTTP status + raw text. A status of 0 (fetch threw)
 * maps to NETWORK_ERROR. Used as the fallback whenever the backend did not
 * supply a code via the stream sentinel or a structured JSON body.
 */
export function classifyError(status: number | null, text: string): ErrorCode {
  if (status === 0) return 'NETWORK_ERROR'
  const t = text || ''
  for (const [code, pattern] of RULES) {
    if (pattern.test(t)) return code
  }
  return 'UNKNOWN'
}

const SENTINEL_RE = /\n?\[\[XOLVIEN_ERROR:([A-Z_]+)\]\][^\n]*\n?/

/**
 * Extract a terminal error sentinel emitted by a streaming endpoint.
 * Returns the matched code (validated, else UNKNOWN) and the text with the
 * sentinel line removed so it never reaches the chat/banner. Returns
 * `{ code: null }` when no sentinel is present.
 */
export function extractSentinel(text: string): { code: ErrorCode | null; cleaned: string } {
  const m = text.match(SENTINEL_RE)
  if (!m) return { code: null, cleaned: text }
  const raw = m[1]
  const code: ErrorCode = isErrorCode(raw) ? raw : 'UNKNOWN'
  return { code, cleaned: text.replace(SENTINEL_RE, '') }
}

/** Try to read a structured `{ code, message, detail }` body (non-streaming). */
export function codeFromBody(text: string): ErrorCode | null {
  try {
    const obj = JSON.parse(text)
    if (obj && typeof obj.code === 'string' && isErrorCode(obj.code)) return obj.code
  } catch {
    /* not JSON */
  }
  return null
}
