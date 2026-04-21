import type { OutputFormat, StepEvent, ScheduledTask, FileItem, OpenCLICategory, OpenCLIStatus, AgentMode, PipelineRun } from './types'

const BASE = '/api/backend'

/**
 * 長時間請求（如 LLM chat）專用的後端 URL：繞過 Next.js dev 的 rewrite proxy
 * 原因：Next.js rewrite 走 http-proxy，預設 socket timeout ~30s，超時就回 500
 * 只在瀏覽器端且後端在 localhost 時啟用；後端已配置 CORS 允許 3002
 */
const DIRECT_BASE = (() => {
  if (typeof window === 'undefined') return BASE
  const { hostname } = window.location
  if (hostname === 'localhost' || hostname === '127.0.0.1') return 'http://localhost:8001'
  return BASE
})()

/**
 * fetch wrapper：對 5xx / network 錯誤做指數退避重試
 * 延遲序列 400ms → 1200ms → 2500ms（總等候 ~4s），覆蓋典型 uvicorn 熱重載空窗
 * 原因：Next.js dev proxy 在後端 .py 編輯觸發 uvicorn reload 的 2-5 秒內會回 500/502
 * 只對 idempotent 操作使用；4xx 不重試（客戶端錯誤）
 */
export async function fetchWithRetry(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const delays = [400, 1200, 2500]
  const tryOnce = async () => {
    try { return await fetch(input, init) } catch { return null }
  }
  let res = await tryOnce()
  for (const delay of delays) {
    if (res && res.ok) return res
    const status = res?.status ?? 0
    const shouldRetry = !res || (status >= 500 && status < 600)
    if (!shouldRetry) return res!
    await new Promise(r => setTimeout(r, delay))
    res = await tryOnce()
  }
  if (res) return res
  throw new Error('後端連線失敗（請確認 uvicorn 是否在運行）')
}

// ── Chat / Run ──────────────────────────────────────────────
export async function* streamTask(
  task: string,
  format: OutputFormat = 'md',
  savePath?: string,
  mode: AgentMode = 'auto'
): AsyncGenerator<StepEvent> {
  const res = await fetch(`${BASE}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task, output_format: format, save_path: savePath ?? null, stream: true, mode }),
  })

  if (!res.ok) {
    throw new Error(`API 錯誤：${res.status}`)
  }

  const reader = res.body?.getReader()
  if (!reader) throw new Error('無法讀取串流')

  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    let event = ''
    let data = ''

    for (const line of lines) {
      if (line.startsWith('event: ')) {
        event = line.slice(7).trim()
      } else if (line.startsWith('data: ')) {
        data = line.slice(6).trim()
      } else if (line === '' && event && data) {
        try {
          const parsed = JSON.parse(data)
          yield { type: event as StepEvent['type'], ...parsed }
        } catch { /* ignore malformed */ }
        event = ''
        data = ''
      }
    }
  }
}

// ── Tasks ───────────────────────────────────────────────────
export async function getTasks(): Promise<ScheduledTask[]> {
  const res = await fetch(`${BASE}/tasks`)
  const data = await res.json()
  return data.tasks ?? []
}

export async function createTask(task: {
  name: string
  task_prompt: string
  output_format: OutputFormat
  save_path?: string
  schedule_type: string
  schedule_expr: string
}): Promise<ScheduledTask> {
  const res = await fetch(`${BASE}/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(task),
  })
  if (!res.ok) {
    const err = await res.json()
    throw new Error(err.detail ?? 'Create task failed')
  }
  const data = await res.json()
  return data.task
}

export async function deleteTask(id: string): Promise<void> {
  const res = await fetch(`${BASE}/tasks/${id}`, { method: 'DELETE' })
  if (!res.ok) throw new Error('Delete task failed')
}

// ── FS Browser ──────────────────────────────────────────────
export async function fsBrowse(path = ''): Promise<{
  path: string
  parent: string | null
  items: { name: string; path: string; is_dir: boolean; ext: string }[]
}> {
  const res = await fetch(`${BASE}/fs/browse?path=${encodeURIComponent(path)}`)
  return res.json()
}

export async function fsCheckVenv(dir: string): Promise<{ has_venv: boolean; python_path: string | null; venv_dir_name: string | null }> {
  const res = await fetch(`${BASE}/fs/check-venv?dir=${encodeURIComponent(dir)}`)
  if (!res.ok) throw new Error('檢查失敗')
  return res.json()
}

