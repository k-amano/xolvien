import { useEffect, useRef, useState, useCallback } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import type { Task, TaskLog, TaskStatus, LogLevel } from '../types'
import { getTask, getLogs, stopTask, executeInstructionStream, generatePromptStream, clarifyStream, gitPushStream, resetWorkspace, generateTestCasesStream, generateIntegrationTestCasesStream, generateE2ETestCasesStream, runUnitTestsStream, runIntegrationTestsStream, runE2ETestsStream, getTestRuns, getLastCompletedInstruction, getTestCaseItems, createStreamJsonRouter } from '../services/api'
import type { TestCaseItem } from '../types'
import { useLang } from '../i18n'
import { classifyError, type ErrorCode } from '../errors'
import { useRepositoryUploads, AttachFilesButton, AttachedFilesChips } from '../components/RepositoryUploads'
import { PhaseProgress } from '../components/PhaseProgress'
import { recordPhaseDuration } from '../services/phaseHistory'

// Granular progress attached to a busy chat entry (roadmap 4.2); null while
// the phase has produced no countable events yet.
type PhaseCount = { done: number; total: number } | null

type ChatEntry =
  | { type: 'user_instruction'; content: string }
  | { type: 'clarify_question'; content: string }
  | { type: 'clarify_answer'; content: string }
  | { type: 'clarify_streaming'; content: string; startedAt: number }
  | { type: 'prompt_generating'; startedAt: number }
  | { type: 'prompt_generated'; content: string; confirmed: boolean }
  | { type: 'implementation_running'; startedAt: number }
  | { type: 'implementation_done' }
  | { type: 'test_cases_generating'; startedAt: number }
  | { type: 'test_cases_ready'; items: TestCaseItem[]; approved: boolean }
  | { type: 'integration_test_cases_generating'; startedAt: number }
  | { type: 'integration_test_cases_ready'; items: TestCaseItem[]; approved: boolean }
  | { type: 'e2e_test_cases_generating'; startedAt: number }
  | { type: 'e2e_test_cases_ready'; items: TestCaseItem[]; approved: boolean }
  | { type: 'test_running'; label: string; startedAt: number; progress: PhaseCount }
  | { type: 'test_done'; summary: string; passed: boolean; items: TestCaseItem[] }
  | { type: 'review'; prompt: string; items: TestCaseItem[]; resolved: boolean }
  | { type: 'error'; code: ErrorCode }
  | { type: 'info'; message: string }

type StepId = 'implement' | 'unit_test' | 'integration_test' | 'e2e_test' | 'review'
type StepStatus = 'done_pass' | 'done_fail' | 'active' | 'pending'

interface StepInfo {
  id: StepId
  label: string
  status: StepStatus
  future?: boolean
}


function getStatusClass(status: TaskStatus): string {
  switch (status) {
    case 'pending':
    case 'initializing':
      return 'status-badge status-pending'
    case 'idle':
      return 'status-badge status-idle'
    case 'running':
    case 'testing':
      return 'status-badge status-running'
    case 'completed':
      return 'status-badge status-completed'
    default:
      return 'status-badge status-pending'
  }
}

function getLogLineClass(level: LogLevel): string {
  switch (level) {
    case 'error':
    case 'critical':
      return 'log-line log-line-error'
    case 'warning':
      return 'log-line log-line-warning'
    case 'info':
      return 'log-line log-line-info'
    case 'debug':
      return 'log-line log-line-debug'
    default:
      return 'log-line log-line-info'
  }
}

function formatLogTimestamp(dateStr: string): string {
  try {
    const d = new Date(dateStr)
    const hh = String(d.getHours()).padStart(2, '0')
    const mm = String(d.getMinutes()).padStart(2, '0')
    const ss = String(d.getSeconds()).padStart(2, '0')
    return `${hh}:${mm}:${ss}`
  } catch {
    return ''
  }
}

