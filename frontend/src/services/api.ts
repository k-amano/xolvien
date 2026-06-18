import axios from 'axios'
import type { Repository, Task, TaskLog, TestRun, Instruction, TestCaseItem } from '../types'
import { classifyError, extractSentinel, codeFromBody, type ErrorCode } from '../errors'

const AUTH_TOKEN = 'dev-token-12345'

// Error callback used by every streaming endpoint. The code drives the user-
// facing banner (via i18n errorCatalog); detail is for the log pane only.
export type StreamErrorCb = (code: ErrorCode, detail: string) => void

/**
 * Drive a streaming fetch Response: forward chunks, then resolve the terminal
 * outcome. A `[[XOLVIEN_ERROR:CODE]]` sentinel (emitted by the backend when a
 * stream aborts) is stripped from the displayed text and routed to onError.
 * When `classifyDoneText` is set (git push), the accumulated text is scanned on
 * success for in-stream failures (auth/reject) that arrive with HTTP 200.
 */
async function pumpStream(
  response: Response,
  onChunk: (text: string) => void,
  onDone: () => void,
  onError: StreamErrorCb,
  opts: { classifyDoneText?: boolean } = {}
): Promise<void> {
  if (!response.ok) {
    const text = await response.text()
    onError(codeFromBody(text) ?? classifyError(response.status, text), text)
    return
  }
  if (!response.body) {
    onError('UNKNOWN', 'No response body')
    return
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let accumulated = ''
  let pendingTail = '' // hold back a possible partial sentinel split across reads

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    const chunk = decoder.decode(value, { stream: true })
    if (!chunk) continue
    accumulated += chunk
    // Emit everything except a trailing fragment that might be a partial
    // sentinel line; the sentinel only ever appears as the final line.
    const combined = pendingTail + chunk
    const lastNl = combined.lastIndexOf('\n')
    if (lastNl === -1) {
      pendingTail = combined
    } else {
      const emit = combined.slice(0, lastNl + 1)
      pendingTail = combined.slice(lastNl + 1)
      const { code, cleaned } = extractSentinel(emit)
      if (code) { onChunk(cleaned); onError(code, accumulated); return }
      if (cleaned) onChunk(cleaned)
    }
  }

  // Flush any held-back tail and check it (and the full text) for a sentinel.
  const tail = extractSentinel(pendingTail)
  if (tail.code) { if (tail.cleaned) onChunk(tail.cleaned); onError(tail.code, accumulated); return }
  if (pendingTail) onChunk(pendingTail)

  if (opts.classifyDoneText) {
    const code = classifyError(200, accumulated)
    if (code !== 'UNKNOWN') { onError(code, accumulated); return }
  }
  onDone()
}

const apiClient = axios.create({
  baseURL: '/',
  headers: {
    Authorization: `Bearer ${AUTH_TOKEN}`,
    'Content-Type': 'application/json',
  },
})

export async function getRepositories(): Promise<Repository[]> {
  const res = await apiClient.get<Repository[]>('/api/v1/repositories')
  return res.data
}

export async function createRepository(data: {
  name: string
  url: string
  description?: string
}): Promise<Repository> {
  const res = await apiClient.post<Repository>('/api/v1/repositories', data)
  return res.data
}

export async function createGitHubRepository(data: {
  name: string
  description?: string
  private?: boolean
}): Promise<Repository> {
  const res = await apiClient.post<Repository>('/api/v1/repositories/github', data)
  return res.data
}

export async function getTasks(): Promise<Task[]> {
  const res = await apiClient.get<Task[]>('/api/v1/tasks')
  return res.data
}

export async function getTask(id: number): Promise<Task> {
  const res = await apiClient.get<Task>(`/api/v1/tasks/${id}`)
  return res.data
}

export async function createTask(data: {
  repository_id: number
  title: string
  description?: string
  branch_name?: string
}): Promise<Task> {
  const res = await apiClient.post<Task>('/api/v1/tasks', data)
  return res.data
}

export async function deleteTask(id: number): Promise<void> {
  await apiClient.delete(`/api/v1/tasks/${id}`)
}

export async function stopTask(id: number): Promise<Task> {
  const res = await apiClient.post<Task>(`/api/v1/tasks/${id}/stop`)
  return res.data
}

export async function resetWorkspace(taskId: number): Promise<void> {
  const res = await fetch(`/api/v1/tasks/${taskId}/instructions/reset-workspace`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`HTTP ${res.status}: ${text}`)
  }
}

export async function gitPushStream(
  taskId: number,
  onChunk: (text: string) => void,
  onDone: () => void,
  onError: StreamErrorCb
): Promise<void> {
  try {
    const response = await fetch(`/api/v1/tasks/${taskId}/git/push`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    })
    // git auth/reject failures arrive as in-stream text with HTTP 200, so scan
    // the accumulated output on completion.
    await pumpStream(response, onChunk, onDone, onError, { classifyDoneText: true })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    onError(classifyError(0, msg), msg)
  }
}

export async function getTestRuns(taskId: number): Promise<TestRun[]> {
  const res = await apiClient.get<TestRun[]>(`/api/v1/tasks/${taskId}/test-runs`)
  return res.data
}

export async function getTestCaseItems(taskId: number, testType?: 'unit' | 'integration' | 'e2e'): Promise<TestCaseItem[]> {
  const params = testType ? { test_type: testType } : {}
  const res = await apiClient.get<TestCaseItem[]>(`/api/v1/tasks/${taskId}/test-cases`, { params })
  return res.data
}

export async function getLastCompletedInstruction(taskId: number): Promise<Instruction | null> {
  try {
    const res = await apiClient.get<Instruction>(
      `/api/v1/tasks/${taskId}/instructions/last-completed`
    )
    return res.data
  } catch {
    return null
  }
}

