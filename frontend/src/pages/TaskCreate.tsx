import { useEffect, useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import type { Repository } from '../types'
import { getRepositories, createRepository, createTask } from '../services/api'

type RepoMode = 'existing' | 'new'

interface FormErrors {
  repoId?: string
  repoUrl?: string
  repoName?: string
  title?: string
  branchName?: string
}

export default function TaskCreate() {
  const navigate = useNavigate()
  const [repositories, setRepositories] = useState<Repository[]>([])
  const [repoMode, setRepoMode] = useState<RepoMode>('existing')
  const [selectedRepoId, setSelectedRepoId] = useState<string>('')
  const [newRepoUrl, setNewRepoUrl] = useState('')
  const [newRepoName, setNewRepoName] = useState('')
  const [newRepoDescription, setNewRepoDescription] = useState('')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [branchName, setBranchName] = useState('main')
  const [errors, setErrors] = useState<FormErrors>({})
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [loadingRepos, setLoadingRepos] = useState(true)

  useEffect(() => {
    getRepositories()
      .then(repos => {
        setRepositories(repos)
        if (repos.length === 0) {
          setRepoMode('new')
        }
      })
      .catch(() => {
        setRepoMode('new')
      })
      .finally(() => setLoadingRepos(false))
  }, [])

  function validate(): FormErrors {
    const errs: FormErrors = {}

    if (repoMode === 'existing') {
      if (!selectedRepoId) {
        errs.repoId = 'リポジトリを選択してください'
      }
    } else {
      if (!newRepoUrl.trim()) {
        errs.repoUrl = 'リポジトリURLを入力してください'
      }
      if (!newRepoName.trim()) {
        errs.repoName = 'リポジトリ名を入力してください'
      }
    }

    if (!title.trim()) {
      errs.title = 'タイトルを入力してください'
    }

    if (!branchName.trim()) {
      errs.branchName = 'ブランチ名を入力してください'
    }

    return errs
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitError(null)

    const errs = validate()
    if (Object.keys(errs).length > 0) {
      setErrors(errs)
      return
    }
    setErrors({})
    setSubmitting(true)

    try {
      let repositoryId: number

      if (repoMode === 'new') {
        const repo = await createRepository({
          name: newRepoName.trim(),
          url: newRepoUrl.trim(),
          description: newRepoDescription.trim() || undefined,
        })
        repositoryId = repo.id
      } else {
        repositoryId = parseInt(selectedRepoId, 10)
      }

      const task = await createTask({
        repository_id: repositoryId,
        title: title.trim(),
        description: description.trim() || undefined,
        branch_name: branchName.trim(),
      })

      navigate(`/tasks/${task.id}`)
    } catch (err) {
      setSubmitError(
        err instanceof Error ? err.message : 'タスクの作成に失敗しました'
      )
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <header className="app-header">
        <h1>Karakuri</h1>
      </header>

      <div className="page-content">
        <Link to="/" className="back-link">
          &larr; 戻る
        </Link>

        <div className="form-page-header">
          <h2>新しいタスクを作成</h2>
          <p>リポジトリとタスクの詳細を入力してください</p>
        </div>

        <div className="form-card">
          {submitError && (
            <div className="error-banner">{submitError}</div>
          )}

          <form onSubmit={handleSubmit} noValidate>
            {/* Repository section */}
            <div style={{ marginBottom: '24px' }}>
              <div className="form-section-title">リポジトリ</div>

              <div className="form-toggle">
                <button
                  type="button"
                  className={repoMode === 'existing' ? 'active' : ''}
                  onClick={() => setRepoMode('existing')}
                  disabled={loadingRepos}
                >
                  既存のリポジトリを選択
                </button>
                <button
                  type="button"
                  className={repoMode === 'new' ? 'active' : ''}
                  onClick={() => setRepoMode('new')}
                >
                  新しいリポジトリを追加
                </button>
              </div>

              {repoMode === 'existing' ? (
                <div className="form-group">
                  <label className="form-label">
                    リポジトリ <span className="required">*</span>
                  </label>
                  {loadingRepos ? (
                    <p style={{ color: '#94a3b8', fontSize: '0.875rem' }}>
                      読み込み中...
                    </p>
                  ) : repositories.length === 0 ? (
                    <p style={{ color: '#94a3b8', fontSize: '0.875rem' }}>
                      リポジトリがありません。新しいリポジトリを追加してください。
                    </p>
                  ) : (
                    <select
                      className="form-select"
                      value={selectedRepoId}
                      onChange={e => setSelectedRepoId(e.target.value)}
                    >
                      <option value="">-- リポジトリを選択 --</option>
                      {repositories.map(repo => (
                        <option key={repo.id} value={repo.id}>
                          {repo.name} ({repo.url})
                        </option>
                      ))}
                    </select>
                  )}
                  {errors.repoId && (
                    <p className="form-error">{errors.repoId}</p>
                  )}
                </div>
              ) : (
                <>
                  <div className="form-group">
                    <label className="form-label">
                      リポジトリURL <span className="required">*</span>
                    </label>
                    <input
                      type="url"
                      className="form-input"
                      value={newRepoUrl}
                      onChange={e => setNewRepoUrl(e.target.value)}
                      placeholder="https://github.com/user/repo.git"
                    />
                    {errors.repoUrl && (
                      <p className="form-error">{errors.repoUrl}</p>
                    )}
                  </div>

                  <div className="form-group">
                    <label className="form-label">
                      リポジトリ名 <span className="required">*</span>
                    </label>
                    <input
                      type="text"
                      className="form-input"
                      value={newRepoName}
                      onChange={e => setNewRepoName(e.target.value)}
                      placeholder="my-project"
                    />
                    {errors.repoName && (
                      <p className="form-error">{errors.repoName}</p>
                    )}
                  </div>

                  <div className="form-group">
                    <label className="form-label">説明（任意）</label>
                    <input
                      type="text"
                      className="form-input"
                      value={newRepoDescription}
                      onChange={e => setNewRepoDescription(e.target.value)}
                      placeholder="リポジトリの説明"
                    />
                  </div>
                </>
              )}
            </div>

            {/* Task section */}
            <div>
              <div className="form-section-title">タスク詳細</div>

              <div className="form-group">
                <label className="form-label">
                  タイトル <span className="required">*</span>
                </label>
                <input
                  type="text"
                  className="form-input"
                  value={title}
                  onChange={e => setTitle(e.target.value)}
                  placeholder="タスクのタイトル"
                />
                {errors.title && (
                  <p className="form-error">{errors.title}</p>
                )}
              </div>

              <div className="form-group">
                <label className="form-label">
                  ブランチ名 <span className="required">*</span>
                </label>
                <input
                  type="text"
                  className="form-input"
                  value={branchName}
                  onChange={e => setBranchName(e.target.value)}
                  placeholder="main"
                />
                {errors.branchName && (
                  <p className="form-error">{errors.branchName}</p>
                )}
              </div>

              <div className="form-group">
                <label className="form-label">説明（任意）</label>
                <textarea
                  className="form-textarea"
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  placeholder="タスクの説明"
                  rows={3}
                />
              </div>
            </div>

            <div className="form-actions">
              <button
                type="submit"
                className="btn-primary"
                disabled={submitting}
              >
                {submitting ? (
                  <>
                    <span className="spinner" />
                    作成中...
                  </>
                ) : (
                  'タスクを作成'
                )}
              </button>
              <Link to="/">
                <button type="button" className="btn-secondary">
                  キャンセル
                </button>
              </Link>
            </div>
          </form>
        </div>
      </div>
    </>
  )
}
