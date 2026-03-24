export type TaskStatus =
  | 'pending'
  | 'initializing'
  | 'idle'
  | 'running'
  | 'testing'
  | 'completed'
  | 'failed'
  | 'stopped'

export type LogLevel = 'debug' | 'info' | 'warning' | 'error' | 'critical'
export type LogSource = 'system' | 'docker' | 'claude' | 'git' | 'test'

export interface Repository {
  id: number
  name: string
  url: string
  description?: string
  default_branch: string
  created_at: string
  updated_at: string
}

export interface Task {
  id: number
  title: string
  description?: string
  status: TaskStatus
  branch_name: string
  repository_id: number
  container_id?: string
  container_name?: string
  workspace_path?: string
  owner_id: number
  created_at: string
  updated_at: string
  started_at?: string
  completed_at?: string
}

export interface TaskLog {
  id: number
  task_id: number
  level: LogLevel
  source: LogSource
  message: string
  created_at: string
}