// ── Claude Code Skills ──────────────────────────────────────
export interface AvailableSkill {
  name: string
  display_name: string
  description: string
  path: string
  has_scripts: boolean
  has_references: boolean
  has_assets: boolean
  has_package_json?: boolean
  has_requirements?: boolean
}
export async function listAvailableSkills(): Promise<{ skills_root: string; exists: boolean; skills: AvailableSkill[] }> {
  const res = await fetchWithRetry(`${BASE}/skills/available`)
  if (!res.ok) throw new Error('載入 Skill 清單失敗')
  return res.json()
}

export interface SkillDependencies {
  skill_name: string
  found: boolean
  path?: string
  python?: {
    requirements_txt: string[]
    imports_detected: string[]
    suggested_pip: string[]
    installed: string[]
    missing: string[]
  }
  node?: {
    package_json: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } | null
    needs_npm_install: boolean
    suggested_npm?: string[]
    installed_npm?: string[]
    missing_npm?: string[]
    npm_available?: boolean
  }
  system_tools?: string[]
}
export async function scanSkillDependencies(displayName: string): Promise<SkillDependencies> {
  const res = await fetchWithRetry(`${BASE}/skills/${encodeURIComponent(displayName)}/dependencies`)
  if (!res.ok) throw new Error('掃描依賴失敗')
  return res.json()
}

// ── Log Analysis ────────────────────────────────────────────
export interface LogSuggestion { module: string; pip_name: string; found_in: string[] }
export interface LogAnalysis { analyzed: number; files: { name: string; size: number; has_errors: boolean }[]; suggestions: LogSuggestion[] }
export async function analyzeRecentLogs(count: number = 5): Promise<LogAnalysis> {
  const res = await fetch(`${BASE}/pipeline/logs/analyze?count=${count}`)
  if (!res.ok) throw new Error('分析失敗')
  return res.json()
}

// ── Files ───────────────────────────────────────────────────
export async function listFiles(path = ''): Promise<FileItem[]> {
  const res = await fetch(`${BASE}/files?path=${encodeURIComponent(path)}`)
  const data = await res.json()
  return data.files ?? []
}

export async function readFile(path: string): Promise<{ content: string; name: string }> {
  const res = await fetch(`${BASE}/files/content?path=${encodeURIComponent(path)}`)
  if (!res.ok) throw new Error('Read file failed')
  return res.json()
}

// ── Health ──────────────────────────────────────────────────
export async function getHealth(): Promise<{ status: string; warnings: string[] }> {
  const res = await fetch(`${BASE}/health`)
  return res.json()
}

// ── OpenCLI ─────────────────────────────────────────────────
export async function getOpenCLISites(): Promise<OpenCLICategory[]> {
  const res = await fetch(`${BASE}/opencli/sites`)
  const data = await res.json()
  return data.sites ?? []
}

export async function getOpenCLIStatus(): Promise<OpenCLIStatus> {
  const res = await fetch(`${BASE}/opencli/status`)
  return res.json()
}

// ── Pipeline ─────────────────────────────────────────────────
export async function getPipelineRuns(): Promise<PipelineRun[]> {
  const res = await fetchWithRetry(`${BASE}/pipeline/runs`)
  if (!res.ok) return []
  const data = await res.json()
  return data.runs ?? []
}

export async function getPipelineRun(runId: string): Promise<PipelineRun> {
  const res = await fetchWithRetry(`${BASE}/pipeline/runs/${runId}`)
  if (!res.ok) throw new Error('找不到 pipeline run')
  return res.json()
}