function fmtHms(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  return h > 0
    ? `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

// Parse a clarify question into question text and option list.
// Expected format (English or Japanese):
//   [question text]
//   \n
//   Options: / 選択肢:
//   - option A
//   - option B
function parseClarifyQuestion(text: string): { question: string; options: string[] } {
  const optionHeaderRe = /^(?:options|選択肢)\s*:/im
  const match = optionHeaderRe.exec(text)
  if (!match) return { question: text.trim(), options: [] }

  const question = text.slice(0, match.index).trim()
  const optionsBlock = text.slice(match.index + match[0].length)
  const options: string[] = []
  for (const line of optionsBlock.split('\n')) {
    const m = line.match(/^\s*[-*]\s+(.+)$/)
    if (m) options.push(m[1].trim())
  }
  return { question, options }
}

// A log entry can be either a structured TaskLog or a stream chunk
type LogEntry =
  | { kind: 'log'; data: TaskLog }
  | { kind: 'stream'; text: string; key: string; started: boolean }


export default function TaskDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const taskId = Number(id)
  const { t, lang, setLang, errorCatalog } = useLang()

  function getStatusLabel(status: TaskStatus): string {
    switch (status) {
      case 'pending': return t.statusPending
      case 'initializing': return t.statusInitializing
      case 'idle': return t.statusIdle
      case 'running': return t.statusRunning
      case 'testing': return t.statusTesting
      case 'completed': return t.statusCompleted
      default: return status
    }
  }

  function getIdleStatusMessage(status: TaskStatus): string | null {
    switch (status) {
      case 'pending':
      case 'initializing':
        return t.msgPreparing
      case 'running':
        return t.msgRunning
      case 'testing':
        return t.msgTesting
      case 'completed':
        return t.msgCompleted
      default:
        return null
    }
  }

  function getStepLabel(stepId: StepId): string {
    switch (stepId) {
      case 'implement': return t.stepImplement
      case 'unit_test': return t.stepUnitTest
      case 'integration_test': return t.stepIntegrationTest
      case 'e2e_test': return t.stepE2ETest
      case 'review': return t.stepReview
    }
  }

  const [task, setTask] = useState<Task | null>(null)
  const repoUploads = useRepositoryUploads(task?.repository_id)
  const [taskError, setTaskError] = useState<string | null>(null)
  // Active (unresolved) execution error — surfaced as a prominent banner in the
  // right pane. All action buttons stay disabled until the user dismisses it.
  const [activeError, setActiveError] = useState<ErrorCode | null>(null)
  const [logEntries, setLogEntries] = useState<LogEntry[]>([])
  const [instruction, setInstruction] = useState('')
  // Messages typed while a previous operation is still running. They are queued
  // (FIFO) and auto-sent one at a time as soon as the app is idle again.
  const [pendingMessages, setPendingMessages] = useState<string[]>([])
  const flushingQueueRef = useRef(false)
  const [streaming, setStreaming] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [pushing, setPushing] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [clarifying, setClarifying] = useState(false)

  // Test case / test run state
  const [generatingTestCases, setGeneratingTestCases] = useState(false)
  const [tcGenLabel, setTcGenLabel] = useState<string | null>(null)
  const [tcGenProgress, setTcGenProgress] = useState<PhaseCount>(null)
  const [runningTests, setRunningTests] = useState(false)
  const [, setRunningTestType] = useState<'unit' | 'integration' | 'e2e' | null>(null)
  const [, setTestPhaseLabel] = useState<string | null>(null)
  const testCountRef = useRef({ passed: 0, failed: 0 })
  const genCodeProgressRef = useRef({ done: 0, total: 0, startMs: 0 })
  const setTestResultSummary = (_v: string | null) => { /* stored in chatEntries */ }
  const setTestPassed = (_v: boolean | null) => { /* stored in chatEntries */ }
  const [, setTestCaseItems] = useState<TestCaseItem[]>([])
  const [, setIntegrationTestCaseItems] = useState<TestCaseItem[]>([])
  const [, setE2ETestCaseItems] = useState<TestCaseItem[]>([])
  const [confirmedPrompt, setConfirmedPrompt] = useState('')
  const [inputTab, setInputTab] = useState<'write' | 'preview'>('write')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Chat history (append-only)
  const [chatEntries, setChatEntries] = useState<ChatEntry[]>([])
  const streamingEntryIndexRef = useRef<number>(-1)
  const chatEndRef = useRef<HTMLDivElement>(null)

  // Surface an execution error by cause-based code: raise the prominent banner
  // (which gates all action buttons) and append a code-keyed entry to the chat
  // history. The raw technical `detail` is pushed to the left log pane ONLY — it
  // is never shown in the banner or chat (the user sees friendly copy by code).
  // Push the raw technical detail to the left log pane only (never the banner).
  const logErrorDetail = useCallback((detail?: string) => {
    if (!detail) return
    const fakeLog: TaskLog = {
      id: Date.now(),
      task_id: taskId,
      level: 'error',
      source: 'system',
      message: detail,
      created_at: new Date().toISOString(),
    }
    setLogEntries(prev => [...prev, { kind: 'log', data: fakeLog }])
  }, [taskId])

  const raiseError = useCallback((code: ErrorCode, detail?: string) => {
    setActiveError(code)
    setChatEntries(prev => [...prev, { type: 'error', code }])
    logErrorDetail(detail)
  }, [logErrorDetail])

  // Resume / step navigation state
  const [resumeChecked, setResumeChecked] = useState(false)
  const [selectedStep, setSelectedStep] = useState<StepId | null>(null)
  const [steps, setSteps] = useState<StepInfo[]>([
    { id: 'implement',        label: '',  status: 'pending' },
    { id: 'unit_test',        label: '',  status: 'pending' },
    { id: 'integration_test', label: '',  status: 'pending' },
    { id: 'e2e_test',         label: '',  status: 'pending' },
    { id: 'review',           label: '',  status: 'pending' },
  ])

  const logViewerRef = useRef<HTMLDivElement>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const seenLogIdsRef = useRef<Set<number>>(new Set())
  const streamKeyRef = useRef(0)

  // Resizable split pane (left/right)
  const bodyRef = useRef<HTMLDivElement>(null)
  const isDraggingRef = useRef(false)
  const [logWidthPercent, setLogWidthPercent] = useState(50)

  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      if (!isDraggingRef.current || !bodyRef.current) return
      const rect = bodyRef.current.getBoundingClientRect()
      const pct = ((e.clientX - rect.left) / rect.width) * 100
      setLogWidthPercent(Math.min(80, Math.max(20, pct)))
    }
    function onMouseUp() {
      isDraggingRef.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [])

  function handleResizeStart(e: React.MouseEvent) {
    e.preventDefault()
    isDraggingRef.current = true
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }

  // On first load: collect step history from DB and restore state
  useEffect(() => {
    if (resumeChecked) return
    setResumeChecked(true)

    async function checkResume() {
      try {
        const [runs, lastInstruction, unitItems, integrationItems, e2eItems] = await Promise.all([
          getTestRuns(taskId),
          getLastCompletedInstruction(taskId),
          getTestCaseItems(taskId, 'unit'),
          getTestCaseItems(taskId, 'integration'),
          getTestCaseItems(taskId, 'e2e'),
        ])

        const hasImpl = !!lastInstruction
        const completedUnitRuns = runs.filter(r => r.test_type === 'unit' && r.completed_at)
        const lastUnit = completedUnitRuns.length > 0
          ? completedUnitRuns.reduce((a, b) => (a.id > b.id ? a : b))
          : undefined
        const completedIntegrationRuns = runs.filter(r => r.test_type === 'integration' && r.completed_at)
        const lastIntegration = completedIntegrationRuns.length > 0
          ? completedIntegrationRuns.reduce((a, b) => (a.id > b.id ? a : b))
          : undefined
        const completedE2ERuns = runs.filter(r => r.test_type === 'e2e' && r.completed_at)
        const lastE2E = completedE2ERuns.length > 0
          ? completedE2ERuns.reduce((a, b) => (a.id > b.id ? a : b))
          : undefined

        if (!hasImpl && !lastUnit && !lastIntegration && !lastE2E) return

        const prompt = lastInstruction?.content ?? ''
        const initialEntries: ChatEntry[] = []

        if (prompt) {
          setConfirmedPrompt(prompt)
          initialEntries.push({ type: 'user_instruction', content: prompt })
          initialEntries.push({ type: 'prompt_generated', content: prompt, confirmed: true })
          initialEntries.push({ type: 'implementation_done' })
        }

        if (unitItems.length > 0) {
          setTestCaseItems(unitItems)
          const testCasesApproved = lastUnit != null
          initialEntries.push({ type: 'test_cases_ready', items: unitItems, approved: testCasesApproved })
        } else if (hasImpl) {
          initialEntries.push({ type: 'test_cases_ready', items: [], approved: false })
        }

        if (lastUnit) {
          setTestResultSummary(lastUnit.summary ?? null)
          setTestPassed(lastUnit.passed)
          initialEntries.push({
            type: 'test_done',
            summary: lastUnit.summary ?? '',
            passed: lastUnit.passed,
            items: unitItems,
          })
          if (lastUnit.passed) {
            if (integrationItems.length > 0) {
              setIntegrationTestCaseItems(integrationItems)
              const integrationTCApproved = lastIntegration != null
              initialEntries.push({ type: 'integration_test_cases_ready', items: integrationItems, approved: integrationTCApproved })
            } else {
              initialEntries.push({ type: 'integration_test_cases_ready', items: [], approved: false })
            }
            if (lastIntegration) {
              initialEntries.push({
                type: 'test_done',
                summary: lastIntegration.summary ?? '',
                passed: lastIntegration.passed,
                items: integrationItems,
              })
              if (lastIntegration.passed) {
                if (e2eItems.length > 0) {
                  setE2ETestCaseItems(e2eItems)
                  const e2eTCApproved = lastE2E != null
                  initialEntries.push({ type: 'e2e_test_cases_ready', items: e2eItems, approved: e2eTCApproved })
                } else {
                  initialEntries.push({ type: 'e2e_test_cases_ready', items: [], approved: false })
                }
                if (lastE2E) {
                  initialEntries.push({
                    type: 'test_done',
                    summary: lastE2E.summary ?? '',
                    passed: lastE2E.passed,
                    items: e2eItems,
                  })
                  if (lastE2E.passed) {
                    initialEntries.push({ type: 'review', prompt, items: unitItems, resolved: false })
                  }
                }
              }
            }
          } else {
            initialEntries.push({ type: 'test_cases_ready', items: unitItems, approved: false })
          }
        }

        setChatEntries(initialEntries)

        setSteps(prev => prev.map(step => {
          switch (step.id) {
            case 'implement':
              return hasImpl ? { ...step, status: 'done_pass' } : step
            case 'unit_test':
              if (!lastUnit) return hasImpl ? { ...step, status: 'active' } : step
              return lastUnit.passed
                ? { ...step, status: 'done_pass' }
                : { ...step, status: 'done_fail' }
            case 'integration_test':
              if (!lastUnit?.passed) return step
              if (!lastIntegration) return { ...step, status: 'active' }
              return lastIntegration.passed
                ? { ...step, status: 'done_pass' }
                : { ...step, status: 'done_fail' }
            case 'e2e_test':
              if (!lastIntegration?.passed) return step
              if (!lastE2E) return { ...step, status: 'active' }
              return lastE2E.passed
                ? { ...step, status: 'done_pass' }
                : { ...step, status: 'done_fail' }
            case 'review':
              return lastE2E?.passed ? { ...step, status: 'active' } : step
            default:
              return step
          }
        }))

        if (lastE2E?.passed) setSelectedStep('review')
        else if (lastE2E) setSelectedStep('e2e_test')
        else if (lastIntegration?.passed) setSelectedStep('e2e_test')
        else if (lastIntegration) setSelectedStep('integration_test')
        else if (lastUnit?.passed) setSelectedStep('integration_test')
        else if (lastUnit) setSelectedStep('unit_test')
        else if (hasImpl) setSelectedStep('unit_test')

      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        const status = (err as { response?: { status?: number } })?.response?.status ?? 0
        const code = classifyError(status, detail)
        setActiveError(code)
        setChatEntries([{ type: 'error', code }])
        const fakeLog: TaskLog = {
          id: Date.now(), task_id: taskId, level: 'error', source: 'system',
          message: detail, created_at: new Date().toISOString(),
        }
        setLogEntries(prev => [...prev, { kind: 'log', data: fakeLog }])
      }
    }

    checkResume()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId])

  // Auto-scroll chat history when new entries arrive
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chatEntries])

  // Auto-scroll log viewer
  const scrollToBottom = useCallback(() => {
    const el = logViewerRef.current
    if (el) {
      requestAnimationFrame(() => { el.scrollTop = el.scrollHeight })
    }
  }, [])

  useEffect(() => {
    scrollToBottom()
  }, [logEntries, scrollToBottom])

  // Fetch initial task data
  const fetchTask = useCallback(async () => {
    try {
      const data = await getTask(taskId)
      setTask(data)
      setTaskError(null)
    } catch (err) {
      setTaskError(
        err instanceof Error ? err.message : t.fetchTaskFailed
      )
    }
  }, [taskId, t])

  // Poll task status every 2 seconds
  useEffect(() => {
    fetchTask()
    const interval = setInterval(fetchTask, 2000)
    return () => clearInterval(interval)
  }, [fetchTask])

  // Fetch initial logs
  useEffect(() => {
    getLogs(taskId, 500)
      .then(logs => {
        const entries: LogEntry[] = logs
          .filter(log => log.source !== 'claude' && log.source !== 'git')
          .map(log => {
            seenLogIdsRef.current.add(log.id)
            return { kind: 'log', data: log }
          })
        setLogEntries(prev => [...entries, ...prev.filter(e => e.kind === 'stream')])
        requestAnimationFrame(() => {
          const el = logViewerRef.current
          if (el) el.scrollTop = el.scrollHeight
        })
      })
      .catch(err => {
        console.error('Failed to fetch logs:', err)
      })
  }, [taskId])

  // WebSocket for real-time logs
  useEffect(() => {
    const wsUrl = `ws://localhost:8000/api/v1/ws/tasks/${taskId}/logs`

    const ws = new WebSocket(wsUrl)
    wsRef.current = ws

    ws.onopen = () => {
      console.log('WebSocket connected for task', taskId)
    }

    ws.onmessage = (event: MessageEvent) => {
      try {
        const parsed = JSON.parse(event.data as string)
        if (parsed.type === 'connected' || parsed.type === 'ping') return
        const log: TaskLog = parsed
        if (seenLogIdsRef.current.has(log.id)) return
        seenLogIdsRef.current.add(log.id)
        // claude/git logs are already shown via the stream; skip them here to avoid duplication
        if (log.source === 'claude' || log.source === 'git') return
        setLogEntries(prev => [...prev, { kind: 'log', data: log }])
      } catch {
        const fakeLog: TaskLog = {
          id: Date.now(),
          task_id: taskId,
          level: 'info',
          source: 'system',
          message: event.data as string,
          created_at: new Date().toISOString(),
        }
        setLogEntries(prev => [...prev, { kind: 'log', data: fakeLog }])
      }
    }

    ws.onerror = (event) => {
      console.error('WebSocket error:', event)
    }

    ws.onclose = () => {
      console.log('WebSocket closed for task', taskId)
    }

    return () => {
      ws.close()
      wsRef.current = null
    }
  }, [taskId])

  // ─── Handler functions ────────────────────────────────────────────────────

  async function handleResetAndRebuild() {
    if (clarifying || generating) return
    const msgToUse = confirmedPrompt || instruction.trim()
    try {
      await resetWorkspace(taskId)
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      raiseError(classifyError(0, detail), detail)
      return
    }
    // Restore to the same initial state as a new task
    setSelectedStep(null)
    setSteps([
      { id: 'implement',        label: '',  status: 'pending' },
      { id: 'unit_test',        label: '',  status: 'pending' },
      { id: 'integration_test', label: '',  status: 'pending' },
      { id: 'e2e_test',         label: '',  status: 'pending' },
      { id: 'review',           label: '',  status: 'pending' },
    ])
    setConfirmedPrompt('')
    setChatEntries([])
    setInstruction(msgToUse)
  }

  async function handleStartClarify(overrideMsg?: string) {
    const userMsg = overrideMsg ?? instruction.trim()
    if (!userMsg || clarifying || generating) return
    setInstruction('')

    setChatEntries([{ type: 'user_instruction', content: userMsg }])
    setClarifying(true)

    streamKeyRef.current += 1
    const clarifyKey = `stream-${streamKeyRef.current}`
    setLogEntries(prev => [...prev, { kind: 'stream', text: '', key: clarifyKey, started: false }])

    let streamedText = ''
    const router = createStreamJsonRouter()
    const phaseStartMs = Date.now()
    setChatEntries(prev => {
      streamingEntryIndexRef.current = prev.length
      return [...prev, { type: 'clarify_streaming', content: '', startedAt: phaseStartMs }]
    })

    await clarifyStream(
      taskId,
      userMsg,
      [],
      (chunk) => {
        // Left pane: raw stream-json verbatim. Right pane: reconstructed text.
        const { raw } = router.push(chunk)
        streamedText = router.text()
        setLogEntries(prev => prev.map(e =>
          e.kind === 'stream' && e.key === clarifyKey ? { ...e, text: e.text + raw, started: true } : e
        ))
        setChatEntries(prev => prev.map((e, i) =>
          i === streamingEntryIndexRef.current && e.type === 'clarify_streaming'
            ? { ...e, content: streamedText }
            : e
        ))
      },
      () => {
        setClarifying(false)
        recordPhaseDuration('clarify', Date.now() - phaseStartMs)
        streamedText = router.text()
        if (streamedText.startsWith('PROMPT_READY')) {
          const prompt = streamedText.replace(/^PROMPT_READY\r?\n+/, '')
          setChatEntries(prev => prev.map((e, i) =>
            i === streamingEntryIndexRef.current
              ? { type: 'prompt_generated', content: prompt, confirmed: false }
              : e
          ))
        } else {
          setChatEntries(prev => prev.map((e, i) =>
            i === streamingEntryIndexRef.current
              ? { type: 'clarify_question', content: streamedText.trim() }
              : e
          ))
        }
      },
      (code, detail) => {
        setClarifying(false)
        setActiveError(code)
        logErrorDetail(detail)
        setChatEntries(prev => prev.map((e, i) =>
          i === streamingEntryIndexRef.current
            ? { type: 'error', code }
            : e
        ))
      },
      lang
    )
  }

  async function submitClarifyAnswer(userMsg: string) {
    if (!userMsg || clarifying) return

    // Build history from chatEntries
    const history = chatEntries
      .filter(e => e.type === 'clarify_question' || e.type === 'clarify_answer')
      .map(e => ({
        role: (e.type === 'clarify_question' ? 'assistant' : 'user') as 'assistant' | 'user',
        content: (e as { content: string }).content,
      }))
    const newHistory = [...history, { role: 'user' as const, content: userMsg }]

    const phaseStartMs = Date.now()
    setChatEntries(prev => {
      const withAnswer = [...prev, { type: 'clarify_answer' as const, content: userMsg }]
      streamingEntryIndexRef.current = withAnswer.length
      return [...withAnswer, { type: 'clarify_streaming' as const, content: '', startedAt: phaseStartMs }]
    })
    setClarifying(true)

    streamKeyRef.current += 1
    const clarifyKey = `stream-${streamKeyRef.current}`
    setLogEntries(prev => [...prev, { kind: 'stream', text: '', key: clarifyKey, started: false }])

    let streamedText = ''
    const router = createStreamJsonRouter()
    await clarifyStream(
      taskId,
      (chatEntries.find(e => e.type === 'user_instruction') as { content: string } | undefined)?.content ?? '',
      newHistory,
      (chunk) => {
        const { raw } = router.push(chunk)
        streamedText = router.text()
        setLogEntries(prev => prev.map(e =>
          e.kind === 'stream' && e.key === clarifyKey ? { ...e, text: e.text + raw, started: true } : e
        ))
        setChatEntries(prev => prev.map((e, i) =>
          i === streamingEntryIndexRef.current && e.type === 'clarify_streaming'
            ? { ...e, content: streamedText }
            : e
        ))
      },
      () => {
        setClarifying(false)
        recordPhaseDuration('clarify', Date.now() - phaseStartMs)
        streamedText = router.text()
        if (streamedText.startsWith('PROMPT_READY')) {
          const prompt = streamedText.replace(/^PROMPT_READY\r?\n+/, '')
          setChatEntries(prev => prev.map((e, i) =>
            i === streamingEntryIndexRef.current
              ? { type: 'prompt_generated', content: prompt, confirmed: false }
              : e
          ))
        } else {
          setChatEntries(prev => prev.map((e, i) =>
            i === streamingEntryIndexRef.current
              ? { type: 'clarify_question', content: streamedText.trim() }
              : e
          ))
        }
      },
      (code, detail) => {
        setClarifying(false)
        setActiveError(code)
        logErrorDetail(detail)
        setChatEntries(prev => prev.map((e, i) =>
          i === streamingEntryIndexRef.current
            ? { type: 'error', code }
            : e
        ))
      },
      lang
    )
  }

  // True while any operation that consumes the input is in flight.
  const isInputBusy = streaming || generating || clarifying || generatingTestCases || runningTests

  // Route a free-text message to the right action for the current phase:
  // a clarify answer if we're mid-clarify, otherwise a (new/modify) instruction.
  // Confirm/approve actions are button-only and never queued.
  async function dispatchTextSend(msg: string) {
    const text = msg.trim()
    if (!text) return
    const lastEntry = chatEntries.length > 0 ? chatEntries[chatEntries.length - 1] : null
    if (lastEntry?.type === 'clarify_question') {
      await submitClarifyAnswer(text)
    } else {
      await handleStartClarify(text)
    }
  }

  // Send now if idle, otherwise enqueue for auto-send when the app goes idle.
  function sendOrQueue() {
    const text = instruction.trim()
    if (!text || activeError) return
    setInstruction('')
    if (isInputBusy || task?.status !== 'idle') {
      setPendingMessages(prev => [...prev, text])
    } else {
      void dispatchTextSend(text)
    }
  }

  function removePendingMessage(idx: number) {
    setPendingMessages(prev => prev.filter((_, i) => i !== idx))
  }

  // Auto-flush the queue: when the app becomes idle (and no blocking error),
  // dispatch the oldest queued message. Re-runs as each send completes.
  useEffect(() => {
    if (isInputBusy || task?.status !== 'idle' || activeError) return
    if (pendingMessages.length === 0 || flushingQueueRef.current) return
    flushingQueueRef.current = true
    const [next, ...rest] = pendingMessages
    setPendingMessages(rest)
    Promise.resolve(dispatchTextSend(next)).finally(() => {
      flushingQueueRef.current = false
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isInputBusy, task?.status, activeError, pendingMessages])

  async function handleSkipClarify() {
    const originalInstruction = instruction.trim()
    if (!chatEntries.some(e => e.type === 'user_instruction') && originalInstruction) {
      setChatEntries(prev => [...prev, { type: 'user_instruction', content: originalInstruction }])
    }
    setGenerating(true)
    const phaseStartMs = Date.now()
    setChatEntries(prev => {
      streamingEntryIndexRef.current = prev.length
      return [...prev, { type: 'prompt_generating', startedAt: phaseStartMs }]
    })

    streamKeyRef.current += 1
    const promptKey = `stream-${streamKeyRef.current}`
    setLogEntries(prev => [...prev, { kind: 'stream', text: '', key: promptKey, started: false }])

    // Use the current chatEntries snapshot to find user_instruction
    // We need to read it before state updates; capture via closure
    const currentEntries = chatEntries
    const foundInstruction = currentEntries.find(e => e.type === 'user_instruction') as { content: string } | undefined
    const instructionContent = foundInstruction?.content ?? originalInstruction

    const router = createStreamJsonRouter()
    await generatePromptStream(
      taskId,
      instructionContent,
      instruction,
      (chunk) => {
        // Left pane: raw stream-json. Right pane: reconstructed prompt text.
        const { raw } = router.push(chunk)
        setLogEntries(prev => prev.map(e =>
          e.kind === 'stream' && e.key === promptKey ? { ...e, text: e.text + raw, started: true } : e
        ))
      },
      () => {
        const cleaned = router.text().trim()
        setGenerating(false)
        recordPhaseDuration('generate_prompt', Date.now() - phaseStartMs)
        setInstruction('')
        setChatEntries(prev => prev.map((e, i) =>
          i === streamingEntryIndexRef.current
            ? { type: 'prompt_generated', content: cleaned, confirmed: false }
            : e
        ))
      },
      (code, detail) => {
        setGenerating(false)
        setActiveError(code)
        logErrorDetail(detail)
        setChatEntries(prev => prev.map((e, i) =>
          i === streamingEntryIndexRef.current
            ? { type: 'error', code }
            : e
        ))
      },
      lang
    )
  }


  async function handleRegenerate() {
    if (generating) return
    setGenerating(true)
    setChatEntries(prev => prev.map(e =>
      e.type === 'prompt_generated' && !e.confirmed ? { ...e, confirmed: true } : e
    ))
    const originalInstruction = chatEntries.find(e => e.type === 'user_instruction') as { content: string } | undefined

    const phaseStartMs = Date.now()
    setChatEntries(prev => {
      streamingEntryIndexRef.current = prev.length
      return [...prev, { type: 'prompt_generating', startedAt: phaseStartMs }]
    })

    streamKeyRef.current += 1
    const promptKey = `stream-${streamKeyRef.current}`
    setLogEntries(prev => [...prev, { kind: 'stream', text: '', key: promptKey, started: false }])

    const router = createStreamJsonRouter()
    await generatePromptStream(
      taskId,
      originalInstruction?.content ?? '',
      instruction,
      (chunk) => {
        const { raw } = router.push(chunk)
        setLogEntries(prev => prev.map(e =>
          e.kind === 'stream' && e.key === promptKey ? { ...e, text: e.text + raw, started: true } : e
        ))
      },
      () => {
        const cleaned = router.text().trim()
        setGenerating(false)
        recordPhaseDuration('generate_prompt', Date.now() - phaseStartMs)
        setInstruction('')
        setChatEntries(prev => prev.map((e, i) =>
          i === streamingEntryIndexRef.current
            ? { type: 'prompt_generated', content: cleaned, confirmed: false }
            : e
        ))
      },
      (code, detail) => {
        setGenerating(false)
        setActiveError(code)
        logErrorDetail(detail)
        setChatEntries(prev => prev.map((e, i) =>
          i === streamingEntryIndexRef.current
            ? { type: 'error', code }
            : e
        ))
      },
      lang
    )
  }

  async function handleConfirmAndExecute(prompt: string) {
    setConfirmedPrompt(prompt)
    setInstruction('')
    setChatEntries(prev => prev.map(e =>
      e.type === 'prompt_generated' && !e.confirmed ? { ...e, confirmed: true } : e
    ))

    const phaseStartMs = Date.now()
    setChatEntries(prev => [...prev, { type: 'implementation_running', startedAt: phaseStartMs }])
    setStreaming(true)

    streamKeyRef.current += 1
    const currentKey = `stream-${streamKeyRef.current}`
    setLogEntries(prev => [...prev, { kind: 'stream', text: '', key: currentKey, started: false }])

    await executeInstructionStream(
      taskId,
      prompt,
      (chunk) => {
        setLogEntries(prev => prev.map(entry =>
          entry.kind === 'stream' && entry.key === currentKey
            ? { ...entry, text: entry.text + chunk, started: true }
            : entry
        ))
      },
      async () => {
        setStreaming(false)
        recordPhaseDuration('execute', Date.now() - phaseStartMs)
        setSteps(prev => prev.map(s => s.id === 'implement' ? { ...s, status: 'done_pass' } : s))
        setChatEntries(prev => {
          const idx = [...prev].reverse().findIndex(e => e.type === 'implementation_running')
          if (idx === -1) return prev
          const realIdx = prev.length - 1 - idx
          return prev.map((e, i) => i === realIdx ? { type: 'implementation_done' } : e)
        })

        setSelectedStep('unit_test')
      },
      (code, detail) => {
        setStreaming(false)
        setActiveError(code)
        logErrorDetail(detail)
        setChatEntries(prev => {
          const idx = [...prev].reverse().findIndex(e => e.type === 'implementation_running')
          if (idx === -1) return [...prev, { type: 'error', code }]
          const realIdx = prev.length - 1 - idx
          return prev.map((e, i) => i === realIdx ? { type: 'error', code } : e)
        })
      }
    )
  }

  async function handleApproveTestCases(items: TestCaseItem[]) {
    if (items.length === 0 || runningTests) return
    setRunningTests(true)
    setRunningTestType('unit')
    testCountRef.current = { passed: 0, failed: 0 }
    const plannedTotal = items.length

    setChatEntries(prev => prev.map(e =>
      e.type === 'test_cases_ready' && !e.approved ? { ...e, approved: true } : e
    ))

    setChatEntries(prev => {
      streamingEntryIndexRef.current = prev.length
      return [...prev, { type: 'test_running', label: t.bannerTestGeneratingCode, startedAt: Date.now(), progress: null }]
    })
    genCodeProgressRef.current = { done: 0, total: 0, startMs: Date.now() }

    streamKeyRef.current += 1
    const currentKey = `stream-${streamKeyRef.current}`
    setLogEntries(prev => [...prev, { kind: 'stream', text: '', key: currentKey, started: false }])

    await runUnitTestsStream(
      taskId,
      confirmedPrompt,
      (chunk) => {
        setLogEntries(prev =>
          prev.map(entry =>
            entry.kind === 'stream' && entry.key === currentKey
              ? { ...entry, text: entry.text + chunk, started: true }
              : entry
          )
        )
        let newLabel: string | null = null
        let newProgress: PhaseCount | undefined
        for (const line of chunk.split('\n')) {
          const progressMatch = line.match(/^\[XOLVIEN_PROGRESS\] (\d+)\/(\d+) elapsed_ms=(\d+) eta_ms=(\d+)/)
          if (progressMatch) {
            const done = Number(progressMatch[1])
            const total = Number(progressMatch[2])
            const etaMs = Number(progressMatch[4])
            genCodeProgressRef.current = { done, total, startMs: genCodeProgressRef.current.startMs }
            const etaRawCode = etaMs > 0 ? Math.ceil(etaMs / 1000) : null
            newLabel = t.progressGenCode(done, total, etaRawCode !== null ? fmtHms(etaRawCode) : null)
            newProgress = { done, total }
          }
        }
        if (!newLabel) {
          if (/\[(?:TEST|ITEST|E2E)\] (Running tests:|テストを実行しています|Re-running tests|テストを再実行しています)/.test(chunk)) {
            testCountRef.current = { passed: 0, failed: 0 }
            newLabel = t.progressRunning(0, plannedTotal, 0)
            newProgress = { done: 0, total: plannedTotal }
          } else if (/\[(?:TEST|ITEST|E2E)\] (Auto-fix|自動修正)/.test(chunk)) {
            const m = chunk.match(/(?:Auto-fix|自動修正) \((\d+)\/(\d+)\)/)
            newLabel = m ? t.autoFixing(Number(m[1]), Number(m[2])) : t.autoFix
            newProgress = null
          } else {
            let updated = false
            for (const line of chunk.split('\n')) {
              if (/\bPASSED\b/.test(line) || /^\s*✓/.test(line) || /^\s*✔/.test(line)) {
                testCountRef.current.passed += 1; updated = true
              } else if (/\bFAILED\b/.test(line) || /^\s*✕/.test(line) || /^\s*✗/.test(line) || /^\s*×/.test(line)) {
                testCountRef.current.failed += 1; updated = true
              }
              const dotMatch = line.match(/^[.F]+$/)
              if (dotMatch) {
                testCountRef.current.passed += (line.match(/\./g) ?? []).length
                testCountRef.current.failed += (line.match(/F/g) ?? []).length
                updated = true
              }
            }
            if (updated) {
              const { passed, failed } = testCountRef.current
              newLabel = t.progressRunning(passed + failed, plannedTotal, failed)
              newProgress = { done: passed + failed, total: plannedTotal }
            }
          }
        }
        if (newLabel) {
          setTestPhaseLabel(newLabel)
          setChatEntries(prev => prev.map((e, i) =>
            i === streamingEntryIndexRef.current && e.type === 'test_running'
              ? { ...e, label: newLabel!, progress: newProgress !== undefined ? newProgress : e.progress }
              : e
          ))
        }
      },
      async () => {
        setRunningTests(false)
        setRunningTestType(null)
        setTestPhaseLabel(null)
        try {
          const [runs, freshItems] = await Promise.all([getTestRuns(taskId), getTestCaseItems(taskId, 'unit')])
          setTestCaseItems(freshItems)
          const completedUnitRuns = runs.filter(r => r.test_type === 'unit' && r.completed_at)
          const lastUnit = completedUnitRuns.length > 0 ? completedUnitRuns.reduce((a, b) => (a.id > b.id ? a : b)) : undefined
          if (lastUnit) {
            setTestResultSummary(lastUnit.summary ?? null)
            setTestPassed(lastUnit.passed)
            setSteps(prev => prev.map(s => {
              if (s.id === 'unit_test') return { ...s, status: lastUnit.passed ? 'done_pass' : 'done_fail' }
              if (s.id === 'integration_test' && lastUnit.passed) return { ...s, status: 'active' }
              return s
            }))
            if (lastUnit.passed) setSelectedStep('integration_test')
            setChatEntries(prev => prev.map((e, i) =>
              i === streamingEntryIndexRef.current && e.type === 'test_running'
                ? { type: 'test_done' as const, summary: lastUnit.summary ?? '', passed: lastUnit.passed, items: freshItems }
                : e
            ))
          }
        } catch { /* ignore */ }
      },
      (code, detail) => {
        setRunningTests(false)
        setRunningTestType(null)
        setTestPhaseLabel(null)
        setActiveError(code)
        logErrorDetail(detail)
        setChatEntries(prev => prev.map((e, i) =>
          i === streamingEntryIndexRef.current && e.type === 'test_running'
            ? { type: 'error', code }
            : e
        ))
      },
      lang
    )
  }

  async function handleApproveIntegrationTestCases(items: TestCaseItem[]) {
    if (items.length === 0 || runningTests) return
    setRunningTests(true)
    setRunningTestType('integration')
    testCountRef.current = { passed: 0, failed: 0 }
    const plannedTotal = items.length

    setChatEntries(prev => prev.map(e =>
      e.type === 'integration_test_cases_ready' && !e.approved ? { ...e, approved: true } : e
    ))

    setChatEntries(prev => {
      streamingEntryIndexRef.current = prev.length
      return [...prev, { type: 'test_running', label: `${t.bannerIntegrationTest}${t.bannerTestGeneratingCode}`, startedAt: Date.now(), progress: null }]
    })
    genCodeProgressRef.current = { done: 0, total: 0, startMs: Date.now() }

    streamKeyRef.current += 1
    const currentKey = `stream-${streamKeyRef.current}`
    setLogEntries(prev => [...prev, { kind: 'stream', text: '', key: currentKey, started: false }])

    await runIntegrationTestsStream(
      taskId,
      confirmedPrompt,
      (chunk) => {
        setLogEntries(prev =>
          prev.map(entry =>
            entry.kind === 'stream' && entry.key === currentKey
              ? { ...entry, text: entry.text + chunk, started: true }
              : entry
          )
        )
        let newLabel: string | null = null
        let newProgress: PhaseCount | undefined
        for (const line of chunk.split('\n')) {
          const progressMatch = line.match(/^\[XOLVIEN_PROGRESS\] (\d+)\/(\d+) elapsed_ms=(\d+) eta_ms=(\d+)/)
          if (progressMatch) {
            const done = Number(progressMatch[1])
            const total = Number(progressMatch[2])
            const etaMs = Number(progressMatch[4])
            genCodeProgressRef.current = { done, total, startMs: genCodeProgressRef.current.startMs }
            const etaRawCode = etaMs > 0 ? Math.ceil(etaMs / 1000) : null
            newLabel = t.progressGenCode(done, total, etaRawCode !== null ? fmtHms(etaRawCode) : null)
            newProgress = { done, total }
          }
        }
        if (!newLabel) {
          if (/\[ITEST\] (Running tests:|テストを実行しています|Re-running tests|テストを再実行しています)/.test(chunk)) {
            testCountRef.current = { passed: 0, failed: 0 }
            newLabel = t.progressIntegration(0, plannedTotal, 0)
            newProgress = { done: 0, total: plannedTotal }
          } else if (/\[ITEST\] (Auto-fix|自動修正)/.test(chunk)) {
            const m = chunk.match(/(?:Auto-fix|自動修正) \((\d+)\/(\d+)\)/)
            newLabel = m ? t.autoFixing(Number(m[1]), Number(m[2])) : t.autoFix
            newProgress = null
          } else {
            let updated = false
            for (const line of chunk.split('\n')) {
              if (/\bPASSED\b/.test(line) || /^\s*✓/.test(line) || /^\s*✔/.test(line)) {
                testCountRef.current.passed += 1; updated = true
              } else if (/\bFAILED\b/.test(line) || /^\s*✕/.test(line) || /^\s*✗/.test(line) || /^\s*×/.test(line)) {
                testCountRef.current.failed += 1; updated = true
              }
            }
            if (updated) {
              const { passed, failed } = testCountRef.current
              newLabel = t.progressIntegration(passed + failed, plannedTotal, failed)
              newProgress = { done: passed + failed, total: plannedTotal }
            }
          }
        }
        if (newLabel) {
          setTestPhaseLabel(newLabel)
          setChatEntries(prev => prev.map((e, i) =>
            i === streamingEntryIndexRef.current && e.type === 'test_running'
              ? { ...e, label: newLabel!, progress: newProgress !== undefined ? newProgress : e.progress }
              : e
          ))
        }
      },
      async () => {
        setRunningTests(false)
        setRunningTestType(null)
        setTestPhaseLabel(null)
        try {
          const [runs, freshItems] = await Promise.all([getTestRuns(taskId), getTestCaseItems(taskId, 'integration')])
          setIntegrationTestCaseItems(freshItems)
          const completedIntegrationRuns = runs.filter(r => r.test_type === 'integration' && r.completed_at)
          const lastIntegration = completedIntegrationRuns.length > 0 ? completedIntegrationRuns.reduce((a, b) => (a.id > b.id ? a : b)) : undefined
          if (lastIntegration) {
            setTestResultSummary(lastIntegration.summary ?? null)
            setTestPassed(lastIntegration.passed)
            setSteps(prev => prev.map(s => {
              if (s.id === 'integration_test') return { ...s, status: lastIntegration.passed ? 'done_pass' : 'done_fail' }
              if (s.id === 'e2e_test' && lastIntegration.passed) return { ...s, status: 'active' }
              return s
            }))
            setChatEntries(prev => {
              const mapped = prev.map((e, i) =>
                i === streamingEntryIndexRef.current && e.type === 'test_running'
                  ? { type: 'test_done' as const, summary: lastIntegration.summary ?? '', passed: lastIntegration.passed, items: freshItems }
                  : e
              )
              if (lastIntegration.passed) {
                return [...mapped, { type: 'e2e_test_cases_ready' as const, items: [], approved: false }]
              }
              return mapped
            })
            if (lastIntegration.passed) setSelectedStep('e2e_test')
          }
        } catch { /* ignore */ }
      },
      (code, detail) => {
        setRunningTests(false)
        setRunningTestType(null)
        setTestPhaseLabel(null)
        setActiveError(code)
        logErrorDetail(detail)
        setChatEntries(prev => prev.map((e, i) =>
          i === streamingEntryIndexRef.current && e.type === 'test_running'
            ? { type: 'error', code }
            : e
        ))
      },
      lang
    )
  }

  async function handleGenerateTestCasesManual() {
    if (!confirmedPrompt || task?.status !== 'idle') return
    setGeneratingTestCases(true)
    setTcGenLabel(null)
    setTcGenProgress(null)
    setChatEntries(prev => {
      streamingEntryIndexRef.current = prev.length
      return [...prev, { type: 'test_cases_generating', startedAt: Date.now() }]
    })
    streamKeyRef.current += 1
    const tcStreamKey = `stream-${streamKeyRef.current}`
    setLogEntries(prev => [...prev, { kind: 'stream', text: '', key: tcStreamKey, started: false }])
    await generateTestCasesStream(
      taskId,
      confirmedPrompt,
      (chunk) => {
        setLogEntries(prev => prev.map(entry =>
          entry.kind === 'stream' && entry.key === tcStreamKey
            ? { ...entry, text: entry.text + chunk, started: true }
            : entry
        ))
        for (const line of chunk.split('\n')) {
          const m = line.match(/^\[XOLVIEN_PROGRESS\] (\d+)\/(\d+) elapsed_ms=(\d+) eta_ms=\d+/)
          if (m) {
            const done = Number(m[1]), total = Number(m[2]), elapsedMs = Number(m[3])
            const etaRaw = done > 0 && total > done ? Math.ceil((elapsedMs / done) * (total - done) / 1000) : null
            setTcGenLabel(t.progressGenTC(done, total, etaRaw !== null ? fmtHms(etaRaw) : null))
            setTcGenProgress({ done, total })
          }
        }
      },
      async () => {
        setGeneratingTestCases(false)
        setTcGenLabel(null)
        try {
          const items = await getTestCaseItems(taskId, 'unit')
          setTestCaseItems(items)
          setChatEntries(prev => prev.map((e, i) =>
            i === streamingEntryIndexRef.current
              ? { type: 'test_cases_ready', items, approved: false }
              : e
          ))
        } catch (e) {
          const detail = e instanceof Error ? e.message : String(e)
          const fetchCode = classifyError(0, detail)
          setActiveError(fetchCode)
          logErrorDetail(detail)
          setChatEntries(prev => prev.map((en, i) =>
            i === streamingEntryIndexRef.current
              ? { type: 'error', code: fetchCode }
              : en
          ))
        }
      },
      (code, detail) => {
        setGeneratingTestCases(false)
        setTcGenLabel(null)
        setActiveError(code)
        logErrorDetail(detail)
        setChatEntries(prev => prev.map((e, i) =>
          i === streamingEntryIndexRef.current
            ? { type: 'error', code }
            : e
        ))
      },
      lang
    )
  }

  async function handleGenerateIntegrationTestCasesManual() {
    if (!confirmedPrompt || task?.status !== 'idle') return
    setGeneratingTestCases(true)
    setTcGenLabel(null)
    setTcGenProgress(null)
    setChatEntries(prev => {
      streamingEntryIndexRef.current = prev.length
      return [...prev, { type: 'integration_test_cases_generating', startedAt: Date.now() }]
    })
    streamKeyRef.current += 1
    const tcStreamKey = `stream-${streamKeyRef.current}`
    setLogEntries(prev => [...prev, { kind: 'stream', text: '', key: tcStreamKey, started: false }])
    await generateIntegrationTestCasesStream(
      taskId,
      confirmedPrompt,
      (chunk) => {
        setLogEntries(prev => prev.map(entry =>
          entry.kind === 'stream' && entry.key === tcStreamKey
            ? { ...entry, text: entry.text + chunk, started: true }
            : entry
        ))
        for (const line of chunk.split('\n')) {
          const m = line.match(/^\[XOLVIEN_PROGRESS\] (\d+)\/(\d+) elapsed_ms=(\d+) eta_ms=\d+/)
          if (m) {
            const done = Number(m[1]), total = Number(m[2]), elapsedMs = Number(m[3])
            const etaRaw = done > 0 && total > done ? Math.ceil((elapsedMs / done) * (total - done) / 1000) : null
            setTcGenLabel(t.progressGenTC(done, total, etaRaw !== null ? fmtHms(etaRaw) : null))
            setTcGenProgress({ done, total })
          }
        }
      },
      async () => {
        setGeneratingTestCases(false)
        setTcGenLabel(null)
        try {
          const items = await getTestCaseItems(taskId, 'integration')
          setIntegrationTestCaseItems(items)
          setChatEntries(prev => prev.map((e, i) =>
            i === streamingEntryIndexRef.current
              ? { type: 'integration_test_cases_ready', items, approved: false }
              : e
          ))
        } catch (e) {
          const detail = e instanceof Error ? e.message : String(e)
          const fetchCode = classifyError(0, detail)
          setActiveError(fetchCode)
          logErrorDetail(detail)
          setChatEntries(prev => prev.map((en, i) =>
            i === streamingEntryIndexRef.current
              ? { type: 'error', code: fetchCode }
              : en
          ))
        }
      },
      (code, detail) => {
        setGeneratingTestCases(false)
        setTcGenLabel(null)
        setActiveError(code)
        logErrorDetail(detail)
        setChatEntries(prev => prev.map((e, i) =>
          i === streamingEntryIndexRef.current
            ? { type: 'error', code }
            : e
        ))
      },
      lang
    )
  }

  async function handleApproveE2ETestCases(items: TestCaseItem[]) {
    if (items.length === 0 || runningTests) return
    setRunningTests(true)
    setRunningTestType('e2e')
    testCountRef.current = { passed: 0, failed: 0 }
    const plannedTotal = items.length

    setChatEntries(prev => prev.map(e =>
      e.type === 'e2e_test_cases_ready' && !e.approved ? { ...e, approved: true } : e
    ))

    setChatEntries(prev => {
      streamingEntryIndexRef.current = prev.length
      return [...prev, { type: 'test_running', label: `${t.bannerE2ETest}${t.bannerTestGeneratingCode}`, startedAt: Date.now(), progress: null }]
    })
    genCodeProgressRef.current = { done: 0, total: 0, startMs: Date.now() }

    streamKeyRef.current += 1
    const currentKey = `stream-${streamKeyRef.current}`
    setLogEntries(prev => [...prev, { kind: 'stream', text: '', key: currentKey, started: false }])

    await runE2ETestsStream(
      taskId,
      confirmedPrompt,
      (chunk) => {
        setLogEntries(prev =>
          prev.map(entry =>
            entry.kind === 'stream' && entry.key === currentKey
              ? { ...entry, text: entry.text + chunk, started: true }
              : entry
          )
        )
        let newLabel: string | null = null
        let newProgress: PhaseCount | undefined
        for (const line of chunk.split('\n')) {
          const progressMatch = line.match(/^\[XOLVIEN_PROGRESS\] (\d+)\/(\d+) elapsed_ms=(\d+) eta_ms=(\d+)/)
          if (progressMatch) {
            const done = Number(progressMatch[1])
            const total = Number(progressMatch[2])
            const etaMs = Number(progressMatch[4])
            genCodeProgressRef.current = { done, total, startMs: genCodeProgressRef.current.startMs }
            const etaRawCode = etaMs > 0 ? Math.ceil(etaMs / 1000) : null
            newLabel = t.progressGenCode(done, total, etaRawCode !== null ? fmtHms(etaRawCode) : null)
            newProgress = { done, total }
          }
        }
        if (!newLabel) {
          if (/\[E2E\] (Running tests:|テストを実行しています|Re-running tests|テストを再実行しています)/.test(chunk)) {
            testCountRef.current = { passed: 0, failed: 0 }
            newLabel = t.progressE2E(0, plannedTotal, 0)
            newProgress = { done: 0, total: plannedTotal }
          } else if (/\[E2E\] (Auto-fix|自動修正)/.test(chunk)) {
            const m = chunk.match(/(?:Auto-fix|自動修正) \((\d+)\/(\d+)\)/)
            newLabel = m ? t.autoFixing(Number(m[1]), Number(m[2])) : t.autoFix
            newProgress = null
          } else {
            let updated = false
            for (const line of chunk.split('\n')) {
              if (/\bPASSED\b/.test(line) || /^\s*✓/.test(line) || /^\s*✔/.test(line)) {
                testCountRef.current.passed += 1; updated = true
              } else if (/\bFAILED\b/.test(line) || /^\s*✕/.test(line) || /^\s*✗/.test(line) || /^\s*×/.test(line)) {
                testCountRef.current.failed += 1; updated = true
              }
            }
            if (updated) {
              const { passed, failed } = testCountRef.current
              newLabel = t.progressE2E(passed + failed, plannedTotal, failed)
              newProgress = { done: passed + failed, total: plannedTotal }
            }
          }
        }
        if (newLabel) {
          setTestPhaseLabel(newLabel)
          setChatEntries(prev => prev.map((e, i) =>
            i === streamingEntryIndexRef.current && e.type === 'test_running'
              ? { ...e, label: newLabel!, progress: newProgress !== undefined ? newProgress : e.progress }
              : e
          ))
        }
      },
      async () => {
        setRunningTests(false)
        setRunningTestType(null)
        setTestPhaseLabel(null)
        try {
          const [runs, freshItems] = await Promise.all([getTestRuns(taskId), getTestCaseItems(taskId, 'e2e')])
          setE2ETestCaseItems(freshItems)
          const completedE2ERuns = runs.filter(r => r.test_type === 'e2e' && r.completed_at)
          const lastE2E = completedE2ERuns.length > 0 ? completedE2ERuns.reduce((a, b) => (a.id > b.id ? a : b)) : undefined
          if (lastE2E) {
            setTestResultSummary(lastE2E.summary ?? null)
            setTestPassed(lastE2E.passed)
            setSteps(prev => prev.map(s => {
              if (s.id === 'e2e_test') return { ...s, status: lastE2E.passed ? 'done_pass' : 'done_fail' }
              if (s.id === 'review' && lastE2E.passed) return { ...s, status: 'active' }
              return s
            }))
            setChatEntries(prev => {
              const mapped = prev.map((e, i) =>
                i === streamingEntryIndexRef.current && e.type === 'test_running'
                  ? { type: 'test_done' as const, summary: lastE2E.summary ?? '', passed: lastE2E.passed, items: freshItems }
                  : e
              )
              if (lastE2E.passed) {
                return [...mapped, { type: 'review' as const, prompt: confirmedPrompt, items: freshItems, resolved: false }]
              }
              return mapped
            })
            if (lastE2E.passed) setSelectedStep('review')
          }
        } catch { /* ignore */ }
      },
      (code, detail) => {
        setRunningTests(false)
        setRunningTestType(null)
        setTestPhaseLabel(null)
        setActiveError(code)
        logErrorDetail(detail)
        setChatEntries(prev => prev.map((e, i) =>
          i === streamingEntryIndexRef.current && e.type === 'test_running'
            ? { type: 'error', code }
            : e
        ))
      },
      lang
    )
  }

  async function handleGenerateE2ETestCasesManual() {
    if (!confirmedPrompt || task?.status !== 'idle') return
    setGeneratingTestCases(true)
    setTcGenLabel(null)
    setTcGenProgress(null)
    setChatEntries(prev => {
      streamingEntryIndexRef.current = prev.length
      return [...prev, { type: 'e2e_test_cases_generating', startedAt: Date.now() }]
    })
    streamKeyRef.current += 1
    const tcStreamKey = `stream-${streamKeyRef.current}`
    setLogEntries(prev => [...prev, { kind: 'stream', text: '', key: tcStreamKey, started: false }])
    await generateE2ETestCasesStream(
      taskId,
      confirmedPrompt,
      (chunk) => {
        setLogEntries(prev => prev.map(entry =>
          entry.kind === 'stream' && entry.key === tcStreamKey
            ? { ...entry, text: entry.text + chunk, started: true }
            : entry
        ))
        for (const line of chunk.split('\n')) {
          const m = line.match(/^\[XOLVIEN_PROGRESS\] (\d+)\/(\d+) elapsed_ms=(\d+) eta_ms=\d+/)
          if (m) {
            const done = Number(m[1]), total = Number(m[2]), elapsedMs = Number(m[3])
            const etaRaw = done > 0 && total > done ? Math.ceil((elapsedMs / done) * (total - done) / 1000) : null
            setTcGenLabel(t.progressGenTC(done, total, etaRaw !== null ? fmtHms(etaRaw) : null))
            setTcGenProgress({ done, total })
          }
        }
      },
      async () => {
        setGeneratingTestCases(false)
        setTcGenLabel(null)
        try {
          const items = await getTestCaseItems(taskId, 'e2e')
          setE2ETestCaseItems(items)
          setChatEntries(prev => prev.map((e, i) =>
            i === streamingEntryIndexRef.current
              ? { type: 'e2e_test_cases_ready', items, approved: false }
              : e
          ))
        } catch (e) {
          const detail = e instanceof Error ? e.message : String(e)
          const fetchCode = classifyError(0, detail)
          setActiveError(fetchCode)
          logErrorDetail(detail)
          setChatEntries(prev => prev.map((en, i) =>
            i === streamingEntryIndexRef.current
              ? { type: 'error', code: fetchCode }
              : en
          ))
        }
      },
      (code, detail) => {
        setGeneratingTestCases(false)
        setTcGenLabel(null)
        setActiveError(code)
        logErrorDetail(detail)
        setChatEntries(prev => prev.map((e, i) =>
          i === streamingEntryIndexRef.current
            ? { type: 'error', code }
            : e
        ))
      },
      lang
    )
  }

  function handleApproveImplementation() {
    setChatEntries(prev => prev.map(e =>
      e.type === 'review' && !e.resolved ? { ...e, resolved: true } : e
    ))
    setChatEntries(prev => [...prev, { type: 'info', message: t.approvedMsg }])
    setConfirmedPrompt('')
    setTestCaseItems([])
  }

  function handleRejectImplementation() {
    setChatEntries(prev => prev.map(e =>
      e.type === 'review' && !e.resolved ? { ...e, resolved: true } : e
    ))
    setChatEntries(prev => [...prev, { type: 'info', message: t.rejectedMsg }])
    setInstruction(confirmedPrompt)
    setConfirmedPrompt('')
  }

  async function handleRevisionRequest(revisionFeedback: string) {
    setInstruction('')
    setGeneratingTestCases(true)
    setTcGenLabel(null)
    setChatEntries(prev => prev.map(e =>
      e.type === 'test_cases_ready' && !e.approved ? { ...e, approved: true } : e
    ))
    setChatEntries(prev => {
      streamingEntryIndexRef.current = prev.length
      return [...prev, { type: 'test_cases_generating', startedAt: Date.now() }]
    })
    streamKeyRef.current += 1
    const tcStreamKey = `stream-${streamKeyRef.current}`
    setLogEntries(prev => [...prev, { kind: 'stream', text: '', key: tcStreamKey, started: false }])
    await generateTestCasesStream(
      taskId,
      revisionFeedback.trim()
        ? confirmedPrompt + '\n\n## 前回のテストケースへの指摘\n' + revisionFeedback
        : confirmedPrompt,
      (chunk) => {
        setLogEntries(prev => prev.map(entry =>
          entry.kind === 'stream' && entry.key === tcStreamKey
            ? { ...entry, text: entry.text + chunk, started: true }
            : entry
        ))
        for (const line of chunk.split('\n')) {
          const m = line.match(/^\[XOLVIEN_PROGRESS\] (\d+)\/(\d+) elapsed_ms=(\d+) eta_ms=\d+/)
          if (m) {
            const done = Number(m[1]), total = Number(m[2]), elapsedMs = Number(m[3])
            const etaRaw = done > 0 && total > done ? Math.ceil((elapsedMs / done) * (total - done) / 1000) : null
            setTcGenLabel(t.progressGenTC(done, total, etaRaw !== null ? fmtHms(etaRaw) : null))
            setTcGenProgress({ done, total })
          }
        }
      },
      async () => {
        setGeneratingTestCases(false)
        setTcGenLabel(null)
        try {
          const items = await getTestCaseItems(taskId, 'unit')
          setTestCaseItems(items)
          setChatEntries(prev => prev.map((e, i) =>
            i === streamingEntryIndexRef.current
              ? { type: 'test_cases_ready', items, approved: false }
              : e
          ))
        } catch (e) {
          const detail = e instanceof Error ? e.message : String(e)
          const fetchCode = classifyError(0, detail)
          setActiveError(fetchCode)
          logErrorDetail(detail)
          setChatEntries(prev => prev.map((en, i) =>
            i === streamingEntryIndexRef.current
              ? { type: 'error', code: fetchCode }
              : en
          ))
        }
      },
      (code, detail) => {
        setGeneratingTestCases(false)
        setTcGenLabel(null)
        setActiveError(code)
        logErrorDetail(detail)
        setChatEntries(prev => prev.map((e, i) =>
          i === streamingEntryIndexRef.current
            ? { type: 'error', code }
            : e
        ))
      },
      lang
    )
  }

  function handleStepClick(stepId: StepId) {
    if (streaming || runningTests || generatingTestCases || generating || clarifying) return
    setSelectedStep(stepId)
  }

  async function handleGitPush() {
    if (pushing || streaming) return
    setPushing(true)

    streamKeyRef.current += 1
    const currentKey = `stream-${streamKeyRef.current}`
    setLogEntries(prev => [...prev, { kind: 'stream', text: '', key: currentKey, started: false }])

    await gitPushStream(
      taskId,
      (chunk) => {
        setLogEntries(prev =>
          prev.map(entry =>
            entry.kind === 'stream' && entry.key === currentKey
              ? { ...entry, text: entry.text + chunk, started: true }
              : entry
          )
        )
      },
      () => { setPushing(false) },
      (code, detail) => {
        raiseError(code, detail)
        setPushing(false)
      }
    )
  }

  async function handleStop() {
    if (!task || stopping) return
    setStopping(true)
    try {
      const updated = await stopTask(task.id)
      setTask(updated)
      // Stopping is a recovery action — clear any active error banner.
      setActiveError(null)
    } catch (err) {
      alert(err instanceof Error ? err.message : t.stopFailed)
    } finally {
      setStopping(false)
    }
  }

  // ─── Render helpers ───────────────────────────────────────────────────────

  function renderChatEntry(entry: ChatEntry, idx: number) {
    switch (entry.type) {
      case 'user_instruction':
        return (
          <div key={idx} style={{
            background: '#1e3a5f', border: '1px solid #2563eb', borderRadius: '6px',
            padding: '8px 12px', fontSize: '0.82rem', color: '#bfdbfe',
            whiteSpace: 'pre-wrap', lineHeight: 1.6,
          }}>
            <span style={{ fontSize: '0.72rem', color: '#60a5fa', marginBottom: '4px', display: 'block', fontWeight: 600 }}>{t.yourInstruction}</span>
            {entry.content}
          </div>
        )

      case 'clarify_question': {
        const { question, options } = parseClarifyQuestion(entry.content)
        const isLatest = idx === chatEntries.length - 1
        return (
          <div key={idx} style={{
            background: '#0f172a', border: '1px solid #334155', borderRadius: '6px',
            padding: '8px 12px', fontSize: '0.82rem', color: '#e2e8f0',
            lineHeight: 1.6,
          }}>
            <span style={{ fontSize: '0.72rem', color: '#6366f1', marginBottom: '4px', display: 'block', fontWeight: 600 }}>{t.claudeLabel}</span>
            <span style={{ whiteSpace: 'pre-wrap' }}>{question}</span>
            {options.length > 0 && isLatest && !clarifying && (
              <div style={{ marginTop: '10px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {options.map((opt, oi) => (
                  <button
                    key={oi}
                    onClick={() => { setInstruction(''); submitClarifyAnswer(opt) }}
                    style={{
                      background: '#1e293b', border: '1px solid #4f46e5', borderRadius: '4px',
                      color: '#a5b4fc', padding: '6px 12px', fontSize: '0.80rem',
                      cursor: 'pointer', textAlign: 'left',
                    }}
                  >
                    {opt}
                  </button>
                ))}
              </div>
            )}
          </div>
        )
      }

      case 'clarify_answer':
        return (
          <div key={idx} style={{
            background: '#1e3a5f', border: '1px solid #2563eb', borderRadius: '6px',
            padding: '8px 12px', fontSize: '0.82rem', color: '#bfdbfe',
            whiteSpace: 'pre-wrap', lineHeight: 1.6, marginLeft: '20px',
          }}>
            <span style={{ fontSize: '0.72rem', color: '#60a5fa', marginBottom: '4px', display: 'block', fontWeight: 600 }}>{t.youLabel}</span>
            {entry.content}
          </div>
        )

      case 'clarify_streaming': {
        return (
          <div key={idx} style={{
            background: '#0f172a', border: '1px solid #334155', borderRadius: '6px',
            padding: '8px 12px', fontSize: '0.82rem', color: '#94a3b8',
            whiteSpace: 'pre-wrap', lineHeight: 1.6,
          }}>
            <span style={{ fontSize: '0.72rem', color: '#6366f1', marginBottom: '4px', display: 'block', fontWeight: 600 }}>{t.claudeLabel}</span>
            <PhaseProgress label={t.thinking} startedAt={entry.startedAt} flow="clarify" />
          </div>
        )
      }

      case 'prompt_generating':
        return (
          <div key={idx} style={{
            background: '#0f172a', border: '1px solid #334155', borderRadius: '6px',
            padding: '10px 12px', fontSize: '0.82rem', color: '#94a3b8',
            display: 'flex', alignItems: 'center', gap: '8px',
          }}>
            <PhaseProgress label={t.generatingPrompt} startedAt={entry.startedAt} flow="generate_prompt" />
          </div>
        )

      case 'prompt_generated':
        return (
          <div key={idx} style={{
            background: '#0f172a',
            border: `1px solid ${entry.confirmed ? '#334155' : '#6366f1'}`,
            borderRadius: '6px', padding: '12px', fontSize: '0.82rem',
          }}>
            <div style={{ color: '#6366f1', fontSize: '0.72rem', marginBottom: '6px', fontWeight: 600 }}>
              {t.promptGenerated} {entry.confirmed ? t.promptConfirmed : t.promptPending}
            </div>
            <div style={{
              fontFamily: 'monospace', color: '#e2e8f0', whiteSpace: 'pre-wrap', lineHeight: 1.5,
            }}>
              {entry.content}
            </div>
          </div>
        )

      case 'implementation_running':
        return (
          <div key={idx} style={{
            background: '#0f172a', border: '1px solid #334155', borderRadius: '6px',
            padding: '10px 12px', fontSize: '0.82rem', color: '#93c5fd',
            display: 'flex', alignItems: 'center', gap: '8px',
          }}>
            <PhaseProgress label={t.implementationRunning} startedAt={entry.startedAt} flow="execute" color="#93c5fd" />
          </div>
        )

      case 'implementation_done':
        return (
          <div key={idx} style={{
            background: '#052e16', border: '1px solid #16a34a', borderRadius: '6px',
            padding: '10px 12px', fontSize: '0.82rem', color: '#86efac',
            display: 'flex', alignItems: 'center', gap: '8px',
          }}>
            {t.implementationDone}
          </div>
        )

      case 'test_cases_generating':
        return (
          <div key={idx} style={{
            background: '#0f172a', border: '1px solid #334155', borderRadius: '6px',
            padding: '10px 12px', fontSize: '0.82rem', color: '#94a3b8',
            display: 'flex', alignItems: 'center', gap: '8px',
          }}>
            <PhaseProgress label={tcGenLabel ?? t.generatingTestCasesMsg} startedAt={entry.startedAt} progress={tcGenProgress} />
          </div>
        )

      case 'test_cases_ready':
        return (
          <div key={idx} style={{
            background: '#0f172a',
            border: `1px solid ${entry.approved ? '#334155' : '#6366f1'}`,
            borderRadius: '6px', padding: '12px', fontSize: '0.82rem',
          }}>
            <div style={{ color: '#6366f1', fontSize: '0.72rem', marginBottom: '8px', fontWeight: 600 }}>
              {t.testCasesLabel} {entry.approved ? t.testCasesApproved : t.testCasesPendingApproval(entry.items.length)}
            </div>
            {entry.items.length === 0 ? (
              <div style={{ color: '#475569', fontSize: '0.82rem' }}>
                {t.testCasesNone}
                {confirmedPrompt && task?.status !== 'idle' && (
                  <span style={{ display: 'block', fontSize: '0.78rem', color: '#ef4444', marginTop: '4px' }}>
                    {t.containerNotRunning}{task?.status}{t.containerNotRunningClose}
                  </span>
                )}
              </div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: '0.75rem' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid #334155', background: '#0a0f1e' }}>
                      <th style={{ padding: '4px 6px', textAlign: 'left', color: '#6366f1', fontWeight: 600, whiteSpace: 'nowrap' }}>{t.colId}</th>
                      <th style={{ padding: '4px 6px', textAlign: 'left', color: '#6366f1', fontWeight: 600, whiteSpace: 'nowrap' }}>{t.colTargetScreen}</th>
                      <th style={{ padding: '4px 6px', textAlign: 'left', color: '#6366f1', fontWeight: 600 }}>{t.colTestItem}</th>
                      <th style={{ padding: '4px 6px', textAlign: 'left', color: '#6366f1', fontWeight: 600 }}>{t.colExpectedOutput}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entry.items.map((tc) => (
                      <tr key={tc.id} style={{ borderBottom: '1px solid #1e293b' }}>
                        <td style={{ padding: '3px 6px', color: '#94a3b8', fontFamily: 'monospace', whiteSpace: 'nowrap' }}>{tc.tc_id}</td>
                        <td style={{ padding: '3px 6px', color: '#94a3b8', whiteSpace: 'nowrap' }}>{tc.target_screen ?? '—'}</td>
                        <td style={{ padding: '3px 6px', color: '#cbd5e1' }}>{tc.test_item}</td>
                        <td style={{ padding: '3px 6px', color: '#94a3b8', fontSize: '0.72rem' }}>{tc.expected_output ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )

      case 'integration_test_cases_generating':
        return (
          <div key={idx} style={{
            background: '#0f172a', border: '1px solid #334155', borderRadius: '6px',
            padding: '10px 12px', fontSize: '0.82rem', color: '#94a3b8',
            display: 'flex', alignItems: 'center', gap: '8px',
          }}>
            <PhaseProgress label={tcGenLabel ?? t.generatingIntegrationTC} startedAt={entry.startedAt} progress={tcGenProgress} />
          </div>
        )

      case 'integration_test_cases_ready':
        return (
          <div key={idx} style={{
            background: '#0f172a',
            border: `1px solid ${entry.approved ? '#334155' : '#a855f7'}`,
            borderRadius: '6px', padding: '12px', fontSize: '0.82rem',
          }}>
            <div style={{ color: '#a855f7', fontSize: '0.72rem', marginBottom: '8px', fontWeight: 600 }}>
              {t.integrationTCLabel} {entry.approved ? t.testCasesApproved : t.testCasesPendingApproval(entry.items.length)}
            </div>
            {entry.items.length === 0 ? (
              <div style={{ color: '#475569', fontSize: '0.82rem' }}>
                {t.integrationTCNone}
                {confirmedPrompt && task?.status !== 'idle' && (
                  <span style={{ display: 'block', fontSize: '0.78rem', color: '#ef4444', marginTop: '4px' }}>
                    {t.containerNotRunning}{task?.status}{t.containerNotRunningClose}
                  </span>
                )}
              </div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: '0.75rem' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid #334155', background: '#0a0f1e' }}>
                      <th style={{ padding: '4px 6px', textAlign: 'left', color: '#a855f7', fontWeight: 600, whiteSpace: 'nowrap' }}>{t.colId}</th>
                      <th style={{ padding: '4px 6px', textAlign: 'left', color: '#a855f7', fontWeight: 600, whiteSpace: 'nowrap' }}>{t.colTarget}</th>
                      <th style={{ padding: '4px 6px', textAlign: 'left', color: '#a855f7', fontWeight: 600 }}>{t.colTestItem}</th>
                      <th style={{ padding: '4px 6px', textAlign: 'left', color: '#a855f7', fontWeight: 600 }}>{t.colExpectedOutput}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entry.items.map((tc) => (
                      <tr key={tc.id} style={{ borderBottom: '1px solid #1e293b' }}>
                        <td style={{ padding: '3px 6px', color: '#94a3b8', fontFamily: 'monospace', whiteSpace: 'nowrap' }}>{tc.tc_id}</td>
                        <td style={{ padding: '3px 6px', color: '#94a3b8', whiteSpace: 'nowrap' }}>{tc.target_screen ?? '—'}</td>
                        <td style={{ padding: '3px 6px', color: '#cbd5e1' }}>{tc.test_item}</td>
                        <td style={{ padding: '3px 6px', color: '#94a3b8', fontSize: '0.72rem' }}>{tc.expected_output ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )

      case 'e2e_test_cases_generating':
        return (
          <div key={idx} style={{
            background: '#0f172a', border: '1px solid #334155', borderRadius: '6px',
            padding: '10px 12px', fontSize: '0.82rem', color: '#94a3b8',
            display: 'flex', alignItems: 'center', gap: '8px',
          }}>
            <PhaseProgress label={tcGenLabel ?? t.generatingE2ETC} startedAt={entry.startedAt} progress={tcGenProgress} />
          </div>
        )

      case 'e2e_test_cases_ready':
        return (
          <div key={idx} style={{
            background: '#0f172a',
            border: `1px solid ${entry.approved ? '#334155' : '#06b6d4'}`,
            borderRadius: '6px', padding: '12px', fontSize: '0.82rem',
          }}>
            <div style={{ color: '#06b6d4', fontSize: '0.72rem', marginBottom: '8px', fontWeight: 600 }}>
              {t.e2eTCLabel} {entry.approved ? t.testCasesApproved : t.testCasesPendingApproval(entry.items.length)}
            </div>
            {entry.items.length === 0 ? (
              <div style={{ color: '#475569', fontSize: '0.82rem' }}>
                {t.e2eTCNone}
                {confirmedPrompt && task?.status !== 'idle' && (
                  <span style={{ display: 'block', fontSize: '0.78rem', color: '#ef4444', marginTop: '4px' }}>
                    {t.containerNotRunning}{task?.status}{t.containerNotRunningClose}
                  </span>
                )}
              </div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: '0.75rem' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid #334155', background: '#0a0f1e' }}>
                      <th style={{ padding: '4px 6px', textAlign: 'left', color: '#06b6d4', fontWeight: 600, whiteSpace: 'nowrap' }}>{t.colId}</th>
                      <th style={{ padding: '4px 6px', textAlign: 'left', color: '#06b6d4', fontWeight: 600, whiteSpace: 'nowrap' }}>{t.colTargetScreen}</th>
                      <th style={{ padding: '4px 6px', textAlign: 'left', color: '#06b6d4', fontWeight: 600 }}>{t.colTestItem}</th>
                      <th style={{ padding: '4px 6px', textAlign: 'left', color: '#06b6d4', fontWeight: 600 }}>{t.colExpectedOutput}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entry.items.map((tc) => (
                      <tr key={tc.id} style={{ borderBottom: '1px solid #1e293b' }}>
                        <td style={{ padding: '3px 6px', color: '#94a3b8', fontFamily: 'monospace', whiteSpace: 'nowrap' }}>{tc.tc_id}</td>
                        <td style={{ padding: '3px 6px', color: '#94a3b8', whiteSpace: 'nowrap' }}>{tc.target_screen ?? '—'}</td>
                        <td style={{ padding: '3px 6px', color: '#cbd5e1' }}>{tc.test_item}</td>
                        <td style={{ padding: '3px 6px', color: '#94a3b8', fontSize: '0.72rem' }}>{tc.expected_output ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )

      case 'test_running':
        return (
          <div key={idx} style={{
            background: '#0f172a', border: '1px solid #334155', borderRadius: '6px',
            padding: '10px 12px', fontSize: '0.82rem', color: '#93c5fd',
            display: 'flex', alignItems: 'center', gap: '8px',
          }}>
            <PhaseProgress label={entry.label} startedAt={entry.startedAt} progress={entry.progress} color="#93c5fd" />
          </div>
        )

      case 'test_done': {
        const resultColor = entry.passed ? '#86efac' : '#fca5a5'
        const resultBg = entry.passed ? '#052e16' : '#450a0a'
        const resultBorder = entry.passed ? '#16a34a' : '#dc2626'
        return (
          <div key={idx} style={{
            background: resultBg, border: `1px solid ${resultBorder}`,
            borderRadius: '6px', padding: '10px 12px', fontSize: '0.82rem',
          }}>
            <div style={{ color: resultColor, fontWeight: 600, marginBottom: entry.items.length > 0 ? '8px' : 0 }}>
              {entry.passed ? '✅' : '❌'} {entry.summary || (entry.passed ? t.testPassed : t.testFailed)}
            </div>
            {entry.items.length > 0 && (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: '0.72rem' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
                      <th style={{ padding: '3px 6px', textAlign: 'left', color: '#94a3b8', fontWeight: 500, whiteSpace: 'nowrap' }}>{t.colId}</th>
                      <th style={{ padding: '3px 6px', textAlign: 'left', color: '#94a3b8', fontWeight: 500 }}>{t.colTestItem}</th>
                      <th style={{ padding: '3px 6px', textAlign: 'left', color: '#94a3b8', fontWeight: 500 }}>{t.colExpectedOutput}</th>
                      <th style={{ padding: '3px 6px', textAlign: 'left', color: '#94a3b8', fontWeight: 500 }}>{t.colActualOutput}</th>
                      <th style={{ padding: '3px 6px', textAlign: 'center', color: '#94a3b8', fontWeight: 500, whiteSpace: 'nowrap' }}>{t.colVerdict}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entry.items.map((tc) => {
                      const r = tc.latest_result
                      const verdictIcon: Record<string, string> = { PASSED: '✅', FAILED: '❌', ERROR: '⚠️', SKIPPED: '⏭️' }
                      const icon = r?.verdict ? (verdictIcon[r.verdict] ?? r.verdict) : '—'
                      return (
                        <tr key={tc.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                          <td style={{ padding: '3px 6px', color: '#94a3b8', fontFamily: 'monospace', whiteSpace: 'nowrap' }}>{tc.tc_id}</td>
                          <td style={{ padding: '3px 6px', color: '#cbd5e1' }}>{tc.test_item}</td>
                          <td style={{ padding: '3px 6px', color: '#94a3b8' }}>{tc.expected_output ?? '—'}</td>
                          <td style={{ padding: '3px 6px', color: '#94a3b8' }}>{r?.actual_output ?? '—'}</td>
                          <td style={{ padding: '3px 6px', textAlign: 'center', whiteSpace: 'nowrap' }}>{icon} {r?.verdict ?? t.notExecuted}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )
      }

      case 'review':
        return (
          <div key={idx} style={{
            background: '#0f172a',
            border: `1px solid ${entry.resolved ? '#334155' : '#facc15'}`,
            borderRadius: '6px', padding: '12px', fontSize: '0.82rem',
          }}>
            <div style={{ color: entry.resolved ? '#64748b' : '#facc15', fontSize: '0.72rem', marginBottom: '8px', fontWeight: 600 }}>
              {t.reviewLabel} {entry.resolved ? t.reviewResolved : t.reviewPending}
            </div>
            <div style={{
              background: '#1e293b', borderRadius: '4px', padding: '8px',
              fontSize: '0.78rem', color: '#94a3b8', whiteSpace: 'pre-wrap',
            }}>
              <span style={{ color: '#475569', fontSize: '0.7rem', display: 'block', marginBottom: '4px' }}>{t.executedPrompt}</span>
              {entry.prompt}
            </div>
          </div>
        )

      case 'error': {
        const copy = errorCatalog[entry.code]
        return (
          <div key={idx} style={{
            background: '#450a0a', border: '1px solid #dc2626', borderRadius: '6px',
            padding: '8px 12px', fontSize: '0.82rem', color: '#fca5a5',
          }}>
            ❌ {copy.title}
          </div>
        )
      }

      case 'info':
        return (
          <div key={idx} style={{
            background: '#1e293b', border: '1px solid #334155', borderRadius: '6px',
            padding: '8px 12px', fontSize: '0.82rem', color: '#94a3b8', fontStyle: 'italic',
          }}>
            {entry.message}
          </div>
        )

      default:
        return null
    }
  }

  function renderActionButtons() {
    // An unresolved error disables every action button until the user dismisses it.
    const isBusy = streaming || generating || clarifying || generatingTestCases || runningTests || !!activeError

    // Determine current context from chatEntries
    const lastUnconfirmedPrompt = chatEntries.reduce<(ChatEntry & { type: 'prompt_generated' }) | null>(
      (last, e) => e.type === 'prompt_generated' && !e.confirmed ? e as ChatEntry & { type: 'prompt_generated' } : last, null)
    const lastUnapprovedTestCases = chatEntries.reduce<(ChatEntry & { type: 'test_cases_ready' }) | null>(
      (last, e) => e.type === 'test_cases_ready' && !e.approved ? e as ChatEntry & { type: 'test_cases_ready' } : last, null)
    const lastUnresolvedReview = chatEntries.reduce<(ChatEntry & { type: 'review' }) | null>(
      (last, e) => e.type === 'review' && !e.resolved ? e as ChatEntry & { type: 'review' } : last, null)

    // Derive effective phase from selectedStep + chatEntries state
    const effectiveStep = selectedStep

    // --- confirming phase: unconfirmed prompt exists ---
    if (lastUnconfirmedPrompt && effectiveStep !== 'unit_test' && effectiveStep !== 'review') {
      return (
        <div className="instruction-footer" style={{ margin: 0 }}>
          <button className="btn-primary" onClick={() => handleConfirmAndExecute(lastUnconfirmedPrompt.content)} disabled={isBusy}>
            {t.confirmAndRun}
          </button>
          <button className="btn-secondary" onClick={handleRegenerate} disabled={isBusy}>
            {generating ? t.regenerating : t.regenerate}
          </button>
        </div>
      )
    }

    // --- unit_test step selected ---
    if (effectiveStep === 'unit_test') {
      if (lastUnapprovedTestCases) {
        const items = lastUnapprovedTestCases.items
        if (items.length === 0) {
          // No test cases yet — offer generate button
          return (
            <div className="instruction-footer" style={{ margin: 0 }}>
              {confirmedPrompt && task?.status === 'idle' ? (
                <button className="btn-primary" onClick={handleGenerateTestCasesManual} disabled={isBusy}>
                  {t.generateTestCases}
                </button>
              ) : (
                <span style={{ fontSize: '0.82rem', color: '#475569' }}>
                  {task?.status !== 'idle' ? `${t.containerNotRunningBtn}${task?.status}${t.statusSuffix}` : t.testCaseFetchError}
                </span>
              )}
            </div>
          )
        }
        // Test cases exist — show approve / revision buttons
        return (
          <div className="instruction-footer" style={{ margin: 0 }}>
            <button className="btn-primary" onClick={() => handleApproveTestCases(items)} disabled={isBusy}>
              {runningTests ? t.runningTestsBtn : t.approveAndRunTests}
            </button>
            <button className="btn-secondary" onClick={() => handleRevisionRequest(instruction)} disabled={isBusy}>
              {t.requestRevision}
            </button>
          </div>
        )
      }
      // unit_test selected but all approved / no pending — offer re-run or initial generate
      const latestTestCases = chatEntries.reduce<(ChatEntry & { type: 'test_cases_ready' }) | null>(
        (last, e) => e.type === 'test_cases_ready' ? e as ChatEntry & { type: 'test_cases_ready' } : last, null)
      if (latestTestCases && latestTestCases.items.length > 0) {
        return (
          <div className="instruction-footer" style={{ margin: 0 }}>
            <button className="btn-primary" onClick={() => handleApproveTestCases(latestTestCases.items)} disabled={isBusy}>
              {runningTests ? t.runningTestsBtn : t.rerunTests}
            </button>
            {confirmedPrompt && task?.status === 'idle' && (
              <button className="btn-secondary" onClick={handleGenerateTestCasesManual} disabled={isBusy}>
                {generatingTestCases ? t.generatingTestCasesBtn : t.regenerateTestCases}
              </button>
            )}
          </div>
        )
      }
      // No test cases at all — offer initial generate
      return (
        <div className="instruction-footer" style={{ margin: 0 }}>
          {confirmedPrompt && task?.status === 'idle' ? (
            <button className="btn-primary" onClick={handleGenerateTestCasesManual} disabled={isBusy}>
              {generatingTestCases ? t.generatingTestCasesBtn : t.generateTestCases}
            </button>
          ) : (
            <span style={{ fontSize: '0.82rem', color: '#475569' }}>
              {task?.status !== 'idle' ? `${t.containerNotRunningBtn}${task?.status}${t.statusSuffix}` : t.noUnitTestDone}
            </span>
          )}
        </div>
      )
    }

    // --- integration_test step selected ---
    if (effectiveStep === 'integration_test') {
      const lastUnapprovedIntegrationTC = chatEntries.reduce<(ChatEntry & { type: 'integration_test_cases_ready' }) | null>(
        (last, e) => e.type === 'integration_test_cases_ready' && !e.approved
          ? e as ChatEntry & { type: 'integration_test_cases_ready' }
          : last,
        null
      )

      if (lastUnapprovedIntegrationTC) {
        const itcItems = lastUnapprovedIntegrationTC.items
        if (itcItems.length === 0) {
          return (
            <div className="instruction-footer" style={{ margin: 0 }}>
              {confirmedPrompt && task?.status === 'idle' ? (
                <button className="btn-primary" onClick={handleGenerateIntegrationTestCasesManual} disabled={isBusy}>
                  {generatingTestCases ? t.generatingIntegrationTCBtn : t.generateIntegrationTC}
                </button>
              ) : (
                <span style={{ fontSize: '0.82rem', color: '#475569' }}>
                  {task?.status !== 'idle' ? `${t.containerNotRunningBtn}${task?.status}${t.statusSuffix}` : t.containerNotRunningIntegration}
                </span>
              )}
            </div>
          )
        }
        return (
          <div className="instruction-footer" style={{ margin: 0 }}>
            <button className="btn-primary" onClick={() => handleApproveIntegrationTestCases(itcItems)} disabled={isBusy}>
              {runningTests ? t.runningIntegration : t.approveAndRunIntegration}
            </button>
            <button className="btn-secondary" onClick={handleGenerateIntegrationTestCasesManual} disabled={isBusy}>
              {t.requestRevision}
            </button>
          </div>
        )
      }

      // All approved or initial load
      const latestIntegrationTC = chatEntries.reduce<(ChatEntry & { type: 'integration_test_cases_ready' }) | null>(
        (last, e) => e.type === 'integration_test_cases_ready'
          ? e as ChatEntry & { type: 'integration_test_cases_ready' }
          : last,
        null
      )
      if (latestIntegrationTC && latestIntegrationTC.items.length > 0) {
        return (
          <div className="instruction-footer" style={{ margin: 0 }}>
            <button className="btn-primary" onClick={() => handleApproveIntegrationTestCases(latestIntegrationTC.items)} disabled={isBusy}>
              {runningTests ? t.runningIntegration : t.rerunIntegration}
            </button>
            {confirmedPrompt && task?.status === 'idle' && (
              <button className="btn-secondary" onClick={handleGenerateIntegrationTestCasesManual} disabled={isBusy}>
                {generatingTestCases ? t.generatingIntegrationTCBtn : t.regenerateIntegrationTC}
              </button>
            )}
          </div>
        )
      }

      // No integration test cases yet
      return (
        <div className="instruction-footer" style={{ margin: 0 }}>
          {confirmedPrompt && task?.status === 'idle' ? (
            <button className="btn-primary" onClick={handleGenerateIntegrationTestCasesManual} disabled={isBusy}>
              {generatingTestCases ? t.generatingIntegrationTCBtn : t.generateIntegrationTC}
            </button>
          ) : (
            <span style={{ fontSize: '0.82rem', color: '#475569' }}>
              {task?.status !== 'idle' ? `${t.containerNotRunningBtn}${task?.status}${t.statusSuffix}` : t.noUnitTestDone}
            </span>
          )}
        </div>
      )
    }

    // --- e2e_test step selected ---
    if (effectiveStep === 'e2e_test') {
      const lastUnapprovedE2ETC = chatEntries.reduce<(ChatEntry & { type: 'e2e_test_cases_ready' }) | null>(
        (last, e) => e.type === 'e2e_test_cases_ready' && !e.approved
          ? e as ChatEntry & { type: 'e2e_test_cases_ready' }
          : last,
        null
      )

      if (lastUnapprovedE2ETC) {
        const e2eItems = lastUnapprovedE2ETC.items
        if (e2eItems.length === 0) {
          return (
            <div className="instruction-footer" style={{ margin: 0 }}>
              {confirmedPrompt && task?.status === 'idle' ? (
                <button className="btn-primary" onClick={handleGenerateE2ETestCasesManual} disabled={isBusy}>
                  {generatingTestCases ? t.generatingE2ETCBtn : t.generateE2ETC}
                </button>
              ) : (
                <span style={{ fontSize: '0.82rem', color: '#475569' }}>
                  {task?.status !== 'idle' ? `${t.containerNotRunningBtn}${task?.status}${t.statusSuffix}` : t.containerNotRunningE2E}
                </span>
              )}
            </div>
          )
        }
        return (
          <div className="instruction-footer" style={{ margin: 0 }}>
            <button className="btn-primary" onClick={() => handleApproveE2ETestCases(e2eItems)} disabled={isBusy}>
              {runningTests ? t.runningE2E : t.approveAndRunE2E}
            </button>
            <button className="btn-secondary" onClick={handleGenerateE2ETestCasesManual} disabled={isBusy}>
              {t.requestRevision}
            </button>
          </div>
        )
      }

      // All approved or initial load
      const latestE2ETC = chatEntries.reduce<(ChatEntry & { type: 'e2e_test_cases_ready' }) | null>(
        (last, e) => e.type === 'e2e_test_cases_ready'
          ? e as ChatEntry & { type: 'e2e_test_cases_ready' }
          : last,
        null
      )
      if (latestE2ETC && latestE2ETC.items.length > 0) {
        return (
          <div className="instruction-footer" style={{ margin: 0 }}>
            <button className="btn-primary" onClick={() => handleApproveE2ETestCases(latestE2ETC.items)} disabled={isBusy}>
              {runningTests ? t.runningE2E : t.rerunE2E}
            </button>
            {confirmedPrompt && task?.status === 'idle' && (
              <button className="btn-secondary" onClick={handleGenerateE2ETestCasesManual} disabled={isBusy}>
                {generatingTestCases ? t.generatingE2ETCBtn : t.regenerateE2ETC}
              </button>
            )}
          </div>
        )
      }

      // No E2E test cases yet
      return (
        <div className="instruction-footer" style={{ margin: 0 }}>
          {confirmedPrompt && task?.status === 'idle' ? (
            <button className="btn-primary" onClick={handleGenerateE2ETestCasesManual} disabled={isBusy}>
              {generatingTestCases ? t.generatingE2ETCBtn : t.generateE2ETC}
            </button>
          ) : (
            <span style={{ fontSize: '0.82rem', color: '#475569' }}>
              {task?.status !== 'idle' ? `${t.containerNotRunningBtn}${task?.status}${t.statusSuffix}` : t.noIntegrationDone}
            </span>
          )}
        </div>
      )
    }

    // --- review step selected ---
    if (effectiveStep === 'review') {
      if (lastUnresolvedReview) {
        return (
          <div className="instruction-footer" style={{ margin: 0 }}>
            <button className="btn-primary" onClick={handleApproveImplementation} disabled={isBusy}>
              {t.approve}
            </button>
            <button className="btn-danger" onClick={handleRejectImplementation} disabled={isBusy}>
              {t.reject}
            </button>
          </div>
        )
      }
      return null
    }

    return null
  }

  function insertMarkdown(before: string, after = '') {
    const el = textareaRef.current
    if (!el) return
    const start = el.selectionStart
    const end = el.selectionEnd
    const selected = instruction.slice(start, end)
    const newText = instruction.slice(0, start) + before + selected + after + instruction.slice(end)
    setInstruction(newText)
    requestAnimationFrame(() => {
      el.focus()
      const cursor = start + before.length + selected.length + after.length
      el.setSelectionRange(cursor, cursor)
    })
  }

  function renderMarkdownPreview(text: string): string {
    return text
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/^#{3} (.+)$/gm, '<h3 style="margin:8px 0 4px;font-size:0.9rem;color:#e2e8f0">$1</h3>')
      .replace(/^#{2} (.+)$/gm, '<h2 style="margin:10px 0 4px;font-size:1rem;color:#e2e8f0">$1</h2>')
      .replace(/^# (.+)$/gm, '<h1 style="margin:10px 0 4px;font-size:1.1rem;color:#e2e8f0">$1</h1>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/`([^`]+)`/g, '<code style="background:#1e293b;padding:1px 4px;border-radius:3px;font-family:monospace;font-size:0.85em;color:#93c5fd">$1</code>')
      .replace(/^```[\s\S]*?```$/gm, (m) => {
        const inner = m.replace(/^```[^\n]*\n/, '').replace(/```$/, '')
        return `<pre style="background:#1e293b;padding:8px;border-radius:4px;overflow-x:auto;margin:6px 0"><code style="font-family:monospace;font-size:0.82rem;color:#93c5fd">${inner}</code></pre>`
      })
      .replace(/^- (.+)$/gm, '<li style="margin:2px 0;padding-left:4px">$1</li>')
      .replace(/(<li[^>]*>.*<\/li>\n?)+/g, (m) => `<ul style="margin:4px 0;padding-left:20px">${m}</ul>`)
      .replace(/\n\n/g, '</p><p style="margin:6px 0">')
      .replace(/^(?!<[huplo]|<pre)(.+)$/gm, '<p style="margin:4px 0">$1</p>')
  }

  function renderInputArea() {
    // An unresolved error blocks sending until the user dismisses it.
    const isBusy = streaming || generating || clarifying || generatingTestCases || runningTests || !!activeError

    // Determine phase from chatEntries
    const lastEntry = chatEntries.length > 0 ? chatEntries[chatEntries.length - 1] : null
    const isInitialPhase = chatEntries.length === 0 ||
      chatEntries.every(e => e.type === 'user_instruction') ||
      selectedStep === 'implement'
    const isClarifyMode = lastEntry?.type === 'clarify_question'
    const lastUnconfirmedPrompt = chatEntries.reduce<(ChatEntry & { type: 'prompt_generated' }) | null>(
      (last, e) => e.type === 'prompt_generated' && !e.confirmed ? e as ChatEntry & { type: 'prompt_generated' } : last, null)
    const isPromptPhase = !!lastUnconfirmedPrompt &&
      selectedStep !== 'unit_test' && selectedStep !== 'review'
    const isTestOrReviewStep = selectedStep === 'unit_test' || selectedStep === 'integration_test' ||
      selectedStep === 'e2e_test' || selectedStep === 'review'

    // Input is always available while the container is up; sending while busy
    // enqueues the message (auto-sent when idle). It is only blocked by an
    // unresolved error or a non-running container.
    const canSend = !activeError && instruction.trim().length > 0 &&
      task?.status !== 'pending' && task?.status !== 'initializing'

    // Placeholder changes by phase
    let placeholder = t.inputPlaceholder
    if (isInitialPhase) placeholder = t.inputPlaceholder
    else if (isClarifyMode) placeholder = t.inputPlaceholderClarify
    else if (isPromptPhase) placeholder = t.feedbackPlaceholder
    else if (isTestOrReviewStep) placeholder = t.inputPlaceholder

    // Textarea stays enabled even while busy so the user can prepare the next
    // message; only a missing/initializing container disables it.
    const textareaDisabled = task?.status === 'pending' || task?.status === 'initializing'
    const isDisabledNoInput = false

    // Buttons for each phase (isClarifyMode / isPromptPhase take priority over isInitialPhase)
    let buttons: React.ReactNode = null
    if (isClarifyMode) {
      buttons = (
        <>
          <button className="btn-primary" onClick={sendOrQueue} disabled={!canSend}>
            {isInputBusy ? t.queueAndSend : t.sendAnswer}
          </button>
          <button className="btn-secondary" onClick={handleSkipClarify} disabled={isBusy}>
            {t.skipAndGenerate}
          </button>
        </>
      )
    } else if (isPromptPhase) {
      buttons = (
        <>
          <button className="btn-primary" onClick={() => handleConfirmAndExecute(lastUnconfirmedPrompt!.content)} disabled={isBusy}>
            {t.confirmAndRun}
          </button>
          <button className="btn-secondary" onClick={handleRegenerate} disabled={isBusy}>
            {generating ? t.regenerating : t.regenerate}
          </button>
        </>
      )
    } else if (isInitialPhase) {
      buttons = confirmedPrompt ? (
        <>
          <button className="btn-primary" onClick={sendOrQueue} disabled={!canSend}>
            {isInputBusy ? t.queueAndSend : t.modify}
          </button>
          <button className="btn-danger" onClick={handleResetAndRebuild} disabled={isBusy || task?.status !== 'idle'}>
            {t.resetAndRebuild}
          </button>
        </>
      ) : (
        <button className="btn-primary" onClick={sendOrQueue} disabled={!canSend}>
          {isInputBusy ? t.queueAndSend : t.sendInstruction}
        </button>
      )
    } else {
      // Test/review steps: keep the step-specific action buttons, but also allow
      // sending a free-text instruction (queued while busy) when the user types.
      buttons = (
        <>
          {instruction.trim().length > 0 && (
            <button className="btn-primary" onClick={sendOrQueue} disabled={!canSend}>
              {isInputBusy ? t.queueAndSend : t.sendInstruction}
            </button>
          )}
          {renderActionButtons()}
        </>
      )
    }

    const displayValue = isDisabledNoInput ? '' : instruction

    return (
      <div style={{
        borderTop: '2px solid #1e293b',
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        background: '#0d1117',
      }}>
        {/* Queued messages — typed while busy, auto-sent when idle (FIFO) */}
        {pendingMessages.length > 0 && (
          <div style={{
            display: 'flex', flexDirection: 'column', gap: '4px',
            padding: '8px 12px', borderBottom: '1px solid #21262d', background: '#10182b',
          }}>
            <span style={{ fontSize: '0.72rem', color: '#8b949e', fontWeight: 600 }}>
              {t.queuedLabel(pendingMessages.length)}
            </span>
            {pendingMessages.map((m, i) => (
              <div key={i} style={{
                display: 'flex', alignItems: 'center', gap: '8px',
                fontSize: '0.8rem', color: '#c9d1d9', background: '#0d1117',
                border: '1px solid #21262d', borderRadius: '4px', padding: '4px 8px',
              }}>
                <span style={{ color: '#6e7681', flexShrink: 0 }}>{i + 1}.</span>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m}</span>
                <button
                  onClick={() => removePendingMessage(i)}
                  title={t.queuedRemove}
                  style={{
                    flexShrink: 0, background: 'none', border: 'none', color: '#8b949e',
                    cursor: 'pointer', fontSize: '0.95rem', lineHeight: 1, padding: '0 2px',
                  }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Tab bar + toolbar */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          borderBottom: '1px solid #21262d',
          padding: '0 8px',
          gap: 0,
        }}>
          {/* Write / Preview tabs */}
          <button
            onClick={() => !isDisabledNoInput && setInputTab('write')}
            style={{
              background: 'none',
              border: 'none',
              borderBottom: inputTab === 'write' ? '2px solid #f78166' : '2px solid transparent',
              color: inputTab === 'write' ? '#e6edf3' : '#8b949e',
              padding: '8px 12px',
              fontSize: '0.8rem',
              fontWeight: inputTab === 'write' ? 600 : 400,
              cursor: isDisabledNoInput ? 'default' : 'pointer',
              marginBottom: '-1px',
            }}
          >
            Write
          </button>
          <button
            onClick={() => !isDisabledNoInput && instruction.trim() && setInputTab('preview')}
            style={{
              background: 'none',
              border: 'none',
              borderBottom: inputTab === 'preview' ? '2px solid #f78166' : '2px solid transparent',
              color: inputTab === 'preview' ? '#e6edf3' : '#8b949e',
              padding: '8px 12px',
              fontSize: '0.8rem',
              fontWeight: inputTab === 'preview' ? 600 : 400,
              cursor: isDisabledNoInput || !instruction.trim() ? 'default' : 'pointer',
              marginBottom: '-1px',
              opacity: isDisabledNoInput || !instruction.trim() ? 0.4 : 1,
            }}
          >
            Preview
          </button>

          {/* Markdown toolbar — only in write mode */}
          {inputTab === 'write' && !isDisabledNoInput && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '2px', marginLeft: '8px' }}>
              {[
                { label: 'B', title: 'Bold', action: () => insertMarkdown('**', '**') },
                { label: 'I', title: 'Italic', action: () => insertMarkdown('*', '*') },
                { label: '<>', title: 'Inline code', action: () => insertMarkdown('`', '`') },
                { label: '```', title: 'Code block', action: () => insertMarkdown('```\n', '\n```') },
                { label: '—', title: 'Divider', action: () => insertMarkdown('\n---\n') },
                { label: '•', title: 'List item', action: () => insertMarkdown('- ') },
              ].map(btn => (
                <button
                  key={btn.label}
                  title={btn.title}
                  onClick={btn.action}
                  disabled={textareaDisabled}
                  style={{
                    background: 'none',
                    border: '1px solid transparent',
                    borderRadius: '4px',
                    color: '#8b949e',
                    padding: '2px 6px',
                    fontSize: btn.label === '```' ? '0.65rem' : '0.78rem',
                    fontWeight: btn.label === 'B' ? 700 : btn.label === 'I' ? 400 : 500,
                    fontStyle: btn.label === 'I' ? 'italic' : 'normal',
                    fontFamily: ['<>', '```'].includes(btn.label) ? 'monospace' : 'inherit',
                    cursor: 'pointer',
                    lineHeight: 1,
                  }}
                  onMouseEnter={e => { if (!textareaDisabled) (e.currentTarget as HTMLButtonElement).style.background = '#21262d' }}
                  onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'none' }}
                >
                  {btn.label}
                </button>
              ))}
              <span style={{ width: '1px', height: '14px', background: '#30363d', margin: '0 4px' }} />
              <AttachFilesButton state={repoUploads} disabled={textareaDisabled} />
            </div>
          )}

          {/* Status message floated right */}
          {task?.status !== 'idle' && statusMessage && (
            <span style={{ marginLeft: 'auto', fontSize: '0.75rem', color: '#6e7681', fontStyle: 'italic', paddingRight: '8px' }}>
              {statusMessage}
            </span>
          )}
        </div>

        {/* Attached files — shown just above the input, like a comment box's
            attachment list. Files persist with the repository (see
            RepositoryUploads) and are reused by every task of the project. */}
        <AttachedFilesChips state={repoUploads} compact />

        {/* Write/Preview area */}
        {inputTab === 'write' ? (
          <textarea
            ref={textareaRef}
            className="instruction-textarea"
            value={displayValue}
            onChange={e => {
              setInstruction(e.target.value)
              // auto-switch back to write if user types
              if (inputTab !== 'write') setInputTab('write')
            }}
            onKeyDown={e => {
              if (e.key === 'Tab' && !e.shiftKey) {
                e.preventDefault()
                const el = e.currentTarget
                const start = el.selectionStart
                const end = el.selectionEnd
                const newVal = instruction.slice(0, start) + '  ' + instruction.slice(end)
                setInstruction(newVal)
                requestAnimationFrame(() => el.setSelectionRange(start + 2, start + 2))
              }
            }}
            placeholder={placeholder}
            disabled={textareaDisabled}
            style={{
              minHeight: '200px',
              maxHeight: '400px',
              marginBottom: 0,
              resize: 'vertical',
              opacity: isDisabledNoInput ? 0.35 : 1,
              border: 'none',
              borderRadius: 0,
              background: '#0d1117',
              color: '#e6edf3',
              outline: 'none',
              boxShadow: 'none',
              padding: '10px 14px',
              fontSize: '0.875rem',
              lineHeight: 1.6,
              fontFamily: 'ui-monospace, SFMono-Regular, monospace',
            }}
          />
        ) : (
          <div
            style={{
              minHeight: '200px',
              maxHeight: '400px',
              overflowY: 'auto',
              padding: '10px 14px',
              fontSize: '0.875rem',
              lineHeight: 1.6,
              color: '#e6edf3',
              background: '#0d1117',
            }}
            // eslint-disable-next-line react/no-danger
            dangerouslySetInnerHTML={{ __html: instruction.trim() ? renderMarkdownPreview(instruction) : `<span style="color:#6e7681">${placeholder}</span>` }}
          />
        )}

        {/* Footer with action buttons */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '8px 10px',
          borderTop: '1px solid #21262d',
          background: '#0d1117',
        }}>
          {buttons}
        </div>
      </div>
    )
  }

  const showStopButton =
    task && (task.status === 'running' || task.status === 'idle' || task.status === 'testing')

  const statusMessage = task ? getIdleStatusMessage(task.status) : null

  if (taskError && !task) {
    return (
      <>
        <header className="app-header">
          <h1>{t.appName}</h1>
        </header>
        <div className="page-content">
          <Link to="/" className="back-link">
            {t.back}
          </Link>
          <div className="error-banner">{taskError}</div>
        </div>
      </>
    )
  }

  if (!task) {
    return (
      <>
        <header className="app-header">
          <h1>{t.appName}</h1>
        </header>
        <div className="loading-state">{t.loading}</div>
      </>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      {/* Top bar */}
      <header className="app-header">
        <h1>{t.appName}</h1>
      </header>

      <div className="task-detail-container">
        <div className="task-detail-topbar">
          <Link
            to="/"
            className="back-link"
            style={{ margin: 0, flexShrink: 0 }}
            onClick={() => navigate('/')}
          >
            {t.back}
          </Link>

          <span className="task-detail-topbar-title">{task.title}</span>

          <div className="task-detail-topbar-meta">
            <span className={getStatusClass(task.status)}>
              {getStatusLabel(task.status)}
            </span>

            {task.container_name && (
              <span className="container-name" title="Container">
                {task.container_name}
              </span>
            )}

            <span
              style={{
                fontFamily: 'monospace',
                fontSize: '0.8rem',
                color: '#94a3b8',
              }}
            >
              {task.branch_name}
            </span>
          </div>

          <button
            className="btn-secondary btn-sm"
            onClick={() => setLang(lang === 'ja' ? 'en' : 'ja')}
            style={{ marginRight: '8px', fontFamily: 'monospace', fontWeight: 600, minWidth: '36px', flexShrink: 0 }}
          >
            {lang === 'ja' ? t.langEn : t.langJa}
          </button>

          <button
            className="btn-secondary btn-sm"
            onClick={handleGitPush}
            disabled={pushing || streaming || task.status !== 'idle' || !!activeError}
            style={{ flexShrink: 0 }}
          >
            {pushing ? t.pushing : t.gitPush}
          </button>

          {showStopButton && (
            <button
              className="btn-warning btn-sm"
              onClick={handleStop}
              disabled={stopping}
              style={{ flexShrink: 0 }}
            >
              {stopping ? t.stopping : t.stop}
            </button>
          )}
        </div>

        <div className="task-detail-body" ref={bodyRef}>
          {/* Left: Log Viewer */}
          <div style={{ display: 'flex', flexDirection: 'column', flex: `0 0 ${logWidthPercent}%`, minWidth: 0, overflow: 'hidden', paddingLeft: '24px' }}>
            <div className="log-viewer" ref={logViewerRef} style={{ flex: 1 }}>
              {logEntries.length === 0 ? (
                <p className="log-empty">{t.noLogs}</p>
              ) : (
                logEntries.map((entry, idx) => {
                  if (entry.kind === 'log') {
                    const log = entry.data
                    return (
                      <p key={`log-${log.id}-${idx}`} className={getLogLineClass(log.level)}>
                        <span style={{ color: '#4b5563', marginRight: '8px' }}>
                          {formatLogTimestamp(log.created_at)}
                        </span>
                        <span
                          style={{
                            color: '#6366f1',
                            marginRight: '8px',
                            fontSize: '0.75rem',
                          }}
                        >
                          [{log.source}]
                        </span>
                        {log.message}
                      </p>
                    )
                  } else {
                    // Left pane = raw stream-json (console.log-equivalent). Show
                    // every line verbatim; only drop the internal keepalive lines
                    // we inject to keep the stream alive (not Claude's output).
                    const lines = entry.text
                      ? entry.text.split('\n').filter(l => l.trim() && !l.includes('"_xolvien_keepalive"'))
                      : []
                    return (
                      <div key={entry.key}>
                        <p className="log-stream-chunk" style={{ color: '#6b7280', fontStyle: 'italic', margin: '1px 0' }}>{t.cliStarting}</p>
                        {lines.map((line, lineIdx) => (
                          <p key={lineIdx} className="log-stream-chunk" style={{ margin: '1px 0' }}>{line}</p>
                        ))}
                      </div>
                    )
                  }
                })
              )}
            </div>
          </div>

          {/* Vertical resize handle */}
          <div className="resize-handle-vertical" onMouseDown={handleResizeStart} />

          {/* Right: Instruction Chat Panel */}
          <div className="instruction-panel" style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', padding: 0 }}>

            {/* Step progress bar */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 0,
              padding: '10px 16px',
              borderBottom: '1px solid #e2e8f0',
              flexShrink: 0,
              flexWrap: 'wrap',
              rowGap: '4px',
              background: '#0a0f1e',
            }}>
              {steps.map((step, idx) => {
                const isClickable = !step.future
                  && !streaming && !runningTests && !generatingTestCases && !generating && !clarifying
                  && (step.status !== 'pending' || step.id === 'implement')

                const isSelected = selectedStep === step.id

                const bgColor = isSelected
                  ? '#facc15'
                  : step.future
                  ? 'transparent'
                  : step.status === 'done_pass' ? '#16a34a'
                  : step.status === 'done_fail' ? '#dc2626'
                  : step.status === 'active'    ? '#2563eb'
                  : '#334155'

                const textColor = isSelected ? '#1e1e1e' : step.future ? '#475569' : '#fff'

                const icon = step.future ? '○'
                  : step.status === 'done_pass' ? '✅'
                  : step.status === 'done_fail' ? '❌'
                  : step.status === 'active'    ? '▶'
                  : '○'

                return (
                  <div key={step.id} style={{ display: 'flex', alignItems: 'center' }}>
                    {idx > 0 && (
                      <span style={{ color: '#475569', fontSize: '0.75rem', padding: '0 4px' }}>→</span>
                    )}
                    <button
                      onClick={() => isClickable && handleStepClick(step.id)}
                      style={{
                        background: bgColor,
                        color: textColor,
                        border: step.future ? '1px dashed #475569' : 'none',
                        borderRadius: '4px',
                        padding: '3px 8px',
                        fontSize: '0.75rem',
                        fontWeight: step.status === 'active' || isSelected ? 700 : 400,
                        cursor: isClickable ? 'pointer' : 'default',
                        opacity: step.future ? 0.5 : 1,
                        display: 'flex',
                        alignItems: 'center',
                        gap: '4px',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      <span>{icon}</span>
                      <span>{getStepLabel(step.id)}</span>
                    </button>
                  </div>
                )
              })}
            </div>

            {/* Active error banner — prominent, fixed above the chat viewport.
                Appears immediately when an error occurs and blocks all actions
                until dismissed. Shows friendly copy (title + cause + recovery
                actions) looked up by error code; the raw technical detail is in
                the left log pane only, never here. */}
            {activeError && (() => {
              const copy = errorCatalog[activeError]
              return (
                <div
                  role="alert"
                  style={{
                    flexShrink: 0,
                    background: '#dc2626',
                    borderTop: '3px solid #fca5a5',
                    borderBottom: '3px solid #fca5a5',
                    color: '#fff',
                    padding: '14px 16px',
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: '12px',
                  }}
                >
                  <span style={{ fontSize: '1.4rem', lineHeight: 1, flexShrink: 0 }}>⛔</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '0.95rem', fontWeight: 700, marginBottom: '4px' }}>
                      {copy.title}
                    </div>
                    <div style={{ fontSize: '0.84rem', marginBottom: copy.actions.length ? '8px' : 0, opacity: 0.95 }}>
                      {copy.cause}
                    </div>
                    {copy.actions.length > 0 && (
                      <>
                        <div style={{ fontSize: '0.8rem', fontWeight: 600, marginBottom: '2px' }}>
                          {t.errorBannerActionsLabel}
                        </div>
                        <ul style={{ margin: 0, paddingLeft: '18px', fontSize: '0.83rem', lineHeight: 1.5 }}>
                          {copy.actions.map((a, i) => <li key={i}>{a}</li>)}
                        </ul>
                      </>
                    )}
                  </div>
                  <button
                    onClick={() => setActiveError(null)}
                    style={{
                      flexShrink: 0,
                      background: '#fff',
                      color: '#dc2626',
                      border: 'none',
                      borderRadius: '4px',
                      padding: '4px 12px',
                      fontSize: '0.82rem',
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    {t.errorBannerDismiss}
                  </button>
                </div>
              )
            })()}

            {/* Chat history viewport */}
            <div style={{
              flex: 1,
              overflowY: 'auto',
              display: 'flex',
              flexDirection: 'column',
              gap: '10px',
              padding: '8px 12px',
              minHeight: 0,
              background: '#0d1424',
            }}>
              {chatEntries.length === 0 && (
                <div style={{ color: '#475569', fontSize: '0.82rem', margin: 'auto', textAlign: 'center' }}>
                  <p>{t.emptyState}</p>
                </div>
              )}
              {chatEntries.map((entry, idx) => renderChatEntry(entry, idx))}
              <div ref={chatEndRef} />
            </div>

            {/* Fixed input area */}
            {renderInputArea()}
          </div>
        </div>
      </div>
    </div>
  )
}
