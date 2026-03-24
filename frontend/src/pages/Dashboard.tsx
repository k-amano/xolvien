import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Task, TaskStatus } from '../types'
import { getTasks, deleteTask } from '../services/api'

function getStatusLabel(status: TaskStatus): string {
  switch (status) {
    case 'pending':
      return 'pending'
    case 'initializing':
      return 'initializing'
    case 'idle':
      return 'idle'
    case 'running':
      return 'running'
    case 'testing':
      return 'testing'
    case 'completed':
      return 'completed'
    case 'failed':
      return 'failed'
    case 'stopped':
      return 'stopped'
    default:
      return status
  }
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

function formatDate(dateStr: string): string {
  try {
    const date = new Date(dateStr)
    return date.toLocaleString('ja-JP', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return dateStr
  }
}

export default function Dashboard() {
  const navigate = useNavigate()
  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [deletingIds, setDeletingIds] = useState<Set<number>>(new Set())

  const fetchTasks = useCallback(async () => {
    try {
      const data = await getTasks()
      setTasks(data)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'タスクの取得に失敗しました')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchTasks()
    const interval = setInterval(fetchTasks, 3000)
    return () => clearInterval(interval)
  }, [fetchTasks])

  async function handleDelete(e: React.MouseEvent, taskId: number) {
    e.stopPropagation()
    if (!window.confirm('このタスクを削除しますか？')) return
    setDeletingIds(prev => new Set(prev).add(taskId))
    try {
      await deleteTask(taskId)
      setTasks(prev => prev.filter(t => t.id !== taskId))
    } catch (err) {
      alert(err instanceof Error ? err.message : '削除に失敗しました')
    } finally {
      setDeletingIds(prev => {
        const next = new Set(prev)
        next.delete(taskId)
        return next
      })
    }
  }

  return (
    <>
      <header className="app-header">
        <h1>Karakuri</h1>
        <button
          className="btn-primary"
          onClick={() => navigate('/tasks/new')}
        >
          新しいタスク
        </button>
      </header>

      <div className="page-content">
        <div className="dashboard-header">
          <h2>タスク一覧</h2>
        </div>

        {error && <div className="error-banner">{error}</div>}

        {loading ? (
          <div className="loading-state">読み込み中...</div>
        ) : tasks.length === 0 ? (
          <div className="empty-state">
            <p>タスクがありません。新しいタスクを作成してください。</p>
          </div>
        ) : (
          <div className="task-list">
            {tasks.map(task => (
              <div
                key={task.id}
                className="task-card"
                onClick={() => navigate(`/tasks/${task.id}`)}
              >
                <div className="task-card-main">
                  <div className="task-card-title">{task.title}</div>
                  <div className="task-card-meta">
                    <span className={getStatusClass(task.status)}>
                      {getStatusLabel(task.status)}
                    </span>
                    <span className="task-card-branch">
                      {task.branch_name}
                    </span>
                    <span className="task-card-date">
                      {formatDate(task.created_at)}
                    </span>
                  </div>
                </div>
                <div className="task-card-actions">
                  <button
                    className="btn-danger btn-sm"
                    onClick={e => handleDelete(e, task.id)}
                    disabled={deletingIds.has(task.id)}
                    title="削除"
                  >
                    {deletingIds.has(task.id) ? '削除中...' : '削除'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  )
}