export async function startPipeline(yamlContent: string, validate = true, useRecipe = false, workflowId?: string, noSaveRecipe = false): Promise<{ run_id: string }> {
  const res = await fetch(`${BASE}/pipeline/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ yaml_content: yamlContent, validate, use_recipe: useRecipe, workflow_id: workflowId ?? null, no_save_recipe: noSaveRecipe }),
  })
  if (!res.ok) {
    const err = await res.json()
    throw new Error(err.detail ?? 'Pipeline 啟動失敗')
  }
  return res.json()
}

export async function deletePipelineRun(runId: string): Promise<void> {
  const res = await fetch(`${BASE}/pipeline/runs/${runId}`, { method: 'DELETE' })
  if (!res.ok) throw new Error('刪除失敗')
}

export async function resumePipeline(runId: string, decision: 'retry' | 'skip' | 'abort' | 'continue' | 'retry_with_hint' | 'answer', hint?: string): Promise<{ message: string }> {
  const body: Record<string, string> = { decision }
  if (hint) body.hint = hint
  const res = await fetch(`${BASE}/pipeline/runs/${runId}/resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error('Resume 失敗')
  return res.json()
}

export async function abortPipeline(runId: string): Promise<{ message: string }> {
  const res = await fetch(`${BASE}/pipeline/runs/${runId}/abort`, {
    method: 'POST',
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.detail ?? '中止失敗')
  }
  return res.json()
}

export async function savePendingRecipes(runId: string): Promise<{ saved: number }> {
  const res = await fetch(`${BASE}/pipeline/runs/${runId}/save-recipes`, {
    method: 'POST',
  })
  if (!res.ok) throw new Error('儲存 Recipe 失敗')
  return res.json()
}

export async function getPipelineLog(runId: string): Promise<{ log: string }> {
  const res = await fetch(`${BASE}/pipeline/runs/${runId}/log`)
  if (!res.ok) throw new Error('取得 log 失敗')
  return res.json()
}

export async function getPipelineScheduled(): Promise<ScheduledTask[]> {
  const res = await fetchWithRetry(`${BASE}/pipeline/scheduled`)
  if (!res.ok) return []
  const data = await res.json()
  return data.tasks ?? []
}

export async function cancelPipelineSchedule(name: string): Promise<void> {
  const res = await fetch(`${BASE}/pipeline/scheduled/cancel-by-name/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  })
  if (!res.ok) throw new Error('取消排程失敗')
}

export async function createPipelineSchedule(req: {
  name: string
  yaml_content: string
  schedule_type: string
  schedule_expr: string
  validate?: boolean
  use_recipe?: boolean
  workflow_id?: string
}): Promise<ScheduledTask> {
  const res = await fetch(`${BASE}/pipeline/scheduled`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  })
  if (!res.ok) {
    const err = await res.json()
    throw new Error(err.detail ?? '建立排程失敗')
  }
  const data = await res.json()
  return data.task
}

export async function deletePipelineSchedule(taskId: string): Promise<void> {
  const res = await fetch(`${BASE}/pipeline/scheduled/${taskId}`, { method: 'DELETE' })
  if (!res.ok) throw new Error('刪除排程失敗')
}

// ── Settings ─────────────────────────────────────────────────
export interface ModelSettings {
  provider: 'groq' | 'ollama' | 'gemini' | 'openrouter'
  model: string
  ollama_base_url: string
  ollama_thinking: 'auto' | 'on' | 'off'
  ollama_num_ctx: number
  gemini_thinking: 'off' | 'auto' | 'low' | 'medium' | 'high'
  openrouter_thinking: 'off' | 'on'
}

export interface ModelOption {
  id: string
  label: string
  supports_thinking?: boolean
  context_length?: number
}

export interface AvailableModels {
  groq: ModelOption[]
  groq_error: string | null
  gemini: ModelOption[]
  gemini_error: string | null
  openrouter: ModelOption[]
  openrouter_error: string | null
  ollama: ModelOption[]
  ollama_base_url: string
  ollama_error: string | null
}

export async function getModelSettings(): Promise<ModelSettings> {
  const res = await fetchWithRetry(`${BASE}/settings/model`)
  if (!res.ok) throw new Error('讀取設定失敗')
  return res.json()
}

export async function saveModelSettings(s: ModelSettings): Promise<ModelSettings> {
  const res = await fetch(`${BASE}/settings/model`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(s),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.detail ?? '儲存失敗')
  }
  return res.json()
}

export async function getAvailableModels(): Promise<AvailableModels> {
  // 用 DIRECT_BASE 繞過 Next.js proxy：此端點要打 4 個外部 API（Groq/Gemini/OpenRouter/Ollama）
  // 經常 10 秒以上，走 proxy 容易碰到 reload 空窗或 timeout
  const res = await fetchWithRetry(`${DIRECT_BASE}/settings/models/available`)
  if (!res.ok) throw new Error('讀取模型清單失敗')
  return res.json()
}

// ── Skill Packages ─────────────────────────────────────────
export interface SkillPackage {
  name: string
  installed: boolean
  version: string
}

export interface EnvPaths {
  project_root: string
  test_workflows_dir: string | null
  has_finance_example: boolean
  finance_example_dir: string | null
  path_sep: string
}

export async function getEnvPaths(): Promise<EnvPaths> {
  const res = await fetchWithRetry(`${BASE}/env/paths`)
  if (!res.ok) throw new Error('讀取專案路徑失敗')
  return res.json()
}

// ── Computer Use 錄製 API ──────────────────────────────────────
export interface RecordingStatus {
  recording: boolean
  session_id?: string
  output_dir?: string
  action_count?: number
  duration_sec?: number
  stopped?: boolean
  latest_actions?: any[]
}

export async function startComputerUseRecording(sessionId: string, outputDir: string): Promise<RecordingStatus> {
  const res = await fetch(`${BASE}/computer-use/recording/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId, output_dir: outputDir }),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`開始錄製失敗：${detail || res.status}`)
  }
  return res.json()
}

