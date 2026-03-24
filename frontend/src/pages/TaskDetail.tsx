import { useEffect, useRef, useState, useCallback } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import type { Task, TaskLog, TaskStatus, LogLevel } from '../types'
import { getTask, getLogs, stopTask, executeInstructionStream } from '../services/api'

const AUTH_TOKEN = 'dev-token-12345'

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

  const logViewerRef = useRef<HTMLDivElement>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const seenLogIdsRef = useRef<Set<number>>(new Set())
  const streamKeyRef = useRef(0)

  // Auto-scroll log viewer
  const scrollToBottom = useCallback(() => {
    const el = logViewerRef.current
    if (el) {
      el.scrollTop = el.scrollHeight
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
    getLogs(taskId)
      .then(logs => {
        const entries: LogEntry[] = logs.map(log => {
          seenLogIdsRef.current.add(log.id)
          return { kind: 'log', data: log }
        })
        setLogEntries(entries)
      })
      .catch(err => {
        console.error('Failed to fetch logs:', err)
      })
  }, [taskId])

  // WebSocket for real-time logs
  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const host = window.location.host
    const wsUrl = `${protocol}//${host}/api/v1/ws/tasks/${taskId}/logs`

    const ws = new WebSocket(wsUrl, ['Authorization', `Bearer ${AUTH_TOKEN}`])
    wsRef.current = ws

    ws.onopen = () => {
      console.log('WebSocket connected for task', taskId)
    }

    ws.onmessage = (event: MessageEvent) => {
      try {
        const log: TaskLog = JSON.parse(event.data as string)
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

  async function handleExecute() {
    if (!instruction.trim() || streaming) return
    const content = instruction.trim()
    setInstruction('')
    setStreaming(true)

    // Create a stream key for this execution session
    streamKeyRef.current += 1
    const currentKey = `stream-${streamKeyRef.current}`

    // Add an initial stream entry
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
      () => {
        setStreaming(false)
      },
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

  const canExecute =
    task?.status === 'idle' && !streaming && instruction.trim().length > 0

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

        <div className="task-detail-body">
          {/* Log Viewer */}
          <div className="log-viewer" ref={logViewerRef}>
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
                  return entry.text ? (
                    <p key={entry.key} className="log-stream-chunk">
                      {entry.text}
                    </p>
                  ) : null
                }
              })
            )}
          </div>

          <div className="resize-handle" />

          {/* Instruction Input Panel */}
          <div className="instruction-panel">
            <p className="instruction-panel-title">Claudeへの指示</p>

            <textarea
              className="instruction-textarea"
              value={instruction}
              onChange={e => setInstruction(e.target.value)}
              placeholder={
                'Claudeへの指示を入力してください...\n例: シンプルな翻訳アプリを作ってください'
              }
              disabled={streaming || task.status !== 'idle'}
              onKeyDown={e => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault()
                  if (canExecute) handleExecute()
                }
              }}
              rows={4}
            />

            <div className="instruction-footer">
              <button
                className="btn-primary"
                onClick={handleExecute}
                disabled={!canExecute}
              >
                {streaming ? (
                  <>
                    <span className="spinner" />
                    実行中...
                  </>
                ) : (
                  '実行'
                )}
              </button>

              {(streaming || task.status !== 'idle') && statusMessage && (
                <span className="instruction-status">{statusMessage}</span>
              )}

              {streaming && (
                <span className="instruction-status">ストリーミング中...</span>
              )}

              <span
                style={{
                  marginLeft: 'auto',
                  fontSize: '0.75rem',
                  color: '#94a3b8',
                }}
              >
                Ctrl+Enter で実行
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
