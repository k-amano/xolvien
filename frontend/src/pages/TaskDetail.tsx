import { useEffect, useRef, useState, useCallback } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import type { Task, TaskLog, TaskStatus, LogLevel } from '../types'
import { getTask, getLogs, stopTask, executeInstructionStream, generatePromptStream, clarifyStream, gitPushStream, generateTestCasesStream, runUnitTestsStream, getTestRuns, getLastCompletedInstruction } from '../services/api'

type PromptState = 'idle' | 'clarifying' | 'generating' | 'confirming' | 'test_cases' | 'running_tests' | 'reviewing'

type ChatMessage = { role: 'assistant' | 'user'; content: string }

type StepId = 'implement' | 'unit_test' | 'integration_test' | 'e2e_test' | 'review'
type StepStatus = 'done_pass' | 'done_fail' | 'active' | 'pending'

interface StepInfo {
  id: StepId
  label: string
  status: StepStatus
  resultLabel?: string  // e.g. "19件合格" or "3件失敗"
  future?: boolean      // grayed out, not yet implemented
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
  const [promptState, setPromptState] = useState<PromptState>('idle')
  const [generatedPrompt, setGeneratedPrompt] = useState('')
  const [feedback, setFeedback] = useState('')
  const [generating, setGenerating] = useState(false)
  const [clarifyHistory, setClarifyHistory] = useState<ChatMessage[]>([])
  const [clarifyInput, setClarifyInput] = useState('')
  const [clarifying, setClarifying] = useState(false)
  const [clarifyStreamText, setClarifyStreamText] = useState('')

