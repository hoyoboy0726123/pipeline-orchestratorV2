export type OutputFormat = 'md' | 'table' | 'json' | 'yaml' | 'csv'

export type MessageRole = 'user' | 'assistant'

export type MessageStatus = 'pending' | 'streaming' | 'done' | 'error'

export interface StepEvent {
  type: 'plan' | 'thinking' | 'tool_call' | 'status' | 'result' | 'done' | 'error'
  message?: string
  plan?: string[]
  tool?: string
  args?: string
  output?: string
  format?: OutputFormat
  step?: string
}

export interface ChatMessage {
  id: string
  role: MessageRole
  content: string
  format: OutputFormat
  status: MessageStatus
  steps: StepEvent[]
  timestamp: Date
}

export interface ScheduledTask {
  id: string
  name: string
  task_prompt: string
  output_format: OutputFormat
  save_path: string | null
  schedule_type: 'cron' | 'interval' | 'once'
  schedule_expr: string
  next_run: string | null
  last_run: string | null
  enabled: boolean
}

export interface FileItem {
  name: string
  path: string
  is_dir: boolean
  size: number
  modified: string
}

export interface OpenCLISite {
  id: string
  name: string
  icon: string
  command: string
}

export interface OpenCLICategory {
  category: string
  sites: OpenCLISite[]
}

export interface OpenCLIStatus {
  daemon: boolean
  cdp: boolean
  opencli_ready: boolean
}

export type AgentMode = 'auto' | 'opencli' | 'camoufox'

// ── Pipeline ──────────────────────────────────────────────
export interface StepResult {
  step_index: number
  step_name: string
  exit_code: number
  stdout_tail: string
  stderr_tail: string
  validation_status: 'ok' | 'warning' | 'failed'
  validation_reason: string
  validation_suggestion: string
  retries_used: number
}

export interface PipelineRun {
  run_id: string
  pipeline_name: string
  current_step: number
  step_results: StepResult[]
  status: 'running' | 'awaiting_human' | 'completed' | 'failed' | 'aborted'
  log_path: string
  started_at: string
  ended_at: string | null
  config_dict: {
    name: string
    steps: Array<{
      name: string
      batch: string
      timeout: number
      retry: number
      output?: { path: string; expect: string }
    }>
  }
  pending_recipes?: Array<{ step_name: string }>
  awaiting_type?: 'failure' | 'human_confirm' | 'ask_user'
  awaiting_message?: string
  awaiting_suggestion?: string
}
