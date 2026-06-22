import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

// Catches unhandled exceptions thrown during React rendering and shows a
// recovery screen instead of a blank page. This is the last-resort net for
// render-time bugs — operational/API errors are handled by the cause-based
// error banner in TaskDetail. Kept self-contained (no context/i18n deps) so it
// still renders even if the surrounding tree is broken.
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Surface the technical detail to the console only — never to the user.
    console.error('Unhandled render error:', error, info.componentStack)
  }

  handleReload = () => {
    window.location.reload()
  }

  handleHome = () => {
    window.location.href = '/'
  }

  render() {
    if (!this.state.hasError) return this.props.children

    return (
      <div
        role="alert"
        style={{
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '16px',
          padding: '24px',
          background: '#0d1117',
          color: '#e6edf3',
          textAlign: 'center',
        }}
      >
        <div style={{ fontSize: '2.5rem', lineHeight: 1 }}>⛔</div>
        <div style={{ fontSize: '1.1rem', fontWeight: 700 }}>
          A problem occurred / 問題が発生しました
        </div>
        <div style={{ fontSize: '0.9rem', color: '#8b949e', maxWidth: '420px', lineHeight: 1.6 }}>
          The screen could not be displayed. Reloading usually fixes it.
          <br />
          画面を表示できませんでした。再読み込みすると解消することがあります。
        </div>
        <div style={{ display: 'flex', gap: '10px', marginTop: '8px' }}>
          <button
            onClick={this.handleReload}
            style={{
              background: '#2563eb', color: '#fff', border: 'none', borderRadius: '6px',
              padding: '8px 18px', fontSize: '0.85rem', fontWeight: 600, cursor: 'pointer',
            }}
          >
            Reload / 再読み込み
          </button>
          <button
            onClick={this.handleHome}
            style={{
              background: 'transparent', color: '#e6edf3', border: '1px solid #30363d',
              borderRadius: '6px', padding: '8px 18px', fontSize: '0.85rem', fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Home / ホーム
          </button>
        </div>
      </div>
    )
  }
}
