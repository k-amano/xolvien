import { useEffect, useRef, useState, useCallback } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import type { Task, TaskLog, TaskStatus, LogLevel } from '../types'
import { getTask, getLogs, stopTask, executeInstructionStream, generatePromptStream, gitPushStream } from '../services/api'

type PromptState = 'idle' | 'generating' | 'confirming'

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

  const logViewerRef = useRef<HTMLDivElement>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const seenLogIdsRef = useRef<Set<number>>(new Set())
  const streamKeyRef = useRef(0)

  // Resizable split pane
  const bodyRef = useRef<HTMLDivElement>(null)
  const isDraggingRef = useRef(false)
  const [logHeightPercent, setLogHeightPercent] = useState(30)

  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      if (!isDraggingRef.current || !bodyRef.current) return
      const rect = bodyRef.current.getBoundingClientRect()
      const pct = ((e.clientY - rect.top) / rect.height) * 100
      setLogHeightPercent(Math.min(80, Math.max(20, pct)))
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
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
  }

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

  function handleConfirmAndExecute() {
    const prompt = generatedPrompt.trim()
    if (!prompt) return
    setPromptState('idle')
    setInstruction('')
    setGeneratedPrompt('')
    setFeedback('')
    runInstruction(prompt)
  }

  function handleCancelConfirm() {
    setPromptState('idle')
    setGeneratedPrompt('')
    setFeedback('')
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
    task?.status === 'idle' && !streaming && !generating && instruction.trim().length > 0 && promptState === 'idle'

  const showStopButton =
    task && (task.status === 'running' || task.status === 'idle' || task.status === 'testing')

  const statusMessage = task ? getIdleStatusMessage(task.status) : null

  if (taskError && !task) {
    return (
      <>
        <header className="app-header">
          <h1>Karakuri</h1>
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
          <h1>Karakuri</h1>
        </header>
        <div className="loading-state">読み込み中...</div>
      </>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      {/* Top bar */}
      <header className="app-header">
        <h1>Karakuri</h1>
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
          {/* Running status banner */}
          {(streaming || task.status === 'running' || task.status === 'initializing' || generating) && (
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
              {generating
                ? 'プロンプト生成中...'
                : task.status === 'initializing'
                ? 'コンテナを準備中... (30秒〜1分かかります)'
                : '実行中... (完了まで1〜3分かかることがあります)'}
            </div>
          )}

          {/* Log Viewer */}
          <div className="log-viewer" ref={logViewerRef} style={{ flex: `0 0 ${logHeightPercent}%` }}>
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

          <div className="resize-handle" onMouseDown={handleResizeStart} />

          {/* Instruction Input Panel */}
          <div className="instruction-panel" style={{ flex: `0 0 ${100 - logHeightPercent}%` }}>
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
                    onClick={handleGeneratePrompt}
                    disabled={!canGenerate}
                  >
                    プロンプトを生成
                  </button>
                  {(streaming || task.status !== 'idle') && statusMessage && (
                    <span className="instruction-status">{statusMessage}</span>
                  )}
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
