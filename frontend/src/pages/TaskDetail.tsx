import { useEffect, useRef, useState, useCallback } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import type { Task, TaskLog, TaskStatus, LogLevel } from '../types'
import { getTask, getLogs, stopTask, executeInstructionStream, generatePromptStream, clarifyStream, gitPushStream, generateTestCasesStream, generateIntegrationTestCasesStream, runUnitTestsStream, runIntegrationTestsStream, getTestRuns, getLastCompletedInstruction, getTestCaseItems } from '../services/api'
import type { TestCaseItem } from '../types'

type ChatEntry =
  | { type: 'user_instruction'; content: string }
  | { type: 'clarify_question'; content: string }
  | { type: 'clarify_answer'; content: string }
  | { type: 'clarify_streaming'; content: string }
  | { type: 'prompt_generating' }
  | { type: 'prompt_generated'; content: string; confirmed: boolean }
  | { type: 'implementation_running' }
  | { type: 'implementation_done' }
  | { type: 'test_cases_generating' }
  | { type: 'test_cases_ready'; items: TestCaseItem[]; approved: boolean }
  | { type: 'integration_test_cases_generating' }
  | { type: 'integration_test_cases_ready'; items: TestCaseItem[]; approved: boolean }
  | { type: 'test_running'; label: string }
  | { type: 'test_done'; summary: string; passed: boolean; items: TestCaseItem[] }
  | { type: 'review'; prompt: string; items: TestCaseItem[]; resolved: boolean }
  | { type: 'error'; message: string }
  | { type: 'info'; message: string }

type StepId = 'implement' | 'unit_test' | 'integration_test' | 'e2e_test' | 'review'
type StepStatus = 'done_pass' | 'done_fail' | 'active' | 'pending'

interface StepInfo {
  id: StepId
  label: string
  status: StepStatus
  resultLabel?: string
  future?: boolean
}


function getStatusLabel(status: TaskStatus): string {
  return status
}

