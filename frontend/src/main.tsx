import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import './styles.css'
import { LangContext, useLangState } from './i18n'
import { ErrorBoundary } from './components/ErrorBoundary'

function LangProvider({ children }: { children: React.ReactNode }) {
  const value = useLangState()
  return <LangContext.Provider value={value}>{children}</LangContext.Provider>
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <LangProvider>
          <App />
        </LangProvider>
      </BrowserRouter>
    </ErrorBoundary>
  </React.StrictMode>
)
