import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Task, TaskStatus } from '../types'
import { getTasks, deleteTask } from '../services/api'
import { useLang } from '../i18n'

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

export default function Dashboard() {
  const navigate = useNavigate()
  const { t, lang, setLang } = useLang()
  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [deletingIds, setDeletingIds] = useState<Set<number>>(new Set())

  function getStatusLabel(status: TaskStatus): string {
    switch (status) {
      case 'pending':
        return t.statusPending
      case 'initializing':
        return t.statusInitializing
      case 'idle':
        return t.statusIdle
      case 'running':
        return t.statusRunning
      case 'testing':
        return t.statusTesting
      case 'completed':
        return t.statusCompleted
      default:
        return status
    }
  }

  function formatDate(dateStr: string): string {
    try {
      const date = new Date(dateStr)
      return date.toLocaleString(lang === 'en' ? 'en-US' : 'ja-JP', {
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

  const fetchTasks = useCallback(async () => {
    try {
      const data = await getTasks()
      setTasks(data)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : t.fetchTasksFailed)
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    fetchTasks()
    const interval = setInterval(fetchTasks, 3000)
    return () => clearInterval(interval)
  }, [fetchTasks])

  async function handleDelete(e: React.MouseEvent, taskId: number) {
    e.stopPropagation()
    if (!window.confirm(t.deleteConfirm)) return
    setDeletingIds(prev => new Set(prev).add(taskId))
    try {
      await deleteTask(taskId)
      setTasks(prev => prev.filter(task => task.id !== taskId))
    } catch (err) {
      alert(err instanceof Error ? err.message : t.deleteFailed)
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
        <h1>{t.appName}</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <button
            className="btn-secondary btn-sm"
            onClick={() => setLang(lang === 'ja' ? 'en' : 'ja')}
            style={{ marginRight: '8px', fontFamily: 'monospace', fontWeight: 600, minWidth: '36px' }}
          >
            {lang === 'ja' ? t.langEn : t.langJa}
          </button>
          <button
            className="btn-primary"
            onClick={() => navigate('/tasks/new')}
          >
            {t.newTask}
          </button>
        </div>
      </header>

      <div className="page-content">
        <div className="dashboard-header">
          <h2>{t.taskList}</h2>
        </div>

        {error && <div className="error-banner">{error}</div>}

        {loading ? (
          <div className="loading-state">{t.loading}</div>
        ) : tasks.length === 0 ? (
          <div className="empty-state">
            <p>{t.noTasks}</p>
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
                    title={t.deleteBtn}
                  >
                    {deletingIds.has(task.id) ? t.deleting : t.deleteBtn}
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