  // Test case generation state
  const [generatedTestCases, setGeneratedTestCases] = useState('')
  const [editableTestCases, setEditableTestCases] = useState('')
  const [generatingTestCases, setGeneratingTestCases] = useState(false)
  const [runningTests, setRunningTests] = useState(false)
  // The implementation prompt that was confirmed for execution (saved to pass into test flow)
  const [confirmedPrompt, setConfirmedPrompt] = useState('')
  // Resume / step navigation state
  const [resumeChecked, setResumeChecked] = useState(false)
  const [selectedStep, setSelectedStep] = useState<StepId | null>(null)
  const [steps, setSteps] = useState<StepInfo[]>([
    { id: 'implement',         label: '実装',       status: 'pending' },
    { id: 'unit_test',         label: '単体テスト', status: 'pending' },
    { id: 'integration_test',  label: '結合テスト',   status: 'pending', future: true },
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

  // Sync editable test cases when generation finishes
  useEffect(() => {
    if (!generatingTestCases && generatedTestCases && !editableTestCases) {
      setEditableTestCases(generatedTestCases)
    }
  }, [generatingTestCases, generatedTestCases, editableTestCases])

  // On first load: collect step history from DB and restore state
  useEffect(() => {
    if (resumeChecked) return
    setResumeChecked(true)

    async function checkResume() {
      try {
        const [runs, lastInstruction] = await Promise.all([
          getTestRuns(taskId),
          getLastCompletedInstruction(taskId),
        ])

        const hasImpl = !!lastInstruction
        const lastUnit = runs.find(r => r.test_type === 'unit' && r.completed_at)

        // Nothing done yet
        if (!hasImpl && !lastUnit) return

        const prompt = lastInstruction?.content ?? ''
        const testCases = lastUnit?.test_cases ?? ''

        if (prompt) setConfirmedPrompt(prompt)
        if (testCases) {
          setGeneratedTestCases(testCases)
          setEditableTestCases(testCases)
        }

        // Build step statuses
        setSteps(prev => prev.map(step => {
          switch (step.id) {
            case 'implement':
              return hasImpl
                ? { ...step, status: 'done_pass' }
                : step
            case 'unit_test':
              if (!lastUnit) return hasImpl ? { ...step, status: 'active' } : step
              return lastUnit.passed
                ? { ...step, status: 'done_pass', resultLabel: lastUnit.summary ?? undefined }
                : { ...step, status: 'done_fail', resultLabel: lastUnit.summary ?? undefined }
            case 'review':
              return lastUnit?.passed
                ? { ...step, status: 'active' }
                : step
            default:
              return step
          }
        }))

        // Auto-navigate to the most appropriate step
        if (lastUnit?.passed) {
          setPromptState('reviewing')
          setSelectedStep('review')
        } else if (lastUnit) {
          setPromptState('test_cases')
          setSelectedStep('unit_test')
        } else if (hasImpl) {
          setPromptState('test_cases')
          setSelectedStep('unit_test')
        }
      } catch {
        // Ignore errors — start fresh
      }
    }

    checkResume()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId])

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
        // Skip control messages from the server (connected, ping)
        if (parsed.type === 'connected' || parsed.type === 'ping') return
        const log: TaskLog = parsed
        if (seenLogIdsRef.current.has(log.id)) return
        seenLogIdsRef.current.add(log.id)
        setLogEntries(prev => [...prev, { kind: 'log', data: log }])
      } catch {
        // If it's not JSON, treat as plain text info log
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

  async function runInstruction(content: string) {
    if (!content.trim() || streaming) return
    setStreaming(true)

    streamKeyRef.current += 1
    const currentKey = `stream-${streamKeyRef.current}`

    setLogEntries(prev => [
      ...prev,
      { kind: 'stream', text: '', key: currentKey },
    ])

    await executeInstructionStream(
      taskId,
      content,
      (chunk: string) => {
        setLogEntries(prev =>
          prev.map(entry =>
            entry.kind === 'stream' && entry.key === currentKey
              ? { ...entry, text: entry.text + chunk }
              : entry
          )
        )
      },
      () => { setStreaming(false) },
      (err: string) => {
        setLogEntries(prev => [
          ...prev,
          {
            kind: 'log',
            data: {
              id: Date.now(),
              task_id: taskId,
              level: 'error',
              source: 'system',
              message: `Instruction error: ${err}`,
              created_at: new Date().toISOString(),
            },
          },
        ])
        setStreaming(false)
      }
    )
  }

  async function handleStartClarify() {
    if (!instruction.trim() || clarifying || generating) return
    setClarifyHistory([])
    setClarifyStreamText('')
    setClarifying(true)
    setPromptState('clarifying')

    let streamedText = ''
    await clarifyStream(
      taskId,
      instruction.trim(),
      [],
      (chunk) => {
        streamedText += chunk
        setClarifyStreamText(streamedText)
      },
      () => {
        setClarifying(false)
        if (streamedText.startsWith('PROMPT_READY')) {
          const prompt = streamedText.replace(/^PROMPT_READY\n?/, '')
          setGeneratedPrompt(prompt)
          setClarifyStreamText('')
          setClarifyHistory([])
          setPromptState('confirming')
        } else {
          setClarifyHistory([{ role: 'assistant', content: streamedText }])
          setClarifyStreamText('')
        }
      },
      (err) => {
        setClarifying(false)
        setPromptState('idle')
        setLogEntries(prev => [
          ...prev,
          {
            kind: 'log',
            data: {
              id: Date.now(),
              task_id: taskId,
              level: 'error',
              source: 'system',
              message: `要件確認エラー: ${err}`,
              created_at: new Date().toISOString(),
            },
          },
        ])
      }
    )
  }

  async function handleSendClarifyAnswer() {
    if (!clarifyInput.trim() || clarifying) return
    const userMsg = clarifyInput.trim()
    setClarifyInput('')
    const newHistory: ChatMessage[] = [...clarifyHistory, { role: 'user', content: userMsg }]
    setClarifyHistory(newHistory)
    setClarifying(true)
    setClarifyStreamText('')

    let streamedText = ''
    await clarifyStream(
      taskId,
      instruction.trim(),
      newHistory,
      (chunk) => {
        streamedText += chunk
        setClarifyStreamText(streamedText)
      },
      () => {
        setClarifying(false)
        if (streamedText.startsWith('PROMPT_READY')) {
          const prompt = streamedText.replace(/^PROMPT_READY\n?/, '')
          setGeneratedPrompt(prompt)
          setClarifyStreamText('')
          setClarifyHistory([])
          setPromptState('confirming')
        } else {
          setClarifyHistory(prev => [...prev, { role: 'assistant', content: streamedText }])
          setClarifyStreamText('')
        }
      },
      (err) => {
        setClarifying(false)
        setLogEntries(prev => [
          ...prev,
          {
            kind: 'log',
            data: {
              id: Date.now(),
              task_id: taskId,
              level: 'error',
              source: 'system',
              message: `要件確認エラー: ${err}`,
              created_at: new Date().toISOString(),
            },
          },
        ])
      }
    )
  }

  async function handleSkipClarify() {
    setPromptState('generating')
    setGenerating(true)
    setGeneratedPrompt('')
    setClarifyHistory([])
    setClarifyStreamText('')

    await generatePromptStream(
      taskId,
      instruction.trim(),
      feedback,
      (chunk) => setGeneratedPrompt(prev => prev + chunk),
      () => {
        setGenerating(false)
        setPromptState('confirming')
      },
      (err) => {
        setGenerating(false)
        setPromptState('idle')
        setLogEntries(prev => [
          ...prev,
          {
            kind: 'log',
            data: {
              id: Date.now(),
              task_id: taskId,
              level: 'error',
              source: 'system',
              message: `プロンプト生成エラー: ${err}`,
              created_at: new Date().toISOString(),
            },
          },
        ])
      }
    )
  }

  async function handleGeneratePrompt() {
    if (!instruction.trim() || generating) return
    setGenerating(true)
    setGeneratedPrompt('')
    setPromptState('generating')

    await generatePromptStream(
      taskId,
      instruction.trim(),
      feedback,
      (chunk) => setGeneratedPrompt(prev => prev + chunk),
      () => {
        setGenerating(false)
        setPromptState('confirming')
      },
      (err) => {
        setGenerating(false)
        setPromptState('idle')
        setLogEntries(prev => [
          ...prev,
          {
            kind: 'log',
            data: {
              id: Date.now(),
              task_id: taskId,
              level: 'error',
              source: 'system',
              message: `プロンプト生成エラー: ${err}`,
              created_at: new Date().toISOString(),
            },
          },
        ])
      }
    )
  }

  async function handleRegenerate() {
    if (generating) return
    setGenerating(true)
    setGeneratedPrompt('')
    setPromptState('generating')

    await generatePromptStream(
      taskId,
      instruction.trim(),
      feedback,
      (chunk) => setGeneratedPrompt(prev => prev + chunk),
      () => {
        setGenerating(false)
        setFeedback('')
        setPromptState('confirming')
      },
      (err) => {
        setGenerating(false)
        setPromptState('confirming')
        alert(`再生成エラー: ${err}`)
      }
    )
  }

  async function handleConfirmAndExecute() {
    const prompt = generatedPrompt.trim()
    if (!prompt) return
    setConfirmedPrompt(prompt)
    setPromptState('idle')
    setInstruction('')
    setGeneratedPrompt('')
    setFeedback('')

    // Run implementation
    await runInstruction(prompt)

    // Mark implement step as done
    setSteps(prev => prev.map(s => s.id === 'implement' ? { ...s, status: 'done_pass' } : s))

    // After implementation completes, generate test cases
    setPromptState('test_cases')
    setGeneratedTestCases('')
    setEditableTestCases('')
    setGeneratingTestCases(true)
    await generateTestCasesStream(
      taskId,
      prompt,
      (chunk) => setGeneratedTestCases(prev => prev + chunk),
      () => setGeneratingTestCases(false),
      (err) => {
        setGeneratingTestCases(false)
        setLogEntries(prev => [
          ...prev,
          {
            kind: 'log',
            data: {
              id: Date.now(),
              task_id: taskId,
              level: 'error',
              source: 'system',
              message: `テストケース生成エラー: ${err}`,
              created_at: new Date().toISOString(),
            },
          },
        ])
      }
    )
  }

  function handleCancelConfirm() {
    setPromptState('idle')
    setGeneratedPrompt('')
    setFeedback('')
  }

  function handleCancelClarify() {
    setPromptState('idle')
    setClarifyHistory([])
    setClarifyStreamText('')
    setClarifyInput('')
  }

  async function handleApproveTestCases() {
    if (!editableTestCases.trim() || runningTests) return
    setRunningTests(true)
    setPromptState('running_tests')

    streamKeyRef.current += 1
    const currentKey = `stream-${streamKeyRef.current}`
    setLogEntries(prev => [...prev, { kind: 'stream', text: '', key: currentKey }])

    await runUnitTestsStream(
      taskId,
      confirmedPrompt,
      editableTestCases,
      (chunk) => {
        setLogEntries(prev =>
          prev.map(entry =>
            entry.kind === 'stream' && entry.key === currentKey
              ? { ...entry, text: entry.text + chunk }
              : entry
          )
        )
      },
      async () => {
        setRunningTests(false)
        setPromptState('reviewing')
        // Refresh step statuses from DB
        try {
          const runs = await getTestRuns(taskId)
          const lastUnit = runs.find(r => r.test_type === 'unit' && r.completed_at)
          if (lastUnit) {
            setSteps(prev => prev.map(s => {
              if (s.id === 'unit_test')  return {
                ...s,
                status: lastUnit.passed ? 'done_pass' : 'done_fail',
                resultLabel: lastUnit.summary ?? undefined,
              }
              if (s.id === 'review')     return { ...s, status: 'active' }
              return s
            }))
          }
        } catch { /* ignore */ }
      },
      (err) => {
        setRunningTests(false)
        setPromptState('reviewing')
        setLogEntries(prev => [
          ...prev,
          {
            kind: 'log',
            data: {
              id: Date.now(),
              task_id: taskId,
              level: 'error',
              source: 'system',
              message: `テスト実行エラー: ${err}`,
              created_at: new Date().toISOString(),
            },
          },
        ])
      }
    )
  }

  function handleStepClick(stepId: StepId) {
    if (streaming || runningTests || generatingTestCases || generating || clarifying) return

    setSelectedStep(stepId)

    switch (stepId) {
      case 'implement':
        if (confirmedPrompt) setInstruction(confirmedPrompt)
        setPromptState('idle')
        setGeneratedPrompt('')
        setFeedback('')
        break
      case 'unit_test':
        setPromptState('test_cases')
        break
      case 'review':
        setPromptState('reviewing')
        break
      default:
        break
    }
  }

  function handleApproveImplementation() {
    setPromptState('idle')
    setConfirmedPrompt('')
    setGeneratedTestCases('')
    setEditableTestCases('')
  }

  function handleRejectImplementation() {
    setPromptState('idle')
    setInstruction(confirmedPrompt)
    setConfirmedPrompt('')
    setGeneratedTestCases('')
    setEditableTestCases('')
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

  const canGenerate =
    task?.status === 'idle' && !streaming && !generating && !clarifying && !generatingTestCases && !runningTests && instruction.trim().length > 0 && promptState === 'idle'

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
                  ? 'テストを実行しています...'
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

          {/* Right: Instruction Input Panel */}
          <div className="instruction-panel" style={{ flex: 1, minWidth: 0 }}>

            {/* Step progress bar */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 0,
              marginBottom: '12px',
              flexShrink: 0,
              flexWrap: 'wrap',
              rowGap: '4px',
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
                    </button>
                  </div>
                )
              })}
            </div>

