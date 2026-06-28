import { useEffect, useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import type { Repository } from '../types'
import { getRepositories, createRepository, createGitHubRepository, createTask } from '../services/api'
import { RepositoryUploads } from '../components/RepositoryUploads'
import { useLang } from '../i18n'

type RepoMode = 'existing' | 'new' | 'github'

interface FormErrors {
  repoId?: string
  repoUrl?: string
  repoName?: string
  title?: string
  branchName?: string
}

export default function TaskCreate() {
  const navigate = useNavigate()
  const { t, lang, setLang } = useLang()
  const [repositories, setRepositories] = useState<Repository[]>([])
  const [repoMode, setRepoMode] = useState<RepoMode>('existing')
  const [selectedRepoId, setSelectedRepoId] = useState<string>('')
  const [newRepoUrl, setNewRepoUrl] = useState('')
  const [newRepoName, setNewRepoName] = useState('')
  const [newRepoDescription, setNewRepoDescription] = useState('')
  const [githubRepoName, setGithubRepoName] = useState('')
  const [githubRepoDesc, setGithubRepoDesc] = useState('')
  const [githubPrivate, setGithubPrivate] = useState(false)
  const [githubCreating, setGithubCreating] = useState(false)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [branchName, setBranchName] = useState('')
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
        errs.repoId = t.validationSelectRepo
      }
    } else if (repoMode === 'new') {
      if (!newRepoUrl.trim()) {
        errs.repoUrl = t.validationRepoUrl
      }
      if (!newRepoName.trim()) {
        errs.repoName = t.validationRepoName
      }
    } else {
      if (!githubRepoName.trim()) {
        errs.repoName = t.validationRepoName
      }
    }

    if (!title.trim()) {
      errs.title = t.validationTitle
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
      } else if (repoMode === 'github') {
        setGithubCreating(true)
        let repo: Repository
        try {
          repo = await createGitHubRepository({
            name: githubRepoName.trim(),
            description: githubRepoDesc.trim() || undefined,
            private: githubPrivate,
          })
        } finally {
          setGithubCreating(false)
        }
        repositoryId = repo.id
      } else {
        repositoryId = parseInt(selectedRepoId, 10)
      }

      const task = await createTask({
        repository_id: repositoryId,
        title: title.trim(),
        description: description.trim() || undefined,
        branch_name: branchName.trim() || undefined,
      })

      navigate(`/tasks/${task.id}`)
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { detail?: string }; status?: number } }
      if (axiosErr.response?.status === 503) {
        setSubmitError(t.githubTokenNotSet)
      } else if (axiosErr.response?.data?.detail) {
        setSubmitError(`${t.githubError}${axiosErr.response.data.detail}`)
      } else {
        setSubmitError(err instanceof Error ? err.message : t.createTaskFailed)
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <header className="app-header">
        <h1>{t.appName}</h1>
        <button
          className="btn-secondary btn-sm"
          onClick={() => setLang(lang === 'ja' ? 'en' : 'ja')}
          style={{ marginRight: '8px', fontFamily: 'monospace', fontWeight: 600, minWidth: '36px' }}
        >
          {lang === 'ja' ? t.langEn : t.langJa}
        </button>
      </header>

      <div className="page-content">
        <Link to="/" className="back-link">
          {t.back}
        </Link>

        <div className="form-page-header">
          <h2>{t.createTaskTitle}</h2>
          <p>{t.createTaskSubtitle}</p>
        </div>

        <div className="form-card">
          {submitError && (
            <div className="error-banner">{submitError}</div>
          )}

          <form onSubmit={handleSubmit} noValidate>
            {/* Repository section */}
            <div style={{ marginBottom: '24px' }}>
              <div className="form-section-title">{t.repository}</div>

              <div className="form-toggle">
                <button
                  type="button"
                  className={repoMode === 'existing' ? 'active' : ''}
                  onClick={() => setRepoMode('existing')}
                  disabled={loadingRepos}
                >
                  {t.selectExisting}
                </button>
                <button
                  type="button"
                  className={repoMode === 'new' ? 'active' : ''}
                  onClick={() => setRepoMode('new')}
                >
                  {t.addNew}
                </button>
                <button
                  type="button"
                  className={repoMode === 'github' ? 'active' : ''}
                  onClick={() => setRepoMode('github')}
                >
                  {t.createOnGitHub}
                </button>
              </div>

              {repoMode === 'github' ? (
                <>
                  <div className="form-group">
                    <label className="form-label">
                      {t.githubRepoName} <span className="required">{t.required}</span>
                    </label>
                    <input
                      type="text"
                      className="form-input"
                      value={githubRepoName}
                      onChange={e => setGithubRepoName(e.target.value)}
                      placeholder={t.repoNamePlaceholder}
                    />
                    {errors.repoName && (
                      <p className="form-error">{errors.repoName}</p>
                    )}
                  </div>

                  <div className="form-group">
                    <label className="form-label">{t.githubRepoDesc}</label>
                    <input
                      type="text"
                      className="form-input"
                      value={githubRepoDesc}
                      onChange={e => setGithubRepoDesc(e.target.value)}
                      placeholder={t.repoDescPlaceholder}
                    />
                  </div>

                  <div className="form-group" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <input
                      type="checkbox"
                      id="github-private"
                      checked={githubPrivate}
                      onChange={e => setGithubPrivate(e.target.checked)}
                    />
                    <label htmlFor="github-private" style={{ color: '#cbd5e1', fontSize: '0.875rem', cursor: 'pointer' }}>
                      {t.githubPrivate}
                    </label>
                  </div>
                </>
              ) : repoMode === 'existing' ? (
                <div className="form-group">
                  <label className="form-label">
                    {t.repoLabel} <span className="required">{t.required}</span>
                  </label>
                  {loadingRepos ? (
                    <p style={{ color: '#94a3b8', fontSize: '0.875rem' }}>
                      {t.loading}
                    </p>
                  ) : repositories.length === 0 ? (
                    <p style={{ color: '#94a3b8', fontSize: '0.875rem' }}>
                      {t.noRepos}
                    </p>
                  ) : (
                    <select
                      className="form-select"
                      value={selectedRepoId}
                      onChange={e => setSelectedRepoId(e.target.value)}
                    >
                      <option value="">{t.selectRepoPlaceholder}</option>
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
                  {selectedRepoId && (
                    <div style={{ marginTop: '10px' }}>
                      <label className="form-label">{t.repoAttachments}</label>
                      <RepositoryUploads repositoryId={parseInt(selectedRepoId, 10)} />
                    </div>
                  )}
                </div>
              ) : (
                <>
                  <div className="form-group">
                    <label className="form-label">
                      {t.repoUrlLabel} <span className="required">{t.required}</span>
                    </label>
                    <input
                      type="url"
                      className="form-input"
                      value={newRepoUrl}
                      onChange={e => setNewRepoUrl(e.target.value)}
                      placeholder={t.repoUrlPlaceholder}
                    />
                    {errors.repoUrl && (
                      <p className="form-error">{errors.repoUrl}</p>
                    )}
                  </div>

                  <div className="form-group">
                    <label className="form-label">
                      {t.repoNameLabel} <span className="required">{t.required}</span>
                    </label>
                    <input
                      type="text"
                      className="form-input"
                      value={newRepoName}
                      onChange={e => setNewRepoName(e.target.value)}
                      placeholder={t.repoNamePlaceholder}
                    />
                    {errors.repoName && (
                      <p className="form-error">{errors.repoName}</p>
                    )}
                  </div>

                  <div className="form-group">
                    <label className="form-label">{t.repoDescLabel}</label>
                    <input
                      type="text"
                      className="form-input"
                      value={newRepoDescription}
                      onChange={e => setNewRepoDescription(e.target.value)}
                      placeholder={t.repoDescPlaceholder}
                    />
                  </div>
                </>
              )}
            </div>

            {/* Task section */}
            <div>
              <div className="form-section-title">{t.taskDetails}</div>

              <div className="form-group">
                <label className="form-label">
                  {t.taskTitleLabel} <span className="required">{t.required}</span>
                </label>
                <input
                  type="text"
                  className="form-input"
                  value={title}
                  onChange={e => setTitle(e.target.value)}
                  placeholder={t.taskTitlePlaceholder}
                />
                {errors.title && (
                  <p className="form-error">{errors.title}</p>
                )}
              </div>

              <div className="form-group">
                <label className="form-label">{t.branchNameLabel}</label>
                <input
                  type="text"
                  className="form-input"
                  value={branchName}
                  onChange={e => setBranchName(e.target.value)}
                  placeholder={t.branchNamePlaceholder}
                />
              </div>

              <div className="form-group">
                <label className="form-label">{t.taskDescLabel}</label>
                <textarea
                  className="form-textarea"
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  placeholder={t.taskDescPlaceholder}
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
                {githubCreating
                  ? t.githubCreating
                  : submitting
                  ? t.creating
                  : t.createTaskBtn}
              </button>
              <Link to="/">
                <button type="button" className="btn-secondary">
                  {t.cancel}
                </button>
              </Link>
            </div>
          </form>
        </div>
      </div>
    </>
  )
}