export async function stopComputerUseRecording(): Promise<RecordingStatus> {
  const res = await fetch(`${BASE}/computer-use/recording/stop`, { method: 'POST' })
  if (!res.ok) throw new Error('停止錄製失敗')
  return res.json()
}

export async function getComputerUseRecordingStatus(): Promise<RecordingStatus> {
  const res = await fetchWithRetry(`${BASE}/computer-use/recording/status`)
  if (!res.ok) throw new Error('查詢錄製狀態失敗')
  return res.json()
}

export async function loadComputerUseRecording(outputDir: string): Promise<{ actions: any[]; meta: any; output_dir: string }> {
  const res = await fetchWithRetry(`${BASE}/computer-use/recording/load?output_dir=${encodeURIComponent(outputDir)}`)
  if (!res.ok) throw new Error('載入錄製結果失敗')
  return res.json()
}

export async function deleteComputerUseAssets(dir: string): Promise<{ deleted: boolean; path: string; reason?: string }> {
  const res = await fetch(`${BASE}/computer-use/assets?dir=${encodeURIComponent(dir)}`, { method: 'DELETE' })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(detail || `刪除錨點資料夾失敗 (${res.status})`)
  }
  return res.json()
}

export function computerUseAssetImageUrl(dir: string, name: string): string {
  return `${BASE}/computer-use/assets/image?dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(name)}`
}

export interface CropAnchorReq {
  dir: string
  full_image: string
  click_x: number
  click_y: number
  full_left?: number
  full_top?: number
  crop_left: number
  crop_top: number
  crop_width: number
  crop_height: number
  save_as: string
}

export async function cropAnchorFromFull(req: CropAnchorReq): Promise<{
  image: string
  anchor_off_x: number
  anchor_off_y: number
  width: number
  height: number
  variance: number
}> {
  const res = await fetch(`${BASE}/computer-use/assets/crop`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ full_left: 0, full_top: 0, ...req }),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(detail || `裁切錨點失敗 (${res.status})`)
  }
  return res.json()
}

export interface NodeStatus {
  node_installed: boolean
  node_version: string
  npm_installed: boolean
  npm_version: string
  install_hint: string
}

export async function getNodeStatus(): Promise<NodeStatus> {
  const res = await fetchWithRetry(`${BASE}/settings/node-status`)
  if (!res.ok) throw new Error('讀取 Node.js 狀態失敗')
  return res.json()
}

export async function getSkillPackages(): Promise<SkillPackage[]> {
  const res = await fetchWithRetry(`${BASE}/settings/skill-packages`)
  if (!res.ok) throw new Error('讀取套件清單失敗')
  const data = await res.json()
  return data.packages
}

export async function addSkillPackage(name: string): Promise<string> {
  const res = await fetch(`${BASE}/settings/skill-packages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.detail ?? '安裝失敗')
  return data.message
}

export async function removeSkillPackage(name: string): Promise<string> {
  const res = await fetch(`${BASE}/settings/skill-packages/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.detail ?? '移除失敗')
  return data.message
}

export interface UnlistedPackage { name: string; version: string }
export async function scanUnlistedPackages(): Promise<UnlistedPackage[]> {
  const res = await fetchWithRetry(`${BASE}/settings/skill-packages/unlisted`)
  if (!res.ok) throw new Error('掃描 venv 失敗')
  const data = await res.json()
  return data.packages
}