            {promptState === 'idle' && (
              <>
                <p className="instruction-panel-title">Claudeへの指示</p>
                <textarea
                  className="instruction-textarea"
                  value={instruction}
                  onChange={e => setInstruction(e.target.value)}
                  placeholder={'指示を入力してください...\n例: シンプルな翻訳アプリを作ってください'}
                  disabled={streaming || task.status !== 'idle'}
                />
                <div className="instruction-footer">
                  <button
                    className="btn-primary"
                    onClick={handleStartClarify}
                    disabled={!canGenerate}
                  >
                    要件を確認する
                  </button>
                  <button
                    className="btn-secondary"
                    onClick={handleGeneratePrompt}
                    disabled={!canGenerate}
                  >
                    スキップしてプロンプトを生成
                  </button>
                  {(streaming || task.status !== 'idle') && statusMessage && (
                    <span className="instruction-status">{statusMessage}</span>
                  )}
                </div>
              </>
            )}

            {promptState === 'clarifying' && (
              <>
                <p className="instruction-panel-title">
                  要件確認
                  <span style={{ fontSize: '0.75rem', color: '#64748b', fontWeight: 'normal', marginLeft: '8px' }}>
                    — Claudeが不明点を質問します
                  </span>
                </p>

                {/* Chat history */}
                <div style={{
                  flex: 1,
                  overflowY: 'auto',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '8px',
                  marginBottom: '8px',
                  minHeight: 0,
                }}>
                  {/* Original instruction */}
                  <div style={{
                    background: '#1e293b',
                    border: '1px solid #334155',
                    borderRadius: '6px',
                    padding: '8px 12px',
                    fontSize: '0.82rem',
                    color: '#64748b',
                  }}>
                    <span style={{ color: '#475569', fontSize: '0.72rem' }}>指示: </span>
                    {instruction}
                  </div>

                  {clarifyHistory.map((msg, i) => (
                    <div
                      key={i}
                      style={{
                        background: msg.role === 'assistant' ? '#0f172a' : '#1e3a5f',
                        border: `1px solid ${msg.role === 'assistant' ? '#334155' : '#2563eb'}`,
                        borderRadius: '6px',
                        padding: '8px 12px',
                        fontSize: '0.82rem',
                        color: msg.role === 'assistant' ? '#e2e8f0' : '#bfdbfe',
                        whiteSpace: 'pre-wrap',
                        lineHeight: 1.6,
                      }}
                    >
                      <span style={{ fontSize: '0.72rem', color: msg.role === 'assistant' ? '#6366f1' : '#60a5fa', marginBottom: '4px', display: 'block' }}>
                        {msg.role === 'assistant' ? 'Claude' : 'あなた'}
                      </span>
                      {msg.content}
                    </div>
                  ))}

                  {/* Streaming response */}
                  {clarifying && (
                    <div style={{
                      background: '#0f172a',
                      border: '1px solid #334155',
                      borderRadius: '6px',
                      padding: '8px 12px',
                      fontSize: '0.82rem',
                      color: '#94a3b8',
                      whiteSpace: 'pre-wrap',
                      lineHeight: 1.6,
                    }}>
                      <span style={{ fontSize: '0.72rem', color: '#6366f1', marginBottom: '4px', display: 'block' }}>Claude</span>
                      {clarifyStreamText || '考え中...'}
                    </div>
                  )}
                </div>

                {/* Answer input — only show if Claude has already asked a question */}
                {clarifyHistory.length > 0 && clarifyHistory[clarifyHistory.length - 1].role === 'assistant' && !clarifying && (
                  <div style={{ display: 'flex', gap: '8px', marginBottom: '8px', flexShrink: 0 }}>
                    <textarea
                      className="instruction-textarea"
                      value={clarifyInput}
                      onChange={e => setClarifyInput(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault()
                          handleSendClarifyAnswer()
                        }
                      }}
                      placeholder="回答を入力してください... (Enter で送信)"
                      style={{ flex: 1, minHeight: '60px', marginBottom: 0 }}
                      disabled={clarifying}
                    />
                  </div>
                )}

                <div className="instruction-footer" style={{ flexShrink: 0 }}>
                  {clarifyHistory.length > 0 && clarifyHistory[clarifyHistory.length - 1].role === 'assistant' && !clarifying && (
                    <button
                      className="btn-primary"
                      onClick={handleSendClarifyAnswer}
                      disabled={!clarifyInput.trim() || clarifying}
                    >
                      回答を送信
                    </button>
                  )}
                  <button
                    className="btn-secondary"
                    onClick={handleSkipClarify}
                    disabled={clarifying}
                  >
                    スキップしてプロンプトを生成
                  </button>
                  <button
                    className="btn-secondary"
                    onClick={handleCancelClarify}
                    disabled={clarifying}
                  >
                    キャンセル
                  </button>
                </div>
              </>
            )}

            {promptState === 'generating' && (
              <>
                <p className="instruction-panel-title">
                  <span className="spinner" style={{ marginRight: '8px' }} />
                  AIがプロンプトを生成しています...
                </p>
                <div
                  style={{
                    background: '#0f172a',
                    border: '1px solid #334155',
                    borderRadius: '6px',
                    padding: '12px',
                    fontFamily: 'monospace',
                    fontSize: '0.82rem',
                    color: '#94a3b8',
                    minHeight: '100px',
                    maxHeight: '200px',
                    overflowY: 'auto',
                    whiteSpace: 'pre-wrap',
                    lineHeight: 1.5,
                  }}
                >
                  {generatedPrompt || '生成中...'}
                </div>
              </>
            )}

            {(promptState === 'test_cases' || promptState === 'running_tests') && (
              <>
                <p className="instruction-panel-title">
                  テストケース確認
                  <span style={{ fontSize: '0.75rem', color: '#64748b', fontWeight: 'normal', marginLeft: '8px' }}>
                    — 承認後にテストコードを生成・実行します
                  </span>
                </p>

                {generatingTestCases ? (
                  <div style={{
                    background: '#0f172a',
                    border: '1px solid #334155',
                    borderRadius: '6px',
                    padding: '12px',
                    fontFamily: 'monospace',
                    fontSize: '0.82rem',
                    color: '#94a3b8',
                    flex: 1,
                    overflowY: 'auto',
                    whiteSpace: 'pre-wrap',
                    lineHeight: 1.5,
                    minHeight: 0,
                  }}>
                    {generatedTestCases || 'テストケースを生成中...'}
                  </div>
                ) : (
                  <textarea
                    className="instruction-textarea"
                    value={editableTestCases}
                    onChange={e => setEditableTestCases(e.target.value)}
                    placeholder="テストケース一覧..."
                    style={{ flex: 1, minHeight: '200px', fontFamily: 'monospace', fontSize: '0.82rem' }}
                    disabled={runningTests}
                  />
                )}

                {!generatingTestCases && !runningTests && (
                  <p style={{ fontSize: '0.75rem', color: '#64748b', margin: '0 0 6px', flexShrink: 0 }}>
                    テストケースを直接編集できます。修正後に承認してください。
                  </p>
                )}

                <div className="instruction-footer">
                  <button
                    className="btn-primary"
                    onClick={handleApproveTestCases}
                    disabled={generatingTestCases || runningTests || !editableTestCases.trim()}
                  >
                    {runningTests ? 'テスト実行中...' : '承認してテスト実行'}
                  </button>
                  <button
                    className="btn-secondary"
                    onClick={() => {
                      // Re-generate test cases with user feedback
                      const feedback = window.prompt('テストケースの修正内容を入力してください（Claudeに再生成を依頼します）:')
                      if (feedback === null) return
                      setGeneratedTestCases('')
                      setEditableTestCases('')
                      setGeneratingTestCases(true)
                      generateTestCasesStream(
                        taskId,
                        confirmedPrompt + '\n\n## 前回のテストケースへの指摘\n' + feedback,
                        (chunk) => setGeneratedTestCases(prev => prev + chunk),
                        () => setGeneratingTestCases(false),
                        (err) => {
                          setGeneratingTestCases(false)
                          alert(`テストケース再生成エラー: ${err}`)
                        }
                      )
                    }}
                    disabled={generatingTestCases || runningTests}
                  >
                    修正を依頼
                  </button>
                  <button
                    className="btn-secondary"
                    onClick={() => { setPromptState('idle'); setGeneratedTestCases(''); setEditableTestCases('') }}
                    disabled={generatingTestCases || runningTests}
                  >
                    スキップ
                  </button>
                </div>
              </>
            )}

            {promptState === 'reviewing' && (
              <>
                <p className="instruction-panel-title">
                  実装確認
                  <span style={{ fontSize: '0.75rem', color: '#64748b', fontWeight: 'normal', marginLeft: '8px' }}>
                    — テスト完了。実装を確認してください
                  </span>
                </p>

                <div style={{
                  background: '#0f172a',
                  border: '1px solid #334155',
                  borderRadius: '6px',
                  padding: '12px',
                  fontSize: '0.82rem',
                  color: '#94a3b8',
                  marginBottom: '8px',
                }}>
                  <p style={{ margin: '0 0 8px', color: '#6366f1', fontSize: '0.75rem' }}>実行されたプロンプト</p>
                  <div style={{ whiteSpace: 'pre-wrap', color: '#cbd5e1' }}>{confirmedPrompt}</div>
                </div>

                <div style={{ background: '#0f172a', border: '1px solid #334155', borderRadius: '6px', padding: '12px', fontSize: '0.82rem', color: '#94a3b8', flex: 1, marginBottom: '8px' }}>
                  <p style={{ margin: '0 0 4px', color: '#6366f1', fontSize: '0.75rem' }}>承認済みテストケース</p>
                  <div style={{ whiteSpace: 'pre-wrap', color: '#cbd5e1', overflowY: 'auto', maxHeight: '200px' }}>{editableTestCases}</div>
                </div>

                <p style={{ fontSize: '0.8rem', color: '#64748b', margin: '0 0 8px' }}>
                  テスト結果と変更内容をログで確認してください。問題なければ「承認」、修正が必要なら「差し戻し」を選択してください。
                </p>

                <div className="instruction-footer">
                  <button
                    className="btn-primary"
                    onClick={handleApproveImplementation}
                  >
                    承認
                  </button>
                  <button
                    className="btn-danger"
                    onClick={handleRejectImplementation}
                  >
                    差し戻し
                  </button>
                </div>
              </>
            )}

            {promptState === 'confirming' && (
              <>
                <p className="instruction-panel-title">プロンプト確認</p>

                <div style={{ marginBottom: '8px' }}>
                  <p style={{ fontSize: '0.75rem', color: '#94a3b8', marginBottom: '4px' }}>
                    元の指示
                  </p>
                  <div
                    style={{
                      background: '#1e293b',
                      border: '1px solid #334155',
                      borderRadius: '6px',
                      padding: '8px 12px',
                      fontSize: '0.85rem',
                      color: '#64748b',
                    }}
                  >
                    {instruction}
                  </div>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, marginBottom: '8px' }}>
                  <p style={{ fontSize: '0.75rem', color: '#94a3b8', marginBottom: '4px', flexShrink: 0 }}>
                    生成されたプロンプト
                  </p>
                  <div
                    style={{
                      background: '#0f172a',
                      border: '1px solid #6366f1',
                      borderRadius: '6px',
                      padding: '12px',
                      fontFamily: 'monospace',
                      fontSize: '0.82rem',
                      color: '#e2e8f0',
                      flex: 1,
                      overflowY: 'auto',
                      whiteSpace: 'pre-wrap',
                      lineHeight: 1.5,
                      minHeight: 0,
                    }}
                  >
                    {generatedPrompt}
                  </div>
                </div>

                <div style={{ marginBottom: '8px' }}>
                  <p style={{ fontSize: '0.75rem', color: '#94a3b8', marginBottom: '4px' }}>
                    このプロンプトへの指摘・追加要望（任意）
                  </p>
                  <textarea
                    className="instruction-textarea"
                    value={feedback}
                    onChange={e => setFeedback(e.target.value)}
                    placeholder="例: エラーメッセージの表示場所も指定してほしい"
                    rows={2}
                    style={{ marginBottom: 0 }}
                  />
                </div>

                <div className="instruction-footer">
                  <button
                    className="btn-primary"
                    onClick={handleConfirmAndExecute}
                    disabled={streaming || !generatedPrompt}
                  >
                    確定して実行
                  </button>
                  <button
                    className="btn-secondary"
                    onClick={handleRegenerate}
                    disabled={generating}
                  >
                    {generating ? '生成中...' : '再生成'}
                  </button>
                  <button
                    className="btn-secondary"
                    onClick={handleCancelConfirm}
                    disabled={generating}
                  >
                    キャンセル
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
