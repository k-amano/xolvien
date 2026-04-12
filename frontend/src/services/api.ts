import axios from 'axios'
import type { Repository, Task, TaskLog } from '../types'

const AUTH_TOKEN = 'dev-token-12345'

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

export async function gitPushStream(
  taskId: number,
  onChunk: (text: string) => void,
  onDone: () => void,
  onError: (err: string) => void
): Promise<void> {
  try {
    const response = await fetch(`/api/v1/tasks/${taskId}/git/push`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    })

    if (!response.ok) {
      const text = await response.text()
      onError(`HTTP ${response.status}: ${text}`)
      return
    }

    if (!response.body) {
      onError('No response body')
      return
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = decoder.decode(value, { stream: true })
      if (chunk) onChunk(chunk)
    }
    onDone()
  } catch (err) {
    onError(err instanceof Error ? err.message : String(err))
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
  onError: (err: string) => void
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
        body: JSON.stringify({ instruction, history }),
      }
    )

    if (!response.ok) {
      const text = await response.text()
      onError(`HTTP ${response.status}: ${text}`)
      return
    }

    if (!response.body) {
      onError('No response body')
      return
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = decoder.decode(value, { stream: true })
      if (chunk) onChunk(chunk)
    }
    onDone()
  } catch (err) {
    onError(err instanceof Error ? err.message : String(err))
  }
}

export async function generatePromptStream(
  taskId: number,
  content: string,
  feedback: string,
  onChunk: (text: string) => void,
  onDone: () => void,
  onError: (err: string) => void
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
        body: JSON.stringify({ content, feedback: feedback || null }),
      }
    )

    if (!response.ok) {
      const text = await response.text()
      onError(`HTTP ${response.status}: ${text}`)
      return
    }

    if (!response.body) {
      onError('No response body')
      return
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = decoder.decode(value, { stream: true })
      if (chunk) onChunk(chunk)
    }

    onDone()
  } catch (err) {
    onError(err instanceof Error ? err.message : String(err))
  }
}

export async function generateTestCasesStream(
  taskId: number,
  implementationPrompt: string,
  onChunk: (text: string) => void,
  onDone: () => void,
  onError: (err: string) => void
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
        body: JSON.stringify({ implementation_prompt: implementationPrompt }),
      }
    )

    if (!response.ok) {
      const text = await response.text()
      onError(`HTTP ${response.status}: ${text}`)
      return
    }

    if (!response.body) {
      onError('No response body')
      return
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = decoder.decode(value, { stream: true })
      if (chunk) onChunk(chunk)
    }
    onDone()
  } catch (err) {
    onError(err instanceof Error ? err.message : String(err))
  }
}

export async function runUnitTestsStream(
  taskId: number,
  implementationPrompt: string,
  testCases: string,
  onChunk: (text: string) => void,
  onDone: () => void,
  onError: (err: string) => void
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
        body: JSON.stringify({ implementation_prompt: implementationPrompt, test_cases: testCases }),
      }
    )

    if (!response.ok) {
      const text = await response.text()
      onError(`HTTP ${response.status}: ${text}`)
      return
    }

    if (!response.body) {
      onError('No response body')
      return
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = decoder.decode(value, { stream: true })
      if (chunk) onChunk(chunk)
    }
    onDone()
  } catch (err) {
    onError(err instanceof Error ? err.message : String(err))
  }
}

export async function executeInstructionStream(
  taskId: number,
  content: string,
  onChunk: (text: string) => void,
  onDone: () => void,
  onError: (err: string) => void
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

    if (!response.ok) {
      const text = await response.text()
      onError(`HTTP ${response.status}: ${text}`)
      return
    }

    if (!response.body) {
      onError('No response body')
      return
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = decoder.decode(value, { stream: true })
      if (chunk) {
        onChunk(chunk)
      }
    }

    onDone()
  } catch (err) {
    onError(err instanceof Error ? err.message : String(err))
  }
}
