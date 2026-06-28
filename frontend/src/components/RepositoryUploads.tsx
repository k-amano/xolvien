import { useEffect, useRef, useState } from 'react'
import type { Upload } from '../types'
import { getRepositoryUploads, uploadRepositoryFiles, deleteRepositoryUpload } from '../services/api'
import { useLang } from '../i18n'

interface Props {
  repositoryId: number
  // Compact mode renders a tighter layout (used inside the task detail panel).
  compact?: boolean
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// Repository-scoped file attachments (spec/design docs, mockups). Uploaded files
// persist with the repository and are referenced by every fix-task of the project.
export function RepositoryUploads({ repositoryId, compact }: Props) {
  const { t } = useLang()
  const [uploads, setUploads] = useState<Upload[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let cancelled = false
    getRepositoryUploads(repositoryId)
      .then(u => { if (!cancelled) setUploads(u) })
      .catch(() => { /* empty/missing is fine */ })
    return () => { cancelled = true }
  }, [repositoryId])

  async function handleFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return
    setBusy(true)
    setError(null)
    try {
      const added = await uploadRepositoryFiles(repositoryId, Array.from(fileList))
      setUploads(prev => [...prev, ...added])
    } catch {
      setError(t.uploadFailed)
    } finally {
      setBusy(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  async function handleRemove(uploadId: number) {
    try {
      await deleteRepositoryUpload(repositoryId, uploadId)
      setUploads(prev => prev.filter(u => u.id !== uploadId))
    } catch {
      setError(t.uploadDeleteFailed)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <button
          type="button"
          className="btn-secondary btn-sm"
          onClick={() => inputRef.current?.click()}
          disabled={busy}
        >
          📎 {busy ? t.uploading : t.attachFiles}
        </button>
        <span style={{ fontSize: '0.72rem', color: '#8b949e' }}>{t.uploadHint}</span>
        <input
          ref={inputRef}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={e => handleFiles(e.target.files)}
        />
      </div>

      {error && (
        <div style={{ fontSize: '0.78rem', color: '#fca5a5' }}>{error}</div>
      )}

      {uploads.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
          {uploads.map(u => (
            <span
              key={u.id}
              title={`${u.filename} · ${formatSize(u.size)}`}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: '6px',
                background: '#0d1117', border: '1px solid #30363d', borderRadius: '14px',
                padding: compact ? '2px 8px' : '4px 10px', fontSize: '0.78rem', color: '#c9d1d9',
                maxWidth: '220px',
              }}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {u.filename}
              </span>
              <button
                type="button"
                onClick={() => handleRemove(u.id)}
                title={t.uploadRemove}
                style={{
                  background: 'none', border: 'none', color: '#8b949e', cursor: 'pointer',
                  fontSize: '0.9rem', lineHeight: 1, padding: 0,
                }}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