export async function adoptExistingPackage(name: string): Promise<string> {
  const res = await fetch(`${BASE}/settings/skill-packages/adopt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.detail ?? '加入失敗')
  return data.message
}

// ── Workflows ───────────────────────────────────────────────
export interface WorkflowData {
  id: string
  name: string
  yaml: string
  canvas: { nodes: any[]; edges: any[] }
  validate: boolean
  created_at: number
  updated_at: number
}

export async function listWorkflows(): Promise<WorkflowData[]> {
  const res = await fetchWithRetry(`${BASE}/workflows`)
  if (!res.ok) throw new Error('讀取工作流失敗')
  return res.json()
}

export async function createWorkflowApi(name: string = '新工作流', canvas?: { nodes: any[]; edges: any[] }, validate = false): Promise<WorkflowData> {
  const res = await fetchWithRetry(`${BASE}/workflows`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, canvas, validate }),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`建立工作流失敗 (${res.status}): ${detail || '後端暫時無回應，請稍後再試'}`)
  }
  return res.json()
}

export async function updateWorkflowApi(id: string, patch: { name?: string; canvas?: any; validate?: boolean; yaml?: string }): Promise<WorkflowData> {
  const res = await fetchWithRetry(`${BASE}/workflows/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  if (!res.ok) throw new Error('更新工作流失敗')
  return res.json()
}

export async function deleteWorkflowApi(id: string, cascade = true): Promise<void> {
  const res = await fetchWithRetry(`${BASE}/workflows/${id}?cascade=${cascade}`, { method: 'DELETE' })
  if (!res.ok) throw new Error('刪除工作流失敗')
}

export function exportWorkflowUrl(id: string): string {
  return `${BASE}/workflows/${id}/export`
}

export async function importWorkflow(file: File): Promise<{
  workflow: WorkflowData
  recipe_count: number
  has_local_scripts: boolean
}> {
  const form = new FormData()
  form.append('file', file)
  const res = await fetch(`${BASE}/workflows/import`, { method: 'POST', body: form })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.detail ?? '匯入失敗')
  }
  return res.json()
}

// ── Recipe Book ─────────────────────────────────────────────
export interface Recipe {
  recipe_id: string
  workflow_id: string
  step_name: string
  task_hash: string
  input_fingerprints: Record<string, string>
  output_path: string | null
  code: string
  python_version: string
  success_count: number
  fail_count: number
  created_at: number
  last_success_at: number
  last_fail_at: number
  avg_runtime_sec: number
  disabled: boolean
  was_interactive?: boolean
}

export async function listRecipes(): Promise<Recipe[]> {
  const res = await fetch(`${BASE}/recipes`)
  if (!res.ok) throw new Error('讀取 recipes 失敗')
  return res.json()
}

export async function deleteRecipe(workflowId: string, stepName: string): Promise<void> {
  const res = await fetch(`${BASE}/recipes/${encodeURIComponent(workflowId)}/${encodeURIComponent(stepName)}`, {
    method: 'DELETE',
  })
  if (!res.ok) throw new Error('刪除 recipe 失敗')
}

export async function deleteWorkflowRecipes(workflowId: string): Promise<number> {
  const res = await fetch(`${BASE}/recipes/${encodeURIComponent(workflowId)}`, { method: 'DELETE' })
  if (!res.ok) throw new Error('刪除 workflow recipes 失敗')
  const data = await res.json()
  return data.deleted_count ?? 0
}

export interface RecipeStatus {
  has_recipes: boolean
  total_skill_steps: number
  covered_steps: number
  steps: Record<string, { has_recipe: boolean; success_count: number; avg_runtime_sec: number }>
}

export async function getRecipeStatus(pipelineName: string, stepNames: string[]): Promise<RecipeStatus> {
  const params = new URLSearchParams({ steps: stepNames.join(',') })
  const res = await fetch(`${BASE}/recipes/status/${encodeURIComponent(pipelineName)}?${params}`)
  if (!res.ok) throw new Error('查詢 recipe 狀態失敗')
  return res.json()
}

// ── Notification Settings ──────────────────────────────────
export interface NotificationSettings {
  telegram_bot_token: string
  telegram_chat_id: string
  line_notify_token: string
}

export async function getNotificationSettings(): Promise<NotificationSettings> {
  const res = await fetchWithRetry(`${BASE}/settings/notifications`)
  if (!res.ok) throw new Error('讀取通知設定失敗')
  return res.json()
}

export async function saveNotificationSettings(s: Partial<NotificationSettings>): Promise<NotificationSettings> {
  const res = await fetch(`${BASE}/settings/notifications`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(s),
  })
  if (!res.ok) throw new Error('儲存通知設定失敗')
  return res.json()
}

export async function pipelineChat(messages: Array<{ role: 'user' | 'assistant'; content: string }>): Promise<{
  reply: string
  has_yaml: boolean
  yaml_content: string | null
  yaml_error?: string | null
}> {
  // 使用 DIRECT_BASE 繞過 Next.js dev rewrite proxy 的 ~30s socket timeout
  // （LLM 回應經常 30-60s；走 proxy 會被截斷回 500）
  // 不用 fetchWithRetry：觸發 LLM 有金流/速率成本，失敗讓使用者手動重送
  const res = await fetch(`${DIRECT_BASE}/pipeline/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages }),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(detail ? `AI 回應失敗 (${res.status}): ${detail.slice(0, 200)}` : 'AI 回應失敗（請確認後端 uvicorn 在執行）')
  }
  return res.json()
}
