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

export type TestType = 'unit' | 'integration' | 'e2e'

export interface TestRun {
  id: number
  task_id: number
  test_type: TestType
  test_command: string | null
  test_cases: string | null
  exit_code: number | null
  passed: boolean
  retry_count: number
  output: string | null
  error_output: string | null
  summary: string | null
  report_path: string | null
  created_at: string
  started_at: string | null
  completed_at: string | null
}

export type Verdict = 'PASSED' | 'FAILED' | 'ERROR' | 'SKIPPED'

export interface TestCaseResult {
  id: number
  test_case_item_id: number
  test_run_id: number
  actual_output: string | null
  verdict: Verdict | null
  executed_at: string
}

export interface TestCaseItem {
  id: number
  task_id: number
  seq_no: number
  tc_id: string
  target_screen: string | null
  test_item: string
  operation: string | null
  expected_output: string | null
  function_name: string | null
  created_at: string
  latest_result: TestCaseResult | null
}

export interface Instruction {
  id: number
  task_id: number
  content: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  output: string | null
  error_message: string | null
  exit_code: number | null
  created_at: string
  started_at: string | null
  completed_at: string | null
}
