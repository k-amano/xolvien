import { useEffect, useRef, useState } from 'react'
import type { Upload } from '../types'
import { getRepositoryUploads, uploadRepositoryFiles, deleteRepositoryUpload } from '../services/api'
import { useLang } from '../i18n'

// Repository-scoped file attachments (spec/design docs, mockups). Uploaded
// files persist with the repository (not a single task) and are referenced
// by every fix-task of the project — attaching once from any task's input
// makes the file available to all of them.
//
// Split into a hook + two small pieces of UI so the button can live in the
// instruction textarea's Markdown toolbar (next to Bold/Italic/...) while the
// chip list renders just above the textarea — the GitHub-Issue-comment-box
// layout, instead of a separate "Reference files" strip.
//
// repositoryId may be undefined while the task is still loading; the hook is
// a no-op until a real id is available (safe to call unconditionally at the
// top of a component, per the rules of hooks).
export function useRepositoryUploads(repositoryId: number | undefined) {
  const { t } = useLang()
  const [uploads, setUploads] = useState<Upload[]>([])
  // Which uploads the NEXT message will reference. Files stay stored with the
  // repository either way; this only controls what gets attached per message.
  // New/loaded files default to selected (ON).
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!repositoryId) { setUploads([]); setSelectedIds(new Set()); return }
    let cancelled = false
    getRepositoryUploads(repositoryId)
      .then(u => {
        if (cancelled) return
        setUploads(u)
        setSelectedIds(new Set(u.map(x => x.id)))
      })
      .catch(() => { /* empty/missing is fine */ })
    return () => { cancelled = true }
  }, [repositoryId])

  async function handleFiles(fileList: FileList | null) {
    if (!repositoryId || !fileList || fileList.length === 0) return
    setBusy(true)
    setError(null)
    try {
      const added = await uploadRepositoryFiles(repositoryId, Array.from(fileList))
      setUploads(prev => [...prev, ...added])
      setSelectedIds(prev => new Set([...prev, ...added.map(a => a.id)]))
    } catch {
      setError(t.uploadFailed)
    } finally {
      setBusy(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  async function handleRemove(uploadId: number) {
    if (!repositoryId) return
    try {
      await deleteRepositoryUpload(repositoryId, uploadId)
      setUploads(prev => prev.filter(u => u.id !== uploadId))
      setSelectedIds(prev => { const next = new Set(prev); next.delete(uploadId); return next })
    } catch {
      setError(t.uploadDeleteFailed)
    }
  }

  function toggleSelect(uploadId: number) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(uploadId)) next.delete(uploadId)
      else next.add(uploadId)
      return next
    })
  }

  return { uploads, selectedIds, toggleSelect, busy, error, inputRef, handleFiles, handleRemove }
}

export type RepositoryUploadsState = ReturnType<typeof useRepositoryUploads>

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// Icon button for a toolbar (Markdown toolbar, etc.) + the hidden file input.
export function AttachFilesButton({ state, disabled }: { state: RepositoryUploadsState; disabled?: boolean }) {
  const { t } = useLang()
  return (
    <>
      <button
        type="button"
        title={t.attachFiles}
        onClick={() => state.inputRef.current?.click()}
        disabled={disabled || state.busy}
        style={{
          background: 'none',
          border: '1px solid transparent',
          borderRadius: '4px',
          color: '#8b949e',
          padding: '2px 6px',
          fontSize: '0.85rem',
          cursor: disabled || state.busy ? 'default' : 'pointer',
          lineHeight: 1,
          opacity: state.busy ? 0.6 : 1,
        }}
        onMouseEnter={e => { if (!disabled && !state.busy) (e.currentTarget as HTMLButtonElement).style.background = '#21262d' }}
        onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'none' }}
      >
        📎
      </button>
      <input
        ref={state.inputRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={e => state.handleFiles(e.target.files)}
      />
    </>
  )
}

// Chip list rendered just above the textarea (attached-to-this-project files),
// mirroring where a comment box shows files you've dropped into it.
export function AttachedFilesChips({ state, compact }: { state: RepositoryUploadsState; compact?: boolean }) {
  const { t } = useLang()
  if (state.uploads.length === 0 && !state.error) return null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', padding: '6px 8px 0' }}>
      {state.error && (
        <div style={{ fontSize: '0.78rem', color: '#fca5a5' }}>{state.error}</div>
      )}
      {state.uploads.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
          <span style={{ fontSize: '0.72rem', color: '#6e7681', alignSelf: 'center' }}>
            {t.repoAttachments}:
          </span>
          {state.uploads.map(u => {
            const selected = state.selectedIds.has(u.id)
            return (
              <span
                key={u.id}
                role="checkbox"
                aria-checked={selected}
                onClick={() => state.toggleSelect(u.id)}
                title={`${u.filename} · ${formatSize(u.size)} — ${selected ? t.uploadRefOn : t.uploadRefOff}`}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: '6px',
                  background: selected ? '#0d1117' : 'transparent',
                  border: selected ? '1px solid #388bfd' : '1px dashed #30363d',
                  borderRadius: '14px',
                  padding: compact ? '2px 8px' : '4px 10px', fontSize: '0.78rem',
                  color: selected ? '#c9d1d9' : '#6e7681',
                  opacity: selected ? 1 : 0.6,
                  maxWidth: '220px',
                  cursor: 'pointer',
                  userSelect: 'none',
                }}
              >
                <span aria-hidden style={{ fontSize: '0.72rem', lineHeight: 1 }}>
                  {selected ? '✓' : '○'}
                </span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {u.filename}
                </span>
                <button
                  type="button"
                  onClick={e => { e.stopPropagation(); state.handleRemove(u.id) }}
                  title={t.uploadRemove}
                  style={{
                    background: 'none', border: 'none', color: '#8b949e', cursor: 'pointer',
                    fontSize: '0.9rem', lineHeight: 1, padding: 0,
                  }}
                >
                  ×
                </button>
              </span>
            )
          })}
        </div>
      )}
    </div>
  )
}