export async function getLogs(taskId: number, limit = 500): Promise<TaskLog[]> {
  const res = await apiClient.get<TaskLog[]>(`/api/v1/tasks/${taskId}/logs`, {
    params: { limit },
  })
  return res.data
}

export async function clarifyStream(
  taskId: number,
  instruction: string,
  history: { role: 'assistant' | 'user'; content: string }[],
  onChunk: (text: string) => void,
  onDone: () => void,
  onError: StreamErrorCb,
  lang: string = 'ja'
): Promise<void> {
  try {
    const response = await fetch(
      `/api/v1/tasks/${taskId}/instructions/clarify`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${AUTH_TOKEN}`,
        },
        body: JSON.stringify({ instruction, history, lang }),
      }
    )

    await pumpStream(response, onChunk, onDone, onError)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    onError(classifyError(0, msg), msg)
  }
}

export async function generatePromptStream(
  taskId: number,
  content: string,
  feedback: string,
  onChunk: (text: string) => void,
  onDone: () => void,
  onError: StreamErrorCb,
  lang: string = 'ja'
): Promise<void> {
  try {
    const response = await fetch(
      `/api/v1/tasks/${taskId}/instructions/generate-prompt`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${AUTH_TOKEN}`,
        },
        body: JSON.stringify({ content, feedback: feedback || null, lang }),
      }
    )

    await pumpStream(response, onChunk, onDone, onError)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    onError(classifyError(0, msg), msg)
  }
}

export async function generateTestCasesStream(
  taskId: number,
  implementationPrompt: string,
  onChunk: (text: string) => void,
  onDone: () => void,
  onError: StreamErrorCb,
  lang: string = 'ja'
): Promise<void> {
  try {
    const response = await fetch(
      `/api/v1/tasks/${taskId}/instructions/generate-test-cases`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${AUTH_TOKEN}`,
        },
        body: JSON.stringify({ implementation_prompt: implementationPrompt, lang }),
      }
    )

    await pumpStream(response, onChunk, onDone, onError)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    onError(classifyError(0, msg), msg)
  }
}

export async function generateIntegrationTestCasesStream(
  taskId: number,
  implementationPrompt: string,
  onChunk: (text: string) => void,
  onDone: () => void,
  onError: StreamErrorCb,
  lang: string = 'ja'
): Promise<void> {
  try {
    const response = await fetch(
      `/api/v1/tasks/${taskId}/instructions/generate-integration-test-cases`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${AUTH_TOKEN}`,
        },
        body: JSON.stringify({ implementation_prompt: implementationPrompt, lang }),
      }
    )

    await pumpStream(response, onChunk, onDone, onError)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    onError(classifyError(0, msg), msg)
  }
}

export async function runUnitTestsStream(
  taskId: number,
  implementationPrompt: string,
  onChunk: (text: string) => void,
  onDone: () => void,
  onError: StreamErrorCb,
  lang: string = 'ja'
): Promise<void> {
  try {
    const response = await fetch(
      `/api/v1/tasks/${taskId}/instructions/run-unit-tests`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${AUTH_TOKEN}`,
        },
        body: JSON.stringify({ implementation_prompt: implementationPrompt, lang }),
      }
    )

    await pumpStream(response, onChunk, onDone, onError)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    onError(classifyError(0, msg), msg)
  }
}

export async function runIntegrationTestsStream(
  taskId: number,
  implementationPrompt: string,
  onChunk: (text: string) => void,
  onDone: () => void,
  onError: StreamErrorCb,
  lang: string = 'ja'
): Promise<void> {
  try {
    const response = await fetch(
      `/api/v1/tasks/${taskId}/instructions/run-integration-tests`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${AUTH_TOKEN}`,
        },
        body: JSON.stringify({ implementation_prompt: implementationPrompt, lang }),
      }
    )

    await pumpStream(response, onChunk, onDone, onError)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    onError(classifyError(0, msg), msg)
  }
}

export async function generateE2ETestCasesStream(
  taskId: number,
  implementationPrompt: string,
  onChunk: (text: string) => void,
  onDone: () => void,
  onError: StreamErrorCb,
  lang: string = 'ja'
): Promise<void> {
  try {
    const response = await fetch(
      `/api/v1/tasks/${taskId}/instructions/generate-e2e-test-cases`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${AUTH_TOKEN}`,
        },
        body: JSON.stringify({ implementation_prompt: implementationPrompt, lang }),
      }
    )

    await pumpStream(response, onChunk, onDone, onError)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    onError(classifyError(0, msg), msg)
  }
}

export async function runE2ETestsStream(
  taskId: number,
  implementationPrompt: string,
  onChunk: (text: string) => void,
  onDone: () => void,
  onError: StreamErrorCb,
  lang: string = 'ja'
): Promise<void> {
  try {
    const response = await fetch(
      `/api/v1/tasks/${taskId}/instructions/run-e2e-tests`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${AUTH_TOKEN}`,
        },
        body: JSON.stringify({ implementation_prompt: implementationPrompt, lang }),
      }
    )

    await pumpStream(response, onChunk, onDone, onError)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    onError(classifyError(0, msg), msg)
  }
}

export async function executeInstructionStream(
  taskId: number,
  content: string,
  onChunk: (text: string) => void,
  onDone: () => void,
  onError: StreamErrorCb
): Promise<void> {
  try {
    const response = await fetch(
      `/api/v1/tasks/${taskId}/instructions/execute-stream`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${AUTH_TOKEN}`,
        },
        body: JSON.stringify({ content }),
      }
    )

    await pumpStream(response, onChunk, onDone, onError)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    onError(classifyError(0, msg), msg)
  }
}