function getStatusClass(status: TaskStatus): string {
  switch (status) {
    case 'pending':
    case 'initializing':
    case 'stopped':
      return 'status-badge status-pending'
    case 'idle':
      return 'status-badge status-idle'
    case 'running':
    case 'testing':
      return 'status-badge status-running'
    case 'completed':
      return 'status-badge status-completed'
    case 'failed':
      return 'status-badge status-failed'
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

function getIdleStatusMessage(status: TaskStatus): string | null {
  switch (status) {
    case 'pending':
    case 'initializing':
      return 'タスクの準備中...'
    case 'running':
      return '実行中です。完了をお待ちください...'
    case 'testing':
      return 'テスト中です...'
    case 'completed':
      return 'タスクは完了しました。'
    case 'failed':
      return 'タスクが失敗しました。'
    case 'stopped':
      return 'タスクは停止されました。'
    default:
      return null
  }
}

// A log entry can be either a structured TaskLog or a stream chunk
type LogEntry =
  | { kind: 'log'; data: TaskLog }
  | { kind: 'stream'; text: string; key: string }


export default function TaskDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const taskId = Number(id)

  const [task, setTask] = useState<Task | null>(null)
  const [taskError, setTaskError] = useState<string | null>(null)
  const [logEntries, setLogEntries] = useState<LogEntry[]>([])
  const [instruction, setInstruction] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [pushing, setPushing] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [generating, setGenerating] = useState(false)
  const [clarifying, setClarifying] = useState(false)

  // Test case / test run state
  const [generatingTestCases, setGeneratingTestCases] = useState(false)
  const [runningTests, setRunningTests] = useState(false)
  const [runningTestType, setRunningTestType] = useState<'unit' | 'integration' | 'e2e' | null>(null)
  const [testPhaseLabel, setTestPhaseLabel] = useState<string | null>(null)
  const testCountRef = useRef({ passed: 0, failed: 0 })
  const setTestResultSummary = (_v: string | null) => { /* stored in chatEntries */ }
  const setTestPassed = (_v: boolean | null) => { /* stored in chatEntries */ }
  const [, setTestCaseItems] = useState<TestCaseItem[]>([])
  const [, setIntegrationTestCaseItems] = useState<TestCaseItem[]>([])
  const [showRevisionInput, setShowRevisionInput] = useState(false)
  const [revisionText, setRevisionText] = useState('')
  const [confirmedPrompt, setConfirmedPrompt] = useState('')

  // Chat history (append-only)
  const [chatEntries, setChatEntries] = useState<ChatEntry[]>([])
  const streamingEntryIndexRef = useRef<number>(-1)
  const chatEndRef = useRef<HTMLDivElement>(null)

  // Resume / step navigation state
  const [resumeChecked, setResumeChecked] = useState(false)
  const [selectedStep, setSelectedStep] = useState<StepId | null>(null)
  const [steps, setSteps] = useState<StepInfo[]>([
    { id: 'implement',         label: '実装',       status: 'pending' },
    { id: 'unit_test',         label: '単体テスト', status: 'pending' },
    { id: 'integration_test',  label: '結合テスト',   status: 'pending' },
    { id: 'e2e_test',          label: 'E2Eテスト',   status: 'pending', future: true },
    { id: 'review',            label: '実装確認',     status: 'pending' },
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
        const [runs, lastInstruction, unitItems, integrationItems] = await Promise.all([
          getTestRuns(taskId),
          getLastCompletedInstruction(taskId),
          getTestCaseItems(taskId, 'unit'),
          getTestCaseItems(taskId, 'integration'),
        ])

        const hasImpl = !!lastInstruction
        const lastUnit = runs.find(r => r.test_type === 'unit' && r.completed_at)
        const lastIntegration = runs.find(r => r.test_type === 'integration' && r.completed_at)

        if (!hasImpl && !lastUnit && !lastIntegration) return

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
                initialEntries.push({ type: 'review', prompt, items: unitItems, resolved: false })
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
                ? { ...step, status: 'done_pass', resultLabel: lastUnit.summary ?? undefined }
                : { ...step, status: 'done_fail', resultLabel: lastUnit.summary ?? undefined }
            case 'integration_test':
              if (!lastUnit?.passed) return step
              if (!lastIntegration) return { ...step, status: 'active' }
              return lastIntegration.passed
                ? { ...step, status: 'done_pass', resultLabel: lastIntegration.summary ?? undefined }
                : { ...step, status: 'done_fail', resultLabel: lastIntegration.summary ?? undefined }
            case 'review':
              return lastIntegration?.passed ? { ...step, status: 'active' } : step
            default:
              return step
          }
        }))

        if (lastIntegration?.passed) setSelectedStep('review')
        else if (lastIntegration) setSelectedStep('integration_test')
        else if (lastUnit?.passed) setSelectedStep('integration_test')
        else if (lastUnit) setSelectedStep('unit_test')
        else if (hasImpl) setSelectedStep('unit_test')

      } catch {
        // Ignore errors — start fresh
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
        err instanceof Error ? err.message : 'タスクの取得に失敗しました'
      )
    }
  }, [taskId])

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
        const entries: LogEntry[] = logs.map(log => {
          seenLogIdsRef.current.add(log.id)
          return { kind: 'log', data: log }
        })
        setLogEntries(entries)
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

  async function handleStartClarify() {
    if (!instruction.trim() || clarifying || generating) return
    const userMsg = instruction.trim()

    setChatEntries(prev => [...prev, { type: 'user_instruction', content: userMsg }])
    setClarifying(true)

    let streamedText = ''
    setChatEntries(prev => {
      streamingEntryIndexRef.current = prev.length
      return [...prev, { type: 'clarify_streaming', content: '' }]
    })

    await clarifyStream(
      taskId,
      userMsg,
      [],
      (chunk) => {
        streamedText += chunk
        setChatEntries(prev => prev.map((e, i) =>
          i === streamingEntryIndexRef.current && e.type === 'clarify_streaming'
            ? { ...e, content: streamedText }
            : e
        ))
      },
      () => {
        setClarifying(false)
        if (streamedText.startsWith('PROMPT_READY')) {
          const prompt = streamedText.replace(/^PROMPT_READY\n?/, '')
          setChatEntries(prev => prev.map((e, i) =>
            i === streamingEntryIndexRef.current
              ? { type: 'prompt_generated', content: prompt, confirmed: false }
              : e
          ))
        } else {
          setChatEntries(prev => prev.map((e, i) =>
            i === streamingEntryIndexRef.current
              ? { type: 'clarify_question', content: streamedText }
              : e
          ))
        }
      },
      (err) => {
        setClarifying(false)
        setChatEntries(prev => prev.map((e, i) =>
          i === streamingEntryIndexRef.current
            ? { type: 'error', message: `要件確認エラー: ${err}` }
            : e
        ))
      }
    )
  }

  async function handleSendClarifyAnswer() {
    if (!instruction.trim() || clarifying) return
    const userMsg = instruction.trim()
    setInstruction('')

    // Build history from chatEntries
    const history = chatEntries
      .filter(e => e.type === 'clarify_question' || e.type === 'clarify_answer')
      .map(e => ({
        role: (e.type === 'clarify_question' ? 'assistant' : 'user') as 'assistant' | 'user',
        content: (e as { content: string }).content,
      }))
    const newHistory = [...history, { role: 'user' as const, content: userMsg }]

    setChatEntries(prev => {
      const withAnswer = [...prev, { type: 'clarify_answer' as const, content: userMsg }]
      streamingEntryIndexRef.current = withAnswer.length
      return [...withAnswer, { type: 'clarify_streaming' as const, content: '' }]
    })
    setClarifying(true)

    let streamedText = ''
    await clarifyStream(
      taskId,
      (chatEntries.find(e => e.type === 'user_instruction') as { content: string } | undefined)?.content ?? '',
      newHistory,
      (chunk) => {
        streamedText += chunk
        setChatEntries(prev => prev.map((e, i) =>
          i === streamingEntryIndexRef.current && e.type === 'clarify_streaming'
            ? { ...e, content: streamedText }
            : e
        ))
      },
      () => {
        setClarifying(false)
        if (streamedText.startsWith('PROMPT_READY')) {
          const prompt = streamedText.replace(/^PROMPT_READY\n?/, '')
          setChatEntries(prev => prev.map((e, i) =>
            i === streamingEntryIndexRef.current
              ? { type: 'prompt_generated', content: prompt, confirmed: false }
              : e
          ))
        } else {
          setChatEntries(prev => prev.map((e, i) =>
            i === streamingEntryIndexRef.current
              ? { type: 'clarify_question', content: streamedText }
              : e
          ))
        }
      },
      (err) => {
        setClarifying(false)
        setChatEntries(prev => prev.map((e, i) =>
          i === streamingEntryIndexRef.current
            ? { type: 'error', message: `要件確認エラー: ${err}` }
            : e
        ))
      }
    )
  }

  async function handleSkipClarify() {
    const originalInstruction = instruction.trim()
    if (!chatEntries.some(e => e.type === 'user_instruction') && originalInstruction) {
      setChatEntries(prev => [...prev, { type: 'user_instruction', content: originalInstruction }])
    }
    setGenerating(true)
    setChatEntries(prev => {
      streamingEntryIndexRef.current = prev.length
      return [...prev, { type: 'prompt_generating' }]
    })

    // Use the current chatEntries snapshot to find user_instruction
    // We need to read it before state updates; capture via closure
    const currentEntries = chatEntries
    const foundInstruction = currentEntries.find(e => e.type === 'user_instruction') as { content: string } | undefined
    const instructionContent = foundInstruction?.content ?? originalInstruction

    let promptText = ''
    await generatePromptStream(
      taskId,
      instructionContent,
      feedback,
      (chunk) => { promptText += chunk },
      () => {
        setGenerating(false)
        setFeedback('')
        setChatEntries(prev => prev.map((e, i) =>
          i === streamingEntryIndexRef.current
            ? { type: 'prompt_generated', content: promptText, confirmed: false }
            : e
        ))
      },
      (err) => {
        setGenerating(false)
        setChatEntries(prev => prev.map((e, i) =>
          i === streamingEntryIndexRef.current
            ? { type: 'error', message: `プロンプト生成エラー: ${err}` }
            : e
        ))
      }
    )
  }

  async function handleGeneratePrompt() {
    if (!instruction.trim() || generating) return
    const userMsg = instruction.trim()
    setChatEntries(prev => [...prev, { type: 'user_instruction', content: userMsg }])
    setGenerating(true)
    setChatEntries(prev => {
      streamingEntryIndexRef.current = prev.length
      return [...prev, { type: 'prompt_generating' }]
    })

    let promptText = ''
    await generatePromptStream(
      taskId,
      userMsg,
      feedback,
      (chunk) => { promptText += chunk },
      () => {
        setGenerating(false)
        setFeedback('')
        setChatEntries(prev => prev.map((e, i) =>
          i === streamingEntryIndexRef.current
            ? { type: 'prompt_generated', content: promptText, confirmed: false }
            : e
        ))
      },
      (err) => {
        setGenerating(false)
        setChatEntries(prev => prev.map((e, i) =>
          i === streamingEntryIndexRef.current
            ? { type: 'error', message: `プロンプト生成エラー: ${err}` }
            : e
        ))
      }
    )
  }

  async function handleRegenerate() {
    if (generating) return
    setGenerating(true)
    setChatEntries(prev => prev.map(e =>
      e.type === 'prompt_generated' && !e.confirmed ? { ...e, confirmed: true } : e
    ))
    const originalInstruction = chatEntries.find(e => e.type === 'user_instruction') as { content: string } | undefined

    setChatEntries(prev => {
      streamingEntryIndexRef.current = prev.length
      return [...prev, { type: 'prompt_generating' }]
    })

    let promptText = ''
    await generatePromptStream(
      taskId,
      originalInstruction?.content ?? '',
      feedback,
      (chunk) => { promptText += chunk },
      () => {
        setGenerating(false)
        setFeedback('')
        setChatEntries(prev => prev.map((e, i) =>
          i === streamingEntryIndexRef.current
            ? { type: 'prompt_generated', content: promptText, confirmed: false }
            : e
        ))
      },
      (err) => {
        setGenerating(false)
        setChatEntries(prev => prev.map((e, i) =>
          i === streamingEntryIndexRef.current
            ? { type: 'error', message: `再生成エラー: ${err}` }
            : e
        ))
      }
    )
  }

  async function handleConfirmAndExecute(prompt: string) {
    setConfirmedPrompt(prompt)
    setInstruction('')
    setFeedback('')
    setChatEntries(prev => prev.map(e =>
      e.type === 'prompt_generated' && !e.confirmed ? { ...e, confirmed: true } : e
    ))

    setChatEntries(prev => [...prev, { type: 'implementation_running' }])
    setStreaming(true)

    streamKeyRef.current += 1
    const currentKey = `stream-${streamKeyRef.current}`
    setLogEntries(prev => [...prev, { kind: 'stream', text: '', key: currentKey }])

    await executeInstructionStream(
      taskId,
      prompt,
      (chunk) => {
        setLogEntries(prev => prev.map(entry =>
          entry.kind === 'stream' && entry.key === currentKey
            ? { ...entry, text: entry.text + chunk }
            : entry
        ))
      },
      async () => {
        setStreaming(false)
        setSteps(prev => prev.map(s => s.id === 'implement' ? { ...s, status: 'done_pass' } : s))
        setChatEntries(prev => {
          const idx = [...prev].reverse().findIndex(e => e.type === 'implementation_running')
          if (idx === -1) return prev
          const realIdx = prev.length - 1 - idx
          return prev.map((e, i) => i === realIdx ? { type: 'implementation_done' } : e)
        })

        setGeneratingTestCases(true)
        setChatEntries(prev => {
          streamingEntryIndexRef.current = prev.length
          return [...prev, { type: 'test_cases_generating' }]
        })

        streamKeyRef.current += 1
        const tcStreamKey = `stream-${streamKeyRef.current}`
        setLogEntries(prev => [...prev, { kind: 'stream', text: '', key: tcStreamKey }])
        await generateTestCasesStream(
          taskId,
          prompt,
          (chunk) => {
            setLogEntries(prev => prev.map(entry =>
              entry.kind === 'stream' && entry.key === tcStreamKey
                ? { ...entry, text: entry.text + chunk }
                : entry
            ))
          },
          async () => {
            setGeneratingTestCases(false)
            try {
              const items = await getTestCaseItems(taskId, 'unit')
              setTestCaseItems(items)
              setChatEntries(prev => prev.map((e, i) =>
                i === streamingEntryIndexRef.current
                  ? { type: 'test_cases_ready', items, approved: false }
                  : e
              ))
            } catch {
              setChatEntries(prev => prev.map((e, i) =>
                i === streamingEntryIndexRef.current
                  ? { type: 'error', message: 'テストケース取得エラー' }
                  : e
              ))
            }
          },
          (err) => {
            setGeneratingTestCases(false)
            setChatEntries(prev => prev.map((e, i) =>
              i === streamingEntryIndexRef.current
                ? { type: 'error', message: `テストケース生成エラー: ${err}` }
                : e
            ))
          }
        )
      },
      (err) => {
        setStreaming(false)
        setChatEntries(prev => {
          const idx = [...prev].reverse().findIndex(e => e.type === 'implementation_running')
          if (idx === -1) return [...prev, { type: 'error', message: `実装エラー: ${err}` }]
          const realIdx = prev.length - 1 - idx
          return prev.map((e, i) => i === realIdx ? { type: 'error', message: `実装エラー: ${err}` } : e)
        })
      }
    )
  }

  async function handleApproveTestCases(items: TestCaseItem[]) {
    if (items.length === 0 || runningTests) return
    setRunningTests(true)
    setRunningTestType('unit')
    testCountRef.current = { passed: 0, failed: 0 }

    setChatEntries(prev => prev.map(e =>
      e.type === 'test_cases_ready' && !e.approved ? { ...e, approved: true } : e
    ))

    setChatEntries(prev => {
      streamingEntryIndexRef.current = prev.length
      return [...prev, { type: 'test_running', label: 'テストコードを生成中' }]
    })

    streamKeyRef.current += 1
    const currentKey = `stream-${streamKeyRef.current}`
    setLogEntries(prev => [...prev, { kind: 'stream', text: '', key: currentKey }])

    await runUnitTestsStream(
      taskId,
      confirmedPrompt,
      (chunk) => {
        setLogEntries(prev =>
          prev.map(entry =>
            entry.kind === 'stream' && entry.key === currentKey
              ? { ...entry, text: entry.text + chunk }
              : entry
          )
        )
        let newLabel: string | null = null
        if (chunk.includes('[TEST] テストを実行しています') || chunk.includes('[TEST] テストを再実行しています')) {
          testCountRef.current = { passed: 0, failed: 0 }
          newLabel = 'テストを実行中 (0件完了)'
        } else if (chunk.includes('[TEST] 自動修正')) {
          const m = chunk.match(/自動修正 \((\d+)\/(\d+)\)/)
          newLabel = m ? `自動修正中 ${m[1]}/${m[2]}` : '自動修正中'
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
            const total = passed + failed
            newLabel = failed > 0 ? `テストを実行中 (${total}件完了 / ${failed}件失敗)` : `テストを実行中 (${total}件完了)`
          }
        }
        if (newLabel) {
          setTestPhaseLabel(newLabel)
          setChatEntries(prev => prev.map((e, i) =>
            i === streamingEntryIndexRef.current && e.type === 'test_running'
              ? { ...e, label: newLabel! }
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
          const lastUnit = runs.find(r => r.test_type === 'unit' && r.completed_at)
          if (lastUnit) {
            setTestResultSummary(lastUnit.summary ?? null)
            setTestPassed(lastUnit.passed)
            setSteps(prev => prev.map(s => {
              if (s.id === 'unit_test') return { ...s, status: lastUnit.passed ? 'done_pass' : 'done_fail', resultLabel: lastUnit.summary ?? undefined }
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
      (err) => {
        setRunningTests(false)
        setRunningTestType(null)
        setTestPhaseLabel(null)
        setChatEntries(prev => prev.map((e, i) =>
          i === streamingEntryIndexRef.current && e.type === 'test_running'
            ? { type: 'error', message: `テスト実行エラー: ${err}` }
            : e
        ))
      }
    )
  }

  async function handleApproveIntegrationTestCases(items: TestCaseItem[]) {
    if (items.length === 0 || runningTests) return
    setRunningTests(true)
    setRunningTestType('integration')
    testCountRef.current = { passed: 0, failed: 0 }

    setChatEntries(prev => prev.map(e =>
      e.type === 'integration_test_cases_ready' && !e.approved ? { ...e, approved: true } : e
    ))

    setChatEntries(prev => {
      streamingEntryIndexRef.current = prev.length
      return [...prev, { type: 'test_running', label: '結合テストコードを生成中' }]
    })

    streamKeyRef.current += 1
    const currentKey = `stream-${streamKeyRef.current}`
    setLogEntries(prev => [...prev, { kind: 'stream', text: '', key: currentKey }])

    await runIntegrationTestsStream(
      taskId,
      confirmedPrompt,
      (chunk) => {
        setLogEntries(prev =>
          prev.map(entry =>
            entry.kind === 'stream' && entry.key === currentKey
              ? { ...entry, text: entry.text + chunk }
              : entry
          )
        )
        let newLabel: string | null = null
        if (chunk.includes('[ITEST] テストを実行しています') || chunk.includes('[ITEST] テストを再実行しています')) {
          testCountRef.current = { passed: 0, failed: 0 }
          newLabel = '結合テストを実行中 (0件完了)'
        } else if (chunk.includes('[ITEST] 自動修正')) {
          const m = chunk.match(/自動修正 \((\d+)\/(\d+)\)/)
          newLabel = m ? `自動修正中 ${m[1]}/${m[2]}` : '自動修正中'
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
            const total = passed + failed
            newLabel = failed > 0 ? `結合テストを実行中 (${total}件完了 / ${failed}件失敗)` : `結合テストを実行中 (${total}件完了)`
          }
        }
        if (newLabel) {
          setTestPhaseLabel(newLabel)
          setChatEntries(prev => prev.map((e, i) =>
            i === streamingEntryIndexRef.current && e.type === 'test_running'
              ? { ...e, label: newLabel! }
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
          const lastIntegration = runs.find(r => r.test_type === 'integration' && r.completed_at)
          if (lastIntegration) {
            setTestResultSummary(lastIntegration.summary ?? null)
            setTestPassed(lastIntegration.passed)
            setSteps(prev => prev.map(s => {
              if (s.id === 'integration_test') return { ...s, status: lastIntegration.passed ? 'done_pass' : 'done_fail', resultLabel: lastIntegration.summary ?? undefined }
              if (s.id === 'review') return { ...s, status: 'active' }
              return s
            }))
            setChatEntries(prev => {
              const mapped = prev.map((e, i) =>
                i === streamingEntryIndexRef.current && e.type === 'test_running'
                  ? { type: 'test_done' as const, summary: lastIntegration.summary ?? '', passed: lastIntegration.passed, items: freshItems }
                  : e
              )
              if (lastIntegration.passed) {
                return [...mapped, { type: 'review' as const, prompt: confirmedPrompt, items: freshItems, resolved: false }]
              }
              return mapped
            })
          }
        } catch { /* ignore */ }
      },
      (err) => {
        setRunningTests(false)
        setRunningTestType(null)
        setTestPhaseLabel(null)
        setChatEntries(prev => prev.map((e, i) =>
          i === streamingEntryIndexRef.current && e.type === 'test_running'
            ? { type: 'error', message: `結合テスト実行エラー: ${err}` }
            : e
        ))
      }
    )
  }

  async function handleGenerateTestCasesManual() {
    if (!confirmedPrompt || task?.status !== 'idle') return
    setGeneratingTestCases(true)
    setChatEntries(prev => {
      streamingEntryIndexRef.current = prev.length
      return [...prev, { type: 'test_cases_generating' }]
    })
    streamKeyRef.current += 1
    const tcStreamKey = `stream-${streamKeyRef.current}`
    setLogEntries(prev => [...prev, { kind: 'stream', text: '', key: tcStreamKey }])
    await generateTestCasesStream(
      taskId,
      confirmedPrompt,
      (chunk) => {
        setLogEntries(prev => prev.map(entry =>
          entry.kind === 'stream' && entry.key === tcStreamKey
            ? { ...entry, text: entry.text + chunk }
            : entry
        ))
      },
      async () => {
        setGeneratingTestCases(false)
        try {
          const items = await getTestCaseItems(taskId, 'unit')
          setTestCaseItems(items)
          setChatEntries(prev => prev.map((e, i) =>
            i === streamingEntryIndexRef.current
              ? { type: 'test_cases_ready', items, approved: false }
              : e
          ))
        } catch {
          setChatEntries(prev => prev.map((e, i) =>
            i === streamingEntryIndexRef.current
              ? { type: 'error', message: 'テストケース取得エラー' }
              : e
          ))
        }
      },
      (err) => {
        setGeneratingTestCases(false)
        setChatEntries(prev => prev.map((e, i) =>
          i === streamingEntryIndexRef.current
            ? { type: 'error', message: `テストケース生成エラー: ${err}` }
            : e
        ))
      }
    )
  }

  async function handleGenerateIntegrationTestCasesManual() {
    if (!confirmedPrompt || task?.status !== 'idle') return
    setGeneratingTestCases(true)
    setChatEntries(prev => {
      streamingEntryIndexRef.current = prev.length
      return [...prev, { type: 'integration_test_cases_generating' }]
    })
    streamKeyRef.current += 1
    const tcStreamKey = `stream-${streamKeyRef.current}`
    setLogEntries(prev => [...prev, { kind: 'stream', text: '', key: tcStreamKey }])
    await generateIntegrationTestCasesStream(
      taskId,
      confirmedPrompt,
      (chunk) => {
        setLogEntries(prev => prev.map(entry =>
          entry.kind === 'stream' && entry.key === tcStreamKey
            ? { ...entry, text: entry.text + chunk }
            : entry
        ))
      },
      async () => {
        setGeneratingTestCases(false)
        try {
          const items = await getTestCaseItems(taskId, 'integration')
          setIntegrationTestCaseItems(items)
          setChatEntries(prev => prev.map((e, i) =>
            i === streamingEntryIndexRef.current
              ? { type: 'integration_test_cases_ready', items, approved: false }
              : e
          ))
        } catch {
          setChatEntries(prev => prev.map((e, i) =>
            i === streamingEntryIndexRef.current
              ? { type: 'error', message: '結合テストケース取得エラー' }
              : e
          ))
        }
      },
      (err) => {
        setGeneratingTestCases(false)
        setChatEntries(prev => prev.map((e, i) =>
          i === streamingEntryIndexRef.current
            ? { type: 'error', message: `結合テストケース生成エラー: ${err}` }
            : e
        ))
      }
    )
  }

  function handleApproveImplementation() {
    setChatEntries(prev => prev.map(e =>
      e.type === 'review' && !e.resolved ? { ...e, resolved: true } : e
    ))
    setChatEntries(prev => [...prev, { type: 'info', message: '実装を承認しました。新しい指示を入力してください。' }])
    setConfirmedPrompt('')
    setTestCaseItems([])
  }

  function handleRejectImplementation() {
    setChatEntries(prev => prev.map(e =>
      e.type === 'review' && !e.resolved ? { ...e, resolved: true } : e
    ))
    setChatEntries(prev => [...prev, { type: 'info', message: '差し戻しました。指示を修正して再実行してください。' }])
    setInstruction(confirmedPrompt)
    setConfirmedPrompt('')
  }

  async function handleRevisionRequest(revisionFeedback: string) {
    setShowRevisionInput(false)
    setRevisionText('')
    setGeneratingTestCases(true)
    setChatEntries(prev => prev.map(e =>
      e.type === 'test_cases_ready' && !e.approved ? { ...e, approved: true } : e
    ))
    setChatEntries(prev => {
      streamingEntryIndexRef.current = prev.length
      return [...prev, { type: 'test_cases_generating' }]
    })
    streamKeyRef.current += 1
    const tcStreamKey = `stream-${streamKeyRef.current}`
    setLogEntries(prev => [...prev, { kind: 'stream', text: '', key: tcStreamKey }])
    await generateTestCasesStream(
      taskId,
      confirmedPrompt + '\n\n## 前回のテストケースへの指摘\n' + revisionFeedback,
      (chunk) => {
        setLogEntries(prev => prev.map(entry =>
          entry.kind === 'stream' && entry.key === tcStreamKey
            ? { ...entry, text: entry.text + chunk }
            : entry
        ))
      },
      async () => {
        setGeneratingTestCases(false)
        try {
          const items = await getTestCaseItems(taskId, 'unit')
          setTestCaseItems(items)
          setChatEntries(prev => prev.map((e, i) =>
            i === streamingEntryIndexRef.current
              ? { type: 'test_cases_ready', items, approved: false }
              : e
          ))
        } catch {
          setChatEntries(prev => prev.map((e, i) =>
            i === streamingEntryIndexRef.current
              ? { type: 'error', message: 'テストケース取得エラー' }
              : e
          ))
        }
      },
      (err) => {
        setGeneratingTestCases(false)
        setChatEntries(prev => prev.map((e, i) =>
          i === streamingEntryIndexRef.current
            ? { type: 'error', message: `テストケース再生成エラー: ${err}` }
            : e
        ))
      }
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
    setLogEntries(prev => [...prev, { kind: 'stream', text: '', key: currentKey }])

    await gitPushStream(
      taskId,
      (chunk) => {
        setLogEntries(prev =>
          prev.map(entry =>
            entry.kind === 'stream' && entry.key === currentKey
              ? { ...entry, text: entry.text + chunk }
              : entry
          )
        )
      },
      () => { setPushing(false) },
      (err) => {
        setLogEntries(prev => [
          ...prev,
          {
            kind: 'log',
            data: {
              id: Date.now(),
              task_id: taskId,
              level: 'error',
              source: 'system',
              message: `Git push error: ${err}`,
              created_at: new Date().toISOString(),
            },
          },
        ])
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
    } catch (err) {
      alert(err instanceof Error ? err.message : '停止に失敗しました')
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
            <span style={{ fontSize: '0.72rem', color: '#60a5fa', marginBottom: '4px', display: 'block', fontWeight: 600 }}>あなたの指示</span>
            {entry.content}
          </div>
        )

      case 'clarify_question':
        return (
          <div key={idx} style={{
            background: '#0f172a', border: '1px solid #334155', borderRadius: '6px',
            padding: '8px 12px', fontSize: '0.82rem', color: '#e2e8f0',
            whiteSpace: 'pre-wrap', lineHeight: 1.6,
          }}>
            <span style={{ fontSize: '0.72rem', color: '#6366f1', marginBottom: '4px', display: 'block', fontWeight: 600 }}>Claude</span>
            {entry.content}
          </div>
        )

      case 'clarify_answer':
        return (
          <div key={idx} style={{
            background: '#1e3a5f', border: '1px solid #2563eb', borderRadius: '6px',
            padding: '8px 12px', fontSize: '0.82rem', color: '#bfdbfe',
            whiteSpace: 'pre-wrap', lineHeight: 1.6, marginLeft: '20px',
          }}>
            <span style={{ fontSize: '0.72rem', color: '#60a5fa', marginBottom: '4px', display: 'block', fontWeight: 600 }}>あなた</span>
            {entry.content}
          </div>
        )

      case 'clarify_streaming':
        return (
          <div key={idx} style={{
            background: '#0f172a', border: '1px solid #334155', borderRadius: '6px',
            padding: '8px 12px', fontSize: '0.82rem', color: '#94a3b8',
            whiteSpace: 'pre-wrap', lineHeight: 1.6,
          }}>
            <span style={{ fontSize: '0.72rem', color: '#6366f1', marginBottom: '4px', display: 'block', fontWeight: 600 }}>Claude</span>
            {entry.content || <><span className="spinner" style={{ width: '10px', height: '10px', marginRight: '4px' }} />考え中...</>}
          </div>
        )

      case 'prompt_generating':
        return (
          <div key={idx} style={{
            background: '#0f172a', border: '1px solid #334155', borderRadius: '6px',
            padding: '10px 12px', fontSize: '0.82rem', color: '#94a3b8',
            display: 'flex', alignItems: 'center', gap: '8px',
          }}>
            <span className="spinner" style={{ width: '12px', height: '12px', marginRight: 0 }} />
            プロンプトを生成しています...
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
              生成されたプロンプト {entry.confirmed ? '(確定済み)' : '— 下のボタンで確定または再生成'}
            </div>
            <div style={{
              fontFamily: 'monospace', color: '#e2e8f0', whiteSpace: 'pre-wrap', lineHeight: 1.5,
              maxHeight: '200px', overflowY: 'auto',
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
            <span className="spinner" style={{ width: '12px', height: '12px', marginRight: 0 }} />
            実装を実行しています...（左ペインのログをご確認ください）
          </div>
        )

      case 'implementation_done':
        return (
          <div key={idx} style={{
            background: '#052e16', border: '1px solid #16a34a', borderRadius: '6px',
            padding: '10px 12px', fontSize: '0.82rem', color: '#86efac',
            display: 'flex', alignItems: 'center', gap: '8px',
          }}>
            ✅ 実装が完了しました
          </div>
        )

      case 'test_cases_generating':
        return (
          <div key={idx} style={{
            background: '#0f172a', border: '1px solid #334155', borderRadius: '6px',
            padding: '10px 12px', fontSize: '0.82rem', color: '#94a3b8',
            display: 'flex', alignItems: 'center', gap: '8px',
          }}>
            <span className="spinner" style={{ width: '12px', height: '12px', marginRight: 0 }} />
            テストケースを生成しています...
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
              テストケース {entry.approved ? '(承認済み)' : `— ${entry.items.length} 件${entry.items.length > 0 ? '　下のボタンで承認' : ''}`}
            </div>
            {entry.items.length === 0 ? (
              <div style={{ color: '#475569', fontSize: '0.82rem' }}>
                テストケースがまだ生成されていません
                {confirmedPrompt && task?.status !== 'idle' && (
                  <span style={{ display: 'block', fontSize: '0.78rem', color: '#ef4444', marginTop: '4px' }}>
                    タスクのコンテナが起動していません（ステータス: {task?.status}）
                  </span>
                )}
              </div>
            ) : (
              <div style={{ overflowX: 'auto', maxHeight: '200px', overflowY: 'auto' }}>
                <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: '0.75rem' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid #334155', background: '#0a0f1e' }}>
                      <th style={{ padding: '4px 6px', textAlign: 'left', color: '#6366f1', fontWeight: 600, whiteSpace: 'nowrap' }}>ID</th>
                      <th style={{ padding: '4px 6px', textAlign: 'left', color: '#6366f1', fontWeight: 600, whiteSpace: 'nowrap' }}>対象画面</th>
                      <th style={{ padding: '4px 6px', textAlign: 'left', color: '#6366f1', fontWeight: 600 }}>テスト項目</th>
                      <th style={{ padding: '4px 6px', textAlign: 'left', color: '#6366f1', fontWeight: 600 }}>期待出力</th>
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
            <span className="spinner" style={{ width: '12px', height: '12px', marginRight: 0 }} />
            結合テストケースを生成しています...
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
              結合テストケース {entry.approved ? '(承認済み)' : `— ${entry.items.length} 件${entry.items.length > 0 ? '　下のボタンで承認' : ''}`}
            </div>
            {entry.items.length === 0 ? (
              <div style={{ color: '#475569', fontSize: '0.82rem' }}>
                結合テストケースがまだ生成されていません
                {confirmedPrompt && task?.status !== 'idle' && (
                  <span style={{ display: 'block', fontSize: '0.78rem', color: '#ef4444', marginTop: '4px' }}>
                    タスクのコンテナが起動していません（ステータス: {task?.status}）
                  </span>
                )}
              </div>
            ) : (
              <div style={{ overflowX: 'auto', maxHeight: '200px', overflowY: 'auto' }}>
                <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: '0.75rem' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid #334155', background: '#0a0f1e' }}>
                      <th style={{ padding: '4px 6px', textAlign: 'left', color: '#a855f7', fontWeight: 600, whiteSpace: 'nowrap' }}>ID</th>
                      <th style={{ padding: '4px 6px', textAlign: 'left', color: '#a855f7', fontWeight: 600, whiteSpace: 'nowrap' }}>対象</th>
                      <th style={{ padding: '4px 6px', textAlign: 'left', color: '#a855f7', fontWeight: 600 }}>テスト項目</th>
                      <th style={{ padding: '4px 6px', textAlign: 'left', color: '#a855f7', fontWeight: 600 }}>期待出力</th>
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
            <span className="spinner" style={{ width: '12px', height: '12px', marginRight: 0 }} />
            {entry.label}
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
              {entry.passed ? '✅' : '❌'} {entry.summary || (entry.passed ? 'テスト合格' : 'テスト失敗')}
            </div>
            {entry.items.length > 0 && (
              <div style={{ overflowX: 'auto', maxHeight: '200px', overflowY: 'auto' }}>
                <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: '0.72rem' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
                      <th style={{ padding: '3px 6px', textAlign: 'left', color: '#94a3b8', fontWeight: 500, whiteSpace: 'nowrap' }}>ID</th>
                      <th style={{ padding: '3px 6px', textAlign: 'left', color: '#94a3b8', fontWeight: 500 }}>テスト項目</th>
                      <th style={{ padding: '3px 6px', textAlign: 'left', color: '#94a3b8', fontWeight: 500 }}>期待出力</th>
                      <th style={{ padding: '3px 6px', textAlign: 'left', color: '#94a3b8', fontWeight: 500 }}>実際の出力</th>
                      <th style={{ padding: '3px 6px', textAlign: 'center', color: '#94a3b8', fontWeight: 500, whiteSpace: 'nowrap' }}>判定</th>
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
                          <td style={{ padding: '3px 6px', textAlign: 'center', whiteSpace: 'nowrap' }}>{icon} {r?.verdict ?? '未実行'}</td>
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
              実装確認 {entry.resolved ? '(完了)' : '— 下のボタンで承認または差し戻し'}
            </div>
            <div style={{
              background: '#1e293b', borderRadius: '4px', padding: '8px',
              fontSize: '0.78rem', color: '#94a3b8', whiteSpace: 'pre-wrap',
              maxHeight: '100px', overflowY: 'auto',
            }}>
              <span style={{ color: '#475569', fontSize: '0.7rem', display: 'block', marginBottom: '4px' }}>実行されたプロンプト</span>
              {entry.prompt}
            </div>
          </div>
        )

      case 'error':
        return (
          <div key={idx} style={{
            background: '#450a0a', border: '1px solid #dc2626', borderRadius: '6px',
            padding: '8px 12px', fontSize: '0.82rem', color: '#fca5a5',
          }}>
            ❌ {entry.message}
          </div>
        )

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
    const isBusy = streaming || generating || clarifying || generatingTestCases || runningTests

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
        <>
          <div style={{ marginBottom: '6px' }}>
            <p style={{ fontSize: '0.72rem', color: '#94a3b8', margin: '0 0 4px' }}>
              このプロンプトへの指摘・追加要望（任意）
            </p>
            <textarea
              className="instruction-textarea"
              value={feedback}
              onChange={e => setFeedback(e.target.value)}
              placeholder="例: エラーメッセージの表示場所も指定してほしい"
              rows={2}
              style={{ marginBottom: 0, minHeight: '50px', fontSize: '0.82rem' }}
              disabled={isBusy}
            />
          </div>
          <div className="instruction-footer" style={{ margin: 0 }}>
            <button className="btn-primary" onClick={() => handleConfirmAndExecute(lastUnconfirmedPrompt.content)} disabled={isBusy}>
              確定して実行
            </button>
            <button className="btn-secondary" onClick={handleRegenerate} disabled={isBusy}>
              {generating ? '生成中...' : '再生成'}
            </button>
          </div>
        </>
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
                  テストケースを生成
                </button>
              ) : (
                <span style={{ fontSize: '0.82rem', color: '#475569' }}>
                  {task?.status !== 'idle' ? `コンテナが起動していません（${task?.status}）` : 'テストケースを生成できません'}
                </span>
              )}
            </div>
          )
        }
        // Test cases exist — show approve / revision buttons
        return (
          <>
            {showRevisionInput && (
              <div style={{ marginBottom: '8px' }}>
                <textarea
                  className="instruction-textarea"
                  value={revisionText}
                  onChange={e => setRevisionText(e.target.value)}
                  placeholder="修正してほしい内容を入力してください..."
                  style={{ minHeight: '70px', fontSize: '0.82rem', marginBottom: '6px' }}
                  autoFocus
                />
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button className="btn-primary" disabled={!revisionText.trim()} onClick={() => handleRevisionRequest(revisionText.trim())}>
                    送信
                  </button>
                  <button className="btn-secondary" onClick={() => { setShowRevisionInput(false); setRevisionText('') }}>
                    キャンセル
                  </button>
                </div>
              </div>
            )}
            <div className="instruction-footer" style={{ margin: 0 }}>
              <button className="btn-primary" onClick={() => handleApproveTestCases(items)} disabled={isBusy}>
                {runningTests ? 'テスト実行中...' : '承認してテスト実行'}
              </button>
              <button className="btn-secondary" onClick={() => { setShowRevisionInput(prev => !prev); setRevisionText('') }} disabled={isBusy}>
                修正を依頼
              </button>
            </div>
          </>
        )
      }
      // unit_test selected but all approved / no pending — offer re-run or initial generate
      const latestTestCases = chatEntries.reduce<(ChatEntry & { type: 'test_cases_ready' }) | null>(
        (last, e) => e.type === 'test_cases_ready' ? e as ChatEntry & { type: 'test_cases_ready' } : last, null)
      if (latestTestCases && latestTestCases.items.length > 0) {
        return (
          <div className="instruction-footer" style={{ margin: 0 }}>
            <button className="btn-primary" onClick={() => handleApproveTestCases(latestTestCases.items)} disabled={isBusy}>
              {runningTests ? 'テスト実行中...' : 'テストを再実行'}
            </button>
            {confirmedPrompt && task?.status === 'idle' && (
              <button className="btn-secondary" onClick={handleGenerateTestCasesManual} disabled={isBusy}>
                {generatingTestCases ? 'テストケース生成中...' : 'テストケースを再生成'}
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
              {generatingTestCases ? 'テストケース生成中...' : 'テストケースを生成'}
            </button>
          ) : (
            <span style={{ fontSize: '0.82rem', color: '#475569' }}>
              {task?.status !== 'idle' ? `コンテナが起動していません（${task?.status}）` : '先に実装を実行してください'}
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
                  {generatingTestCases ? '結合テストケース生成中...' : '結合テストケースを生成'}
                </button>
              ) : (
                <span style={{ fontSize: '0.82rem', color: '#475569' }}>
                  {task?.status !== 'idle' ? `コンテナが起動していません（${task?.status}）` : '結合テストケースを生成できません'}
                </span>
              )}
            </div>
          )
        }
        return (
          <div className="instruction-footer" style={{ margin: 0 }}>
            <button className="btn-primary" onClick={() => handleApproveIntegrationTestCases(itcItems)} disabled={isBusy}>
              {runningTests ? '結合テスト実行中...' : '承認して結合テスト実行'}
            </button>
            <button className="btn-secondary" onClick={handleGenerateIntegrationTestCasesManual} disabled={isBusy}>
              修正を依頼
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
              {runningTests ? '結合テスト実行中...' : '結合テストを再実行'}
            </button>
            {confirmedPrompt && task?.status === 'idle' && (
              <button className="btn-secondary" onClick={handleGenerateIntegrationTestCasesManual} disabled={isBusy}>
                {generatingTestCases ? '結合テストケース生成中...' : '結合テストケースを再生成'}
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
              {generatingTestCases ? '結合テストケース生成中...' : '結合テストケースを生成'}
            </button>
          ) : (
            <span style={{ fontSize: '0.82rem', color: '#475569' }}>
              {task?.status !== 'idle' ? `コンテナが起動していません（${task?.status}）` : '先に単体テストを完了してください'}
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
              承認
            </button>
            <button className="btn-danger" onClick={handleRejectImplementation} disabled={isBusy}>
              差し戻し
            </button>
          </div>
        )
      }
      return null
    }

    return null
  }

  function renderInputArea() {
    const isBusy = streaming || generating || clarifying || generatingTestCases || runningTests
    const isClarifyMode = chatEntries.length > 0 &&
      chatEntries[chatEntries.length - 1].type === 'clarify_question'

    const wrapperStyle: React.CSSProperties = {
      borderTop: '1px solid #1e293b',
      padding: '10px 12px',
      flexShrink: 0,
      display: 'flex',
      flexDirection: 'column',
      gap: '8px',
      background: '#0a0f1e',
    }

    // ── 単体テスト・結合テスト・実装確認フェーズ ──
    if (selectedStep === 'unit_test' || selectedStep === 'integration_test' || selectedStep === 'review') {
      return (
        <div style={wrapperStyle}>
          <textarea
            className="instruction-textarea"
            value=""
            onChange={() => {}}
            placeholder="このフェーズではコメント入力は使用しません"
            disabled
            style={{ minHeight: '60px', marginBottom: 0, resize: 'none', opacity: 0.35 }}
          />
          {renderActionButtons()}
        </div>
      )
    }

    // ── 実装フェーズ（要件確認・プロンプト生成） ──
    const canSend = !isBusy && instruction.trim().length > 0 && task?.status === 'idle'
    const actionButtons = renderActionButtons()

    return (
      <div style={wrapperStyle}>
        <textarea
          className="instruction-textarea"
          value={instruction}
          onChange={e => setInstruction(e.target.value)}
          placeholder={isClarifyMode ? '回答を入力... (Enter で送信)' : '指示を入力してください...'}
          disabled={isBusy || task?.status !== 'idle'}
          onKeyDown={e => {
            if (isClarifyMode && e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              handleSendClarifyAnswer()
            }
          }}
          style={{ minHeight: '60px', marginBottom: 0, resize: 'vertical' }}
        />
        {actionButtons && (
          <div style={{ borderTop: '1px solid #1e293b', paddingTop: '8px' }}>
            {actionButtons}
          </div>
        )}
        <div className="instruction-footer" style={{ margin: 0 }}>
          {isClarifyMode ? (
            <>
              <button className="btn-primary" onClick={handleSendClarifyAnswer} disabled={!canSend}>
                回答を送信
              </button>
              <button className="btn-secondary" onClick={handleSkipClarify} disabled={isBusy}>
                スキップしてプロンプトを生成
              </button>
            </>
          ) : (
            <>
              <button className="btn-primary" onClick={handleStartClarify} disabled={!canSend}>
                要件を確認する
              </button>
              <button className="btn-secondary" onClick={handleGeneratePrompt} disabled={!canSend}>
                スキップしてプロンプトを生成
              </button>
            </>
          )}
          {task?.status !== 'idle' && statusMessage && (
            <span className="instruction-status">{statusMessage}</span>
          )}
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
          <h1>Xolvien</h1>
        </header>
        <div className="page-content">
          <Link to="/" className="back-link">
            &larr; 戻る
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
          <h1>Xolvien</h1>
        </header>
        <div className="loading-state">読み込み中...</div>
      </>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      {/* Top bar */}
      <header className="app-header">
        <h1>Xolvien</h1>
      </header>

      <div className="task-detail-container">
        <div className="task-detail-topbar">
          <Link
            to="/"
            className="back-link"
            style={{ margin: 0, flexShrink: 0 }}
            onClick={() => navigate('/')}
          >
            &larr; 戻る
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
            onClick={handleGitPush}
            disabled={pushing || streaming || task.status !== 'idle'}
            style={{ flexShrink: 0 }}
          >
            {pushing ? 'Push中...' : 'Git Push'}
          </button>

          {showStopButton && (
            <button
              className="btn-warning btn-sm"
              onClick={handleStop}
              disabled={stopping}
              style={{ flexShrink: 0 }}
            >
              {stopping ? '停止中...' : '停止'}
            </button>
          )}
        </div>

        <div className="task-detail-body" ref={bodyRef}>
          {/* Left: Log Viewer */}
          <div style={{ display: 'flex', flexDirection: 'column', flex: `0 0 ${logWidthPercent}%`, minWidth: 0, overflow: 'hidden', paddingLeft: '24px' }}>
            {/* Running status banner */}
            {(streaming || task.status === 'running' || task.status === 'initializing' || task.status === 'testing' || generating || clarifying || generatingTestCases || runningTests) && (
              <div style={{
                background: '#1e3a5f',
                borderBottom: '1px solid #2563eb',
                padding: '6px 16px',
                fontSize: '0.82rem',
                color: '#93c5fd',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                flexShrink: 0,
              }}>
                <span className="spinner" />
                {clarifying
                  ? '要件を確認しています...'
                  : generating
                  ? 'プロンプト生成中...'
                  : generatingTestCases
                  ? 'テストケースを生成しています...'
                  : runningTests || task.status === 'testing'
                  ? `${runningTestType === 'unit' ? '単体テスト' : runningTestType === 'integration' ? '結合テスト' : runningTestType === 'e2e' ? 'E2Eテスト' : 'テスト'}: ${testPhaseLabel ?? 'テストコードを生成中'}`
                  : task.status === 'initializing'
                  ? 'コンテナを準備中... (30秒〜1分かかります)'
                  : '実行中... (完了まで1〜3分かかることがあります)'}
              </div>
            )}
            <div className="log-viewer" ref={logViewerRef} style={{ flex: 1 }}>
              {logEntries.length === 0 ? (
                <p className="log-empty">ログはまだありません...</p>
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
                    return (
                      <p key={entry.key} className="log-stream-chunk">
                        {entry.text || '⏳ Claude Code CLI 起動中...'}
                      </p>
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
                      <span>{step.label}</span>
                      {step.resultLabel && (
                        <span style={{ fontSize: '0.7rem', opacity: 0.85 }}>({step.resultLabel})</span>
                      )}
                    </button>
                  </div>
                )
              })}
            </div>

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
                  <p>指示を入力して開始してください</p>
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
