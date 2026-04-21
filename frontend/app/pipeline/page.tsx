'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ReactFlow, Background, Controls, MiniMap, Panel,
  addEdge, useNodesState, useEdgesState,
  BackgroundVariant,
  type Connection, type Edge, type ReactFlowInstance,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'

import {
  Play, Clock, Code2, Plus, Sparkles, BookOpen, Zap, Square,
  Loader2, CheckCircle2, XCircle, Workflow, Terminal, X, Hand,
} from 'lucide-react'
import { toast } from 'sonner'
import { Toaster } from 'sonner'

import ScriptStepNode              from './_scriptNode'
import SkillStepNode               from './_skillNode'
import AiValidationNodeComponent   from './_aiValidationNode'
import HumanConfirmNodeComponent   from './_humanConfirmNode'
import ComputerUseNodeComponent    from './_computerUseNode'
import ScriptConfigPanel           from './_scriptPanel'
import SkillConfigPanel            from './_skillPanel'
import AiValidationPanel           from './_aiValidationPanel'
import HumanConfirmPanel           from './_humanConfirmPanel'
import ComputerUsePanel            from './_computerUsePanel'
import Sidebar                from './_sidebar'
import {
  type AppNode, type StepData, type SkillData, type AiValidationData, type HumanConfirmData, type ComputerUseData,
  type ScriptNode, type SkillNode, type HumanConfirmNode, type ComputerUseNode,
  newStepData, newSkillData, newAiValidationData, newHumanConfirmData, newComputerUseData,
  stepsToFlow, flowToSteps, stepsToYaml, parseYaml,
} from './_helpers'
import { useWorkflowStore } from './_store'
import {
  startPipeline, getPipelineRun, resumePipeline, abortPipeline, savePendingRecipes,
  createPipelineSchedule, getPipelineLog,
  getPipelineRuns,
  getRecipeStatus, type RecipeStatus,
  deleteComputerUseAssets,
} from '@/lib/api'
import type { PipelineRun } from '@/lib/types'
import { useRunStatusStore } from './_runStatus'

const nodeTypes = {
  scriptStep: ScriptStepNode,
  skillStep: SkillStepNode,
  aiValidation: AiValidationNodeComponent,
  humanConfirmation: HumanConfirmNodeComponent,
  computerUse: ComputerUseNodeComponent,
}

// ── Schedule Dialog ───────────────────────────────────────────────────────────
function ScheduleDialog({ yaml, pipelineName, workflowId, recipeStatus, onClose }: {
  yaml: string; pipelineName: string; workflowId: string | null; recipeStatus: RecipeStatus | null; onClose: () => void
}) {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const todayStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const timeStr  = `${pad(now.getHours() + 1)}:00`

  const [mode, setMode]       = useState<'once' | 'cron'>('once')
  const [onceDate, setDate]   = useState(todayStr)
  const [onceTime, setTime]   = useState(timeStr)
  const [cronExpr, setCron]   = useState('0 9 * * 1-5')
  const [useRecipe, setUseRecipe] = useState(false)
  const [loading, setLoading] = useState(false)

  const hasRecipe = recipeStatus?.has_recipes ?? false

  const handleSave = async () => {
    setLoading(true)
    try {
      let expr = ''
      if (mode === 'once') {
        expr = `${onceDate}T${onceTime}:00`
      } else {
        expr = cronExpr.trim()
        if (!expr) { toast.error('請輸入 cron 表達式'); setLoading(false); return }
      }
      await createPipelineSchedule({
        name: pipelineName || 'my-pipeline',
        yaml_content: yaml,
        schedule_type: mode,
        schedule_expr: expr,
        validate: !useRecipe,
        use_recipe: useRecipe,
        workflow_id: workflowId ?? undefined,
      })
      toast.success(`排程已建立${useRecipe ? '（快速模式）' : '（完整模式）'}`)
      onClose()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '建立失敗')
    } finally { setLoading(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-2xl shadow-2xl w-96 overflow-hidden">
        <div className="flex items-center gap-3 px-5 py-4 border-b">
          <Clock className="w-4 h-4 text-indigo-600" />
          <span className="font-semibold text-gray-800">設定排程</span>
        </div>
        <div className="p-5 space-y-4">
          {/* 執行模式選擇 */}
          <div>
            <label className="text-xs font-medium text-gray-500 mb-2 block">執行模式</label>
            <div className="flex gap-2">
              <button onClick={() => setUseRecipe(false)}
                className={`flex-1 py-2 px-3 rounded-lg text-sm font-medium border transition-colors flex items-center justify-center gap-1.5
                  ${!useRecipe ? 'bg-indigo-600 text-white border-indigo-600' : 'text-gray-600 border-gray-200 hover:border-indigo-400'}`}
              >
                <Sparkles className="w-3.5 h-3.5" /> 完整模式
              </button>
              <button onClick={() => hasRecipe && setUseRecipe(true)}
                disabled={!hasRecipe}
                className={`flex-1 py-2 px-3 rounded-lg text-sm font-medium border transition-colors flex items-center justify-center gap-1.5
                  ${useRecipe ? 'bg-emerald-600 text-white border-emerald-600' : hasRecipe ? 'text-gray-600 border-gray-200 hover:border-emerald-400' : 'text-gray-400 border-gray-100 bg-gray-50 cursor-not-allowed'}`}
              >
                <Zap className="w-3.5 h-3.5" /> 快速模式
              </button>
            </div>
            <p className="text-xs text-gray-400 mt-1">
              {useRecipe
                ? '使用已快取的 Recipe 直接執行，跳過 LLM 驗證。'
                : hasRecipe
                  ? 'AI 重新生成程式碼 + 完整驗證。'
                  : '尚無 Recipe，請先用完整模式成功執行一次。'}
            </p>
          </div>

          {/* 排程類型 */}
          <div>
            <label className="text-xs font-medium text-gray-500 mb-2 block">排程類型</label>
            <div className="flex gap-2">
              {(['once', 'cron'] as const).map(m => (
                <button key={m} onClick={() => setMode(m)}
                  className={`flex-1 py-1.5 rounded-lg text-sm font-medium border transition-colors
                    ${mode === m ? 'bg-indigo-600 text-white border-indigo-600' : 'text-gray-600 border-gray-200 hover:border-indigo-400'}`}
                >{m === 'once' ? '一次性' : '週期（Cron）'}</button>
              ))}
            </div>
          </div>
          {mode === 'once' ? (
            <div className="flex gap-2">
              <input type="date" value={onceDate} onChange={e => setDate(e.target.value)} min={todayStr}
                className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm outline-none focus:border-indigo-400" />
              <input type="time" value={onceTime} onChange={e => setTime(e.target.value)}
                className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm outline-none focus:border-indigo-400" />
            </div>
          ) : (
            <div>
              <input value={cronExpr} onChange={e => setCron(e.target.value)}
                placeholder="0 9 * * 1-5"
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono outline-none focus:border-indigo-400" />
              <p className="text-xs text-gray-400 mt-1">分 時 日 月 週。範例：0 9 * * 1-5 = 週一到五早上 9 點</p>
            </div>
          )}
        </div>
        <div className="px-5 py-4 border-t flex gap-2 justify-end">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 rounded-lg transition-colors">取消</button>
          <button onClick={handleSave} disabled={loading}
            className="px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-60 flex items-center gap-2 transition-colors"
          >
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Clock className="w-3.5 h-3.5" />}
            建立排程
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Run Dialog（選擇快速/完整模式）──────────────────────────────────────────────
function RunDialog({
  recipeStatus, onRun, onClose,
}: {
  recipeStatus: RecipeStatus | null
  onRun: (useRecipe: boolean) => void
  onClose: () => void
}) {
  const hasRecipe = recipeStatus?.has_recipes ?? false
  const covered = recipeStatus?.covered_steps ?? 0
  const total = recipeStatus?.total_skill_steps ?? 0

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-[420px] overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-5 py-4 border-b">
          <Play className="w-4 h-4 text-indigo-600" />
          <span className="font-semibold text-gray-800">執行 Pipeline</span>
        </div>
        <div className="p-5 space-y-3">
          {/* 快速模式 */}
          <button
            onClick={() => onRun(true)}
            disabled={!hasRecipe}
            className={`w-full text-left p-4 rounded-xl border-2 transition-all ${
              hasRecipe
                ? 'border-emerald-200 hover:border-emerald-400 hover:bg-emerald-50 cursor-pointer'
                : 'border-gray-100 bg-gray-50 opacity-60 cursor-not-allowed'
            }`}
          >
            <div className="flex items-center gap-2 mb-1">
              <Zap className="w-4 h-4 text-amber-500" />
              <span className="font-semibold text-sm text-gray-900">快速模式（Recipe）</span>
              {hasRecipe && (
                <span className="ml-auto text-xs px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 font-medium">
                  {covered}/{total} 步驟已快取
                </span>
              )}
            </div>
            <p className="text-xs text-gray-500 leading-relaxed">
              {hasRecipe
                ? '使用上次成功的程式碼直接執行，僅做檔案存在 + 大小檢查，數秒完成。'
                : '尚無 Recipe 紀錄。請先用完整模式跑一次成功。'}
            </p>
          </button>

          {/* 完整模式 */}
          <button
            onClick={() => onRun(false)}
            className="w-full text-left p-4 rounded-xl border-2 border-gray-200 hover:border-indigo-400 hover:bg-indigo-50 transition-all cursor-pointer"
          >
            <div className="flex items-center gap-2 mb-1">
              <Sparkles className="w-4 h-4 text-indigo-500" />
              <span className="font-semibold text-sm text-gray-900">完整模式（LLM 驗證）</span>
            </div>
            <p className="text-xs text-gray-500 leading-relaxed">
              AI 重新生成程式碼 + 完整驗證輸出內容。較慢但會徹底檢查結果正確性。
            </p>
          </button>
        </div>
        <div className="px-5 py-3 border-t bg-gray-50 flex justify-end">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700 transition-colors">取消</button>
        </div>
      </div>
    </div>
  )
}

// ── YAML Panel（Terminal 風格）─────────────────────────────────────────────────
function YamlPanel({ yaml, onImport, onClose }: { yaml: string; onImport: (y: string) => void; onClose: () => void }) {
  const [draft, setDraft] = useState(yaml)
  useEffect(() => setDraft(yaml), [yaml])
  return (
    <div className="absolute top-0 right-0 h-full w-[460px] bg-gray-950 shadow-2xl border-l border-gray-800 z-40 flex flex-col">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
        <div className="flex items-center gap-2">
          <Terminal className="w-4 h-4 text-green-400" />
          <span className="font-semibold text-sm text-gray-300 font-mono">YAML</span>
        </div>
        <div className="flex gap-2">
          <button onClick={() => { onImport(draft); toast.success('已從 YAML 更新流程') }}
            className="px-3 py-1 text-xs bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors font-mono">
            套用
          </button>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-lg leading-none">×</button>
        </div>
      </div>
      <textarea
        value={draft}
        onChange={e => setDraft(e.target.value)}
        className="flex-1 p-4 text-xs font-mono text-green-400 bg-gray-950 resize-none outline-none leading-relaxed caret-green-400"
        style={{ caretColor: '#4ade80' }}
        spellCheck={false}
      />
    </div>
  )
}

// ── Empty State ───────────────────────────────────────────────────────────────
function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
      <div className="pointer-events-auto flex flex-col items-center gap-4 text-center">
        <div className="w-16 h-16 rounded-2xl bg-indigo-50 flex items-center justify-center">
          <Workflow className="w-8 h-8 text-indigo-400" />
        </div>
        <div>
          <p className="text-gray-600 font-medium mb-1">尚未建立任何步驟</p>
          <p className="text-gray-400 text-sm">點擊下方按鈕新增第一個步驟</p>
        </div>
        <button
          onClick={onAdd}
          className="flex items-center gap-2 px-5 py-2.5 bg-indigo-600 text-white rounded-xl shadow-lg hover:bg-indigo-700 transition-colors font-medium text-sm"
        >
          <Plus className="w-4 h-4" />
          新增步驟
        </button>
      </div>
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function PipelinePage() {
  const [nodes, setNodes, onNodesChange] = useNodesState<AppNode>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [pipelineName, setPipelineName] = useState('my-pipeline')
  const [showYaml, setShowYaml]   = useState(false)
  const [showSchedule, setShowSchedule] = useState(false)
  const [showRunDialog, setShowRunDialog] = useState(false)
  const [recipeStatus, setRecipeStatus]   = useState<RecipeStatus | null>(null)
  const [running, setRunning]     = useState(false)
  const [runStatus, _setRunStatus] = useState<'idle' | 'running' | 'success' | 'failed' | 'awaiting'>('idle')
  const runStatusRef = useRef(runStatus)
  const setRunStatus = (v: typeof runStatus) => { runStatusRef.current = v; _setRunStatus(v) }
  const [awaitingRunId, setAwaitingRunId] = useState<string | null>(null)
  const [awaitingType, setAwaitingType] = useState<'failure' | 'confirm' | 'ask_user'>('failure')
  const [askUserOptions, setAskUserOptions] = useState<string[]>([])
  const [askUserContext, setAskUserContext] = useState('')
  const [askUserAnswer, setAskUserAnswer] = useState('')
  const [awaitingMessage, setAwaitingMessage] = useState('')
  const [awaitingSuggestion, setAwaitingSuggestion] = useState('')
  const [showRecipeConfirm, setShowRecipeConfirm] = useState(false)
  const [pendingRecipeRunId, setPendingRecipeRunId] = useState<string | null>(null)
  const [pendingRecipeCount, setPendingRecipeCount] = useState(0)
  const [showLog, setShowLog]       = useState(false)
  const [logLines, setLogLines]     = useState<string[]>([])
  const logEndRef  = useRef<HTMLDivElement>(null)
  const logContainerRef = useRef<HTMLDivElement>(null)
  const logAutoScrollRef = useRef(true)

  // ── Log panel 高度調整 ─────────────────────────────────────
  const LOG_HEIGHT_KEY = 'pipeline-log-height'
  const LOG_MIN_HEIGHT = 150
  const LOG_DEFAULT_HEIGHT = 256  // 原本的 h-64
  const [logHeight, setLogHeight] = useState(LOG_DEFAULT_HEIGHT)
  const [logResizing, setLogResizing] = useState(false)
  useEffect(() => {
    const saved = Number(localStorage.getItem(LOG_HEIGHT_KEY))
    if (saved >= LOG_MIN_HEIGHT) setLogHeight(saved)
  }, [])
  useEffect(() => {
    if (!logResizing) return
    const onMove = (e: MouseEvent) => {
      // 從視窗底往上算 → 拖曳越上寬，面板越高
      const maxHeight = Math.floor(window.innerHeight / 2)  // 最多占一半螢幕
      const fromBottom = window.innerHeight - e.clientY
      const h = Math.min(maxHeight, Math.max(LOG_MIN_HEIGHT, fromBottom))
      setLogHeight(h)
    }
    const onUp = () => {
      setLogResizing(false)
      try { localStorage.setItem(LOG_HEIGHT_KEY, String(logHeight)) } catch {}
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [logResizing, logHeight])
  const rfInstanceRef = useRef<ReactFlowInstance<AppNode, Edge> | null>(null)
  const [editingName, setEditingName] = useState(false)
  const runIdRef   = useRef<string | null>(null)
  const pollRef    = useRef<ReturnType<typeof setInterval> | null>(null)
  const savingRef  = useRef(false)  // 防止切換工作流時觸發 auto-save

  // ── Workflow Store ────────────────────────────────────────────────────────
  const { activeId, workflows, updateWorkflow, saveCanvas, createWorkflow } = useWorkflowStore()

  // 當 activeId 改變時，載入對應工作流（defer 避免 render-time setState）
  useEffect(() => {
    if (!activeId) return
    const wf = workflows.find(w => w.id === activeId)
    if (!wf) return
    savingRef.current = true
    // 切換工作流前：清除上一個工作流的執行狀態
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
    runIdRef.current = null
    setRunning(false)
    useRunStatusStore.getState().resetAll()
    const timer = setTimeout(() => {
      setNodes(wf.nodes as AppNode[])
      setEdges(wf.edges)
      setPipelineName(wf.name)
      setSelectedId(null)
      setRunStatus('idle')
      setAwaitingRunId(null)
      setTimeout(() => {
        savingRef.current = false
        rfInstanceRef.current?.fitView({ padding: 0.3, duration: 300 })
      }, 1000)
    }, 30)
    return () => clearTimeout(timer)
  }, [activeId]) // eslint-disable-line

  // 自動偵測背景執行中的 pipeline（排程觸發等），每 3 秒輪詢
  const bgDetectRef = useRef<ReturnType<typeof setInterval> | null>(null)
  useEffect(() => {
    if (bgDetectRef.current) clearInterval(bgDetectRef.current)
    if (!pipelineName) return

    const detect = async () => {
      // 已在前端執行中就不重複偵測
      if (runIdRef.current) return
      try {
        const runs = await getPipelineRuns()
        const active = runs.find(
          r => (r.status === 'running' || r.status === 'awaiting_human') && r.pipeline_name === pipelineName
        )
        if (active && !runIdRef.current) {
          runIdRef.current = active.run_id
          setRunning(true)
          if (active.status === 'awaiting_human') {
            setRunStatus('awaiting')
            setAwaitingRunId(active.run_id)
            const at = (active as any).awaiting_type
            const mapped = at === 'human_confirm' ? 'confirm' : at === 'ask_user' ? 'ask_user' : 'failure'
            setAwaitingType(mapped)
            setAwaitingMessage((active as any).awaiting_message || '')
            setAwaitingSuggestion((active as any).awaiting_suggestion || '')
            if (mapped === 'ask_user') {
              try {
                const meta = JSON.parse((active as any).awaiting_suggestion || '{}')
                setAskUserOptions(meta.options || [])
                setAskUserContext(meta.context || '')
              } catch { setAskUserOptions([]); setAskUserContext('') }
            }
          } else {
            setRunStatus('running')
          }
          setShowLog(true)
          toast.info(`偵測到排程執行中`)
          pollStatus(active.run_id)
          pollRef.current = setInterval(() => pollStatus(active.run_id), 1500)
        }
      } catch { /* ignore */ }
    }

    detect()
    bgDetectRef.current = setInterval(detect, 3000)
    return () => { if (bgDetectRef.current) clearInterval(bgDetectRef.current) }
  }, [pipelineName]) // eslint-disable-line

  // Auto-save 到 store（防抖 800ms）
  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (savingRef.current || !activeId) return
    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current)
    autoSaveTimer.current = setTimeout(() => {
      saveCanvas(activeId, nodes as AppNode[], edges)
    }, 800)
    return () => { if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current) }
  }, [nodes, edges]) // eslint-disable-line

  // 同步名稱到 store
  useEffect(() => {
    if (savingRef.current || !activeId) return
    updateWorkflow(activeId, { name: pipelineName })
  }, [pipelineName]) // eslint-disable-line

  // 載入 recipe 狀態（標記哪些 skill step 有快取）
  const recipeLoadTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (recipeLoadTimer.current) clearTimeout(recipeLoadTimer.current)
    recipeLoadTimer.current = setTimeout(async () => {
      const steps = flowToSteps(nodes as AppNode[], edges)
      const skillSteps = steps.filter(s => s.skillMode).map(s => s.name)
      if (skillSteps.length === 0) {
        useRunStatusStore.getState().setRecipeSteps({})
        return
      }
      try {
        const status = await getRecipeStatus(activeId || pipelineName, skillSteps)
        const map: Record<string, boolean> = {}
        for (const [name, info] of Object.entries(status.steps)) {
          if (info.has_recipe) map[name] = true
        }
        useRunStatusStore.getState().setRecipeSteps(map)
      } catch {
        // 忽略錯誤
      }
    }, 1000)
    return () => { if (recipeLoadTimer.current) clearTimeout(recipeLoadTimer.current) }
  }, [nodes, edges, pipelineName]) // eslint-disable-line

  const selectedNode = nodes.find(n => n.id === selectedId)

  // ── 從 runStatus store 讀取 edges 動畫狀態 ─────────────────────────────────
  const edgesAnimated = useRunStatusStore(s => s.edgesAnimated)
  const displayEdges = useMemo(
    () => edges.map(e => ({ ...e, animated: edgesAnimated } as Edge)),
    [edges, edgesAnimated],
  )

  // ── 穩定化 ReactFlow callbacks（避免每次 render 產生新函式觸發 ReactFlow 內部 setState）
  const onNodeClick = useCallback((_: React.MouseEvent, node: { id: string }) => setSelectedId(node.id), [])
  const onPaneClick = useCallback(() => setSelectedId(null), [])
  const onInit      = useCallback((inst: ReactFlowInstance<AppNode, Edge>) => {
    rfInstanceRef.current = inst
    setTimeout(() => inst.fitView({ padding: 0.3 }), 0)
  }, [])
  const miniMapNodeColor = useCallback((n: { type?: string }) => {
    if (n.type === 'aiValidation') return '#f59e0b'
    if (n.type === 'skillStep') return '#8b5cf6'
    if (n.type === 'humanConfirmation') return '#10b981'
    if (n.type === 'computerUse') return '#9333ea'
    return '#3b82f6'
  }, [])

  // ── Derive YAML ──────────────────────────────────────────────────────────
  const getYaml = useCallback(() => {
    const steps = flowToSteps(nodes, edges)
    return stepsToYaml(pipelineName, steps)
  }, [nodes, edges, pipelineName])

  // ── Add script step ────────────────────────────────────────────────────────
  const addScriptStep = useCallback(() => {
    const count = nodes.length
    const id   = `step-${Date.now()}`
    const data  = newStepData(count)
    const lastNode = [...nodes].sort((a, b) => b.position.x - a.position.x)[0]
    const x = lastNode ? lastNode.position.x + 320 : 100
    const y = lastNode ? lastNode.position.y : 160

    const newNode: AppNode = {
      id, type: 'scriptStep',
      position: { x, y },
      data,
    }
    setNodes(ns => [...ns, newNode])

    if (lastNode) {
      const newEdge: Edge = {
        id: `e-${lastNode.id}-${id}`,
        source: lastNode.id,
        target: id,
        type: 'smoothstep',
        style: { stroke: '#3b82f6', strokeWidth: 2 },
      }
      setEdges(es => [...es, newEdge])
    }
    setSelectedId(id)
  }, [nodes, setNodes, setEdges])

  // ── Add skill step ──────────────────────────────────────────────────────────
  const addSkillStep = useCallback(() => {
    const count = nodes.length
    const id   = `skill-${Date.now()}`
    const data  = newSkillData(count)
    const lastNode = [...nodes].sort((a, b) => b.position.x - a.position.x)[0]
    const x = lastNode ? lastNode.position.x + 320 : 100
    const y = lastNode ? lastNode.position.y : 160

    const newNode: AppNode = {
      id, type: 'skillStep',
      position: { x, y },
      data,
    }
    setNodes(ns => [...ns, newNode])

    if (lastNode) {
      const newEdge: Edge = {
        id: `e-${lastNode.id}-${id}`,
        source: lastNode.id,
        target: id,
        type: 'smoothstep',
        style: { stroke: '#8b5cf6', strokeWidth: 2 },
      }
      setEdges(es => [...es, newEdge])
    }
    setSelectedId(id)
  }, [nodes, setNodes, setEdges])

  // ── Add AI Validation node ──────────────────────────────────────────────
  const addAiValidation = useCallback(() => {
    // 找到目標步驟節點（選中的或最後一個步驟）
    const targetId = selectedId
      || [...nodes].filter(n => n.type === 'scriptStep' || n.type === 'skillStep')
          .sort((a, b) => b.position.x - a.position.x)[0]?.id
    if (!targetId) { toast.error('請先新增步驟'); return }
    const targetNode = nodes.find(n => n.id === targetId)
    if (!targetNode || targetNode.type === 'aiValidation') {
      toast.error('請選擇一個步驟節點'); return
    }

    const id = `ai-${Date.now()}`
    const data = newAiValidationData(0)
    const newNode: AppNode = {
      id,
      type: 'aiValidation',
      position: { x: targetNode.position.x + 280, y: targetNode.position.y + 20 },
      data,
    }

    const outEdge = edges.find(e => e.source === targetId)
    setNodes(ns => [...ns, newNode])

    if (outEdge) {
      // 插入：移除舊邊，新增兩條邊
      setEdges(es => [
        ...es.filter(e => e.id !== outEdge.id),
        { id: `e-${targetId}-${id}`, source: targetId, target: id, type: 'smoothstep', style: { stroke: '#f59e0b', strokeWidth: 2 } },
        { id: `e-${id}-${outEdge.target}`, source: id, target: outEdge.target, type: 'smoothstep', style: { stroke: '#f59e0b', strokeWidth: 2 } },
      ])
    } else {
      setEdges(es => [...es, {
        id: `e-${targetId}-${id}`, source: targetId, target: id,
        type: 'smoothstep', style: { stroke: '#f59e0b', strokeWidth: 2 },
      }])
    }
    setSelectedId(id)
  }, [nodes, edges, selectedId, setNodes, setEdges])

  // ── Add human confirmation node ──────────────────────────────────────────
  const addHumanConfirm = useCallback(() => {
    const id = `confirm-${Date.now()}`
    const data = newHumanConfirmData(nodes.length)
    const lastNode = [...nodes].sort((a, b) => b.position.x - a.position.x)[0]
    const x = lastNode ? lastNode.position.x + 320 : 100
    const y = lastNode ? lastNode.position.y : 160

    const newNode: AppNode = {
      id, type: 'humanConfirmation',
      position: { x, y },
      data,
    }
    setNodes(ns => [...ns, newNode])

    if (lastNode) {
      const newEdge: Edge = {
        id: `e-${lastNode.id}-${id}`,
        source: lastNode.id,
        target: id,
        type: 'smoothstep',
        style: { stroke: '#10b981', strokeWidth: 2 },
      }
      setEdges(es => [...es, newEdge])
    }
    setSelectedId(id)
  }, [nodes, setNodes, setEdges])

  // ── Add computer_use（桌面自動化）節點 ──────────────────────────────────
  const addComputerUse = useCallback(() => {
    const id = `computer-use-${Date.now()}`
    const data = newComputerUseData(nodes.length)
    const lastNode = [...nodes].sort((a, b) => b.position.x - a.position.x)[0]
    const x = lastNode ? lastNode.position.x + 320 : 100
    const y = lastNode ? lastNode.position.y : 160

    const newNode: AppNode = {
      id, type: 'computerUse',
      position: { x, y },
      data,
    }
    setNodes(ns => [...ns, newNode])

    if (lastNode) {
      const newEdge: Edge = {
        id: `e-${lastNode.id}-${id}`,
        source: lastNode.id,
        target: id,
        type: 'smoothstep',
        style: { stroke: '#9333ea', strokeWidth: 2 },
      }
      setEdges(es => [...es, newEdge])
    }
    setSelectedId(id)
  }, [nodes, setNodes, setEdges])

  // ── Delete step（刪除任何節點時自動重新連線前後節點）──────────────────────────
  const deleteStep = useCallback((id: string) => {
    // 若刪的是 computer_use 節點，順便把磁碟上的錨點資料夾清掉避免殘留
    const target = nodes.find(n => n.id === id)
    if (target && target.type === 'computerUse') {
      const d = target.data as ComputerUseData
      const assets = d.assetsDir ||
        `ai_output/${pipelineName || 'pipeline'}/${d.name}_assets`
      // fire-and-forget：失敗也不中斷刪除流程
      deleteComputerUseAssets(assets).catch(() => {/* ignore */})
    }

    const inEdge  = edges.find(e => e.target === id)
    const outEdge = edges.find(e => e.source === id)
    setEdges(es => {
      let filtered = es.filter(e => e.source !== id && e.target !== id)
      if (inEdge && outEdge) {
        filtered = [...filtered, {
          id: `e-${inEdge.source}-${outEdge.target}`,
          source: inEdge.source,
          target: outEdge.target,
          type: 'smoothstep',
          style: { stroke: '#6366f1', strokeWidth: 2 },
        }]
      }
      return filtered
    })
    setNodes(ns => ns.filter(n => n.id !== id))
    setSelectedId(null)
  }, [nodes, edges, setNodes, setEdges, pipelineName])

  // ── Update step data (works for both scriptStep and skillStep) ─────────────
  const updateStep = useCallback((id: string, patch: Partial<StepData> | Partial<SkillData>) => {
    setNodes(ns => ns.map(n =>
      n.id === id ? { ...n, data: { ...n.data, ...patch } } : n
    ))
  }, [setNodes])

  // ── Update AI validation node data ─────────────────────────────────────
  const updateAiNode = useCallback((id: string, patch: Partial<AiValidationData>) => {
    setNodes(ns => ns.map(n =>
      n.id === id ? { ...n, data: { ...n.data, ...patch } } : n
    ))
  }, [setNodes])

  // ── Connect ───────────────────────────────────────────────────────────────
  const onConnect = useCallback((connection: Connection) => {
    const edge: Edge = {
      ...connection,
      id: `e-${connection.source}-${connection.target}`,
      type: 'smoothstep',
      style: { stroke: '#6366f1', strokeWidth: 2 },
      selectable: true,
    }
    setEdges(es => addEdge(edge, es))
  }, [setEdges])

  // ── Import from YAML ──────────────────────────────────────────────────────
  // mode: 'new' = 建立新工作流（不碰目前的）；'overwrite' = 覆蓋目前工作流
  const importYaml = useCallback(async (yaml: string, mode: 'new' | 'overwrite' = 'overwrite') => {
    const parsed = parseYaml(yaml)
    if (!parsed) { toast.error('YAML 格式有誤'); return }
    const { nodes: ns, edges: es } = stepsToFlow(parsed.steps)

    if (mode === 'new') {
      // 名字衝突自動加 " 2" / " 3" …
      const existing = useWorkflowStore.getState().workflows
      let name = parsed.name || '新工作流'
      if (existing.some(w => w.name === name)) {
        let i = 2
        while (existing.some(w => w.name === `${name} ${i}`)) i++
        name = `${name} ${i}`
      }
      const newId = await createWorkflow(name)   // store 會把 activeId 切到新 workflow
      // activeId useEffect 會在 30ms 後把（剛建立的空）新 workflow 載入畫布，
      // 所以我們要晚於它才寫入，不然會被空畫布覆蓋
      setTimeout(() => {
        setPipelineName(name)
        setNodes(ns)
        setEdges(es)
        // activeId useEffect 會把 savingRef 卡住 ~1s，這段時間 autoSave 被 block，
        // 所以新工作流內容無法自動存進後端 → 直接手動 saveCanvas 一次
        saveCanvas(newId, ns as AppNode[], es)
      }, 120)
      toast.success(`已建立新工作流「${name}」`)
    } else {
      setPipelineName(parsed.name)
      setNodes(ns)
      setEdges(es)
      toast.success('已覆蓋目前工作流')
    }
    setShowYaml(false)
  }, [setNodes, setEdges, createWorkflow, saveCanvas])

  // ── Run pipeline ──────────────────────────────────────────────────────────
  const handleRunClick = async () => {
    const stepNodes = nodes.filter(n => n.type === 'scriptStep' || n.type === 'skillStep' || n.type === 'humanConfirmation' || n.type === 'computerUse')
    if (stepNodes.length === 0) { toast.error('請先新增步驟'); return }
    const steps = flowToSteps(nodes, edges)
    // computer_use 節點用 actions 而非 batch；人工確認也不需要 batch
    const emptyStep = steps.find(s => !s.batch?.trim() && !s.humanConfirm && !s.computerUse)
    if (emptyStep) {
      toast.error(`步驟「${emptyStep.name}」尚未設定${emptyStep.skillMode ? '任務描述' : '執行指令'}，請點擊該步驟方塊填入`)
      return
    }
    // computer_use 節點若沒動作，明確提示
    const emptyCu = steps.find(s => s.computerUse && (!s.computerUseActions || s.computerUseActions.length === 0))
    if (emptyCu) {
      toast.error(`桌面自動化節點「${emptyCu.name}」尚未錄製動作，請開啟節點面板點「開始錄製」`)
      return
    }
    // 查詢 recipe 狀態，然後顯示選擇 dialog
    const skillSteps = steps.filter(s => s.skillMode).map(s => s.name)
    if (skillSteps.length > 0) {
      try {
        const status = await getRecipeStatus(activeId || pipelineName, skillSteps)
        setRecipeStatus(status)
      } catch {
        setRecipeStatus(null)
      }
    } else {
      setRecipeStatus(null)
    }
    setShowRunDialog(true)
  }

  const handleRunConfirm = async (useRecipe: boolean) => {
    setShowRunDialog(false)
    const yaml = getYaml()
    setRunning(true)
    setRunStatus('running')
    useRunStatusStore.getState().resetAll()
    try {
      const steps = flowToSteps(nodes, edges)
      const needsValidate = steps.some(s => s.skillMode || !!s.expect)
      const hasSkill = steps.some(s => s.skillMode)
      const res = await startPipeline(yaml, needsValidate, useRecipe, activeId ?? undefined, hasSkill)
      runIdRef.current = res.run_id
      toast.success(`Pipeline 已啟動（ID: ${res.run_id}）${useRecipe ? ' ⚡ 快速模式' : ''}`)
      pollStatus(res.run_id)
      pollRef.current = setInterval(() => pollStatus(res.run_id), 1500)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '啟動失敗')
      setRunning(false)
      setRunStatus('failed')
    }
  }

  // 中止後：拉取最終 log 與節點狀態，然後延遲重啟背景偵測
  const finalizeAbort = async (rid: string) => {
    // 等一下讓後端處理完中止
    await new Promise(r => setTimeout(r, 1500))
    try {
      const [data, logRes] = await Promise.all([
        getPipelineRun(rid).catch(() => null),
        getPipelineLog(rid).catch(() => null),
      ])
      // 更新 log 面板
      if (logRes?.log) setLogLines(logRes.log.split('\n'))
      // 更新節點狀態
      if (data) {
        const statusMap: Record<string, { status: 'idle' | 'running' | 'success' | 'failed'; errorMsg: string }> = {}
        const steps = data.config_dict?.steps ?? []
        for (const step of steps) {
          const result = data.step_results?.find((s: any) => s.step_name === step.name)
          if (result) {
            statusMap[step.name] = {
              status: result.validation_status === 'failed' ? 'failed' : 'success',
              errorMsg: result.validation_reason ?? '',
            }
          } else {
            // 未完成的步驟標記為 idle（中止後不再 running）
            statusMap[step.name] = { status: 'idle', errorMsg: '' }
          }
        }
        useRunStatusStore.getState().setBulkStatus(statusMap)
      }
      useRunStatusStore.getState().setEdgesAnimated(false)
    } catch { /* ignore — UI 已設為 failed */ }
    // 延遲重啟背景偵測
    setTimeout(() => {
      if (!bgDetectRef.current && pipelineName) {
        const detect = async () => {
          if (runIdRef.current) return
          try {
            const runs = await getPipelineRuns()
            const active = runs.find(
              (r: any) => (r.status === 'running' || r.status === 'awaiting_human') && r.pipeline_name === pipelineName
            )
            if (active && !runIdRef.current) {
              runIdRef.current = active.run_id
              setRunning(true)
              if (active.status === 'awaiting_human') {
                setRunStatus('awaiting')
                setAwaitingRunId(active.run_id)
                const at = (active as any).awaiting_type
                const mapped = at === 'human_confirm' ? 'confirm' : at === 'ask_user' ? 'ask_user' : 'failure'
                setAwaitingType(mapped)
                setAwaitingMessage((active as any).awaiting_message || '')
                setAwaitingSuggestion((active as any).awaiting_suggestion || '')
                if (mapped === 'ask_user') {
                  try {
                    const meta = JSON.parse((active as any).awaiting_suggestion || '{}')
                    setAskUserOptions(meta.options || [])
                    setAskUserContext(meta.context || '')
                  } catch { setAskUserOptions([]); setAskUserContext('') }
                }
              } else {
                setRunStatus('running')
              }
              setShowLog(true)
              toast.info('偵測到排程執行中')
              pollStatus(active.run_id)
              pollRef.current = setInterval(() => pollStatus(active.run_id), 1500)
            }
          } catch { /* ignore */ }
        }
        bgDetectRef.current = setInterval(detect, 3000)
      }
    }, 3500)
  }

  const handleAbort = async () => {
    const rid = runIdRef.current
    if (!rid) return
    // 立即清除所有 UI 狀態（避免 in-flight poll 覆蓋）
    runIdRef.current = null
    if (pollRef.current) clearInterval(pollRef.current)
    if (bgDetectRef.current) { clearInterval(bgDetectRef.current); bgDetectRef.current = null }
    setRunning(false)
    setRunStatus('failed')
    setAwaitingRunId(null)
    toast.dismiss('awaiting')
    try {
      // 執行中（running）用 force abort（/abort），才能 kill 子進程
      const res = await abortPipeline(rid)
      toast.info(res.message)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '中止失敗')
    }
    finalizeAbort(rid)
  }

  const pollStatus = async (runId: string) => {
    // 若 polling 已被中止（abort/清除），直接丟棄此次回應
    if (!runIdRef.current) return
    try {
      const [data, logRes] = await Promise.all([
        getPipelineRun(runId),
        getPipelineLog(runId).catch(() => null),
      ])

      // 再次確認：收到回應後若 runId 已被清除，不處理
      if (!runIdRef.current) return

      // 每次 poll 同步更新 log
      if (logRes?.log) setLogLines(logRes.log.split('\n'))

      // 透過外部 store 更新節點狀態（避免 setNodes 觸發 ReactFlow ForwardRef 衝突）
      const currentStepName = data.config_dict?.steps?.[data.current_step]?.name
      const statusMap: Record<string, { status: 'idle' | 'running' | 'success' | 'failed'; errorMsg: string }> = {}
      const steps = data.config_dict?.steps ?? []
      for (const step of steps) {
        if ((data.status === 'running' || data.status === 'awaiting_human') && step.name === currentStepName) {
          statusMap[step.name] = { status: 'running', errorMsg: '' }
          continue
        }
        const result = data.step_results?.find(s => s.step_name === step.name)
        if (result) {
          statusMap[step.name] = {
            status: result.validation_status === 'failed' ? 'failed' : 'success',
            errorMsg: result.validation_reason ?? '',
          }
        }
      }
      useRunStatusStore.getState().setBulkStatus(statusMap)
      useRunStatusStore.getState().setEdgesAnimated(data.status === 'running')

      // 等待人工決策（繼續 polling，這樣 Telegram 確認後前端也能偵測到）
      if (data.status === 'awaiting_human') {
        if (runStatusRef.current !== 'awaiting') {
          // 首次進入 awaiting 才顯示 toast
          setRunning(false)
          setRunStatus('awaiting')
          setAwaitingRunId(runId)
          const at = data.awaiting_type
          const mapped = at === 'human_confirm' ? 'confirm' : at === 'ask_user' ? 'ask_user' : 'failure'
          setAwaitingType(mapped)
          setAwaitingMessage(data.awaiting_message || '')
          setAwaitingSuggestion(data.awaiting_suggestion || '')
          if (mapped === 'ask_user') {
            try {
              const meta = JSON.parse(data.awaiting_suggestion || '{}')
              setAskUserOptions(meta.options || [])
              setAskUserContext(meta.context || '')
            } catch { setAskUserOptions([]); setAskUserContext('') }
            toast.info('❓ AI 請求人工回答', { duration: 0, id: 'awaiting' })
          } else {
            toast[mapped === 'confirm' ? 'info' : 'warning'](
              mapped === 'confirm' ? '✋ 等待人工確認' : '步驟執行失敗，請選擇處理方式',
              { duration: 0, id: 'awaiting' }
            )
          }
        }
        return
      }
      // 如果之前在 awaiting，現在狀態改變了（Telegram 確認了 / 前端按繼續了）→ 重新同步
      if (runStatusRef.current === 'awaiting') {
        setAwaitingRunId(null)
        setAwaitingSuggestion('')
        setShowHintInput(false)
        setHintText('')
        setAskUserOptions([])
        setAskUserContext('')
        setAskUserAnswer('')
        toast.dismiss('awaiting')
        // 如果後端已是 completed/failed/aborted，不設 idle，讓下方 done 分支處理
        if (data.status === 'running') {
          setRunStatus('running')
          setRunning(true)
          toast.success('Pipeline 已恢復執行')
        }
      }

      const done = data.status === 'completed' || data.status === 'failed' || data.status === 'aborted'
      if (done) {
        clearInterval(pollRef.current!)
        runIdRef.current = null
        setRunning(false)
        toast.dismiss('awaiting')
        const success = data.status === 'completed'
        setRunStatus(success ? 'success' : 'failed')
        setAwaitingRunId(null)
        toast[success ? 'success' : 'error'](success ? 'Pipeline 執行完成 ✓' : data.status === 'aborted' ? 'Pipeline 已中止' : 'Pipeline 執行失敗')
        // 成功且有待確認的 recipes → 顯示確認對話框
        if (success && data.pending_recipes && data.pending_recipes.length > 0) {
          setPendingRecipeRunId(data.run_id)
          setPendingRecipeCount(data.pending_recipes.length)
          setShowRecipeConfirm(true)
        }
        // 刷新 recipe 狀態（成功後可能有新 recipe）
        if (success) {
          const steps = flowToSteps(nodes as AppNode[], edges)
          const skillSteps = steps.filter(s => s.skillMode).map(s => s.name)
          if (skillSteps.length > 0) {
            getRecipeStatus(pipelineName, skillSteps).then(status => {
              const map: Record<string, boolean> = {}
              for (const [name, info] of Object.entries(status.steps)) {
                if (info.has_recipe) map[name] = true
              }
              useRunStatusStore.getState().setRecipeSteps(map)
            }).catch(() => {})
          }
        }
      }
    } catch (e) {
      // 忽略「找不到 pipeline run」的 404（背景任務可能尚未註冊），下次 poll 會自動重試
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes('找不到')) { console.warn('[pollStatus] run 尚未註冊，等待下次 poll'); return }
      console.error('[pollStatus]', e)
      toast.error(`Poll 錯誤: ${msg}`)
    }
  }

  // 人工決策後繼續 polling
  const [hintText, setHintText] = useState('')
  const [showHintInput, setShowHintInput] = useState(false)

  const handleDecision = async (decision: 'retry' | 'skip' | 'abort' | 'continue' | 'retry_with_hint' | 'answer', hint?: string) => {
    if (!awaitingRunId) return
    const rid = awaitingRunId

    if (decision === 'abort') {
      // 立即清除 UI 狀態
      setRunStatus('failed')
      setRunning(false)
      setAwaitingRunId(null)
      runIdRef.current = null
      toast.dismiss('awaiting')
      if (pollRef.current) clearInterval(pollRef.current)
      if (bgDetectRef.current) { clearInterval(bgDetectRef.current); bgDetectRef.current = null }
      setShowHintInput(false)
      setHintText('')
      try {
        // 走和重試相同的 /resume 路徑（已支援 decision='abort'），避免 /abort 端點問題
        await resumePipeline(rid, 'abort')
        toast.info('Pipeline 已中止')
      } catch (e) {
        toast.error(e instanceof Error ? e.message : '中止失敗（後端狀態可能已變更）')
      }
      finalizeAbort(rid)
      return
    }

    try {
      await resumePipeline(rid, decision, hint)
      // Guard：poll 可能在 await 期間已完成 pipeline（例如最後一步是人工確認）
      // 此時 runIdRef.current 已被 poll 的 done 分支清空，不可再覆寫狀態
      setAwaitingRunId(null)
      toast.dismiss('awaiting')
      setShowHintInput(false)
      setHintText('')
      if (runIdRef.current) {
        setRunStatus('running')
        setRunning(true)
        // 立即觸發一次 poll，捕捉「最後一步是人工確認 → 直接完成」的情境
        setTimeout(() => pollStatus(rid), 500)
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '操作失敗')
    }
  }

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current) }, [])

  // log 自動捲到底（僅在用戶未手動上捲時）
  useEffect(() => {
    if (showLog && logAutoScrollRef.current) logEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logLines, showLog])

  // 開啟 log 時重置 auto-scroll
  useEffect(() => { if (showLog) logAutoScrollRef.current = true }, [showLog])

  // ── Editable pipeline name ────────────────────────────────────────────────
  const RunStatusIcon = runStatus === 'running' ? <Loader2 className="w-4 h-4 animate-spin" />
    : runStatus === 'success' ? <CheckCircle2 className="w-4 h-4 text-green-500" />
    : runStatus === 'failed'  ? <XCircle className="w-4 h-4 text-red-500" />
    : null

  return (
    <div className="h-screen flex overflow-hidden bg-gray-50" style={{ fontFamily: "'Inter', 'Noto Sans TC', sans-serif" }}>
      <Toaster richColors position="top-right" />

      {/* ── Left Sidebar ── */}
      <Sidebar onYamlApply={importYaml} />

      {/* ── Right: Toolbar + Canvas ── */}
      <div className="flex-1 flex flex-col overflow-hidden">

      {/* ── Toolbar ── */}
      <header className="h-14 bg-white border-b border-gray-200 flex items-center px-4 gap-3 shrink-0 z-20 shadow-sm">
        <div className="w-px h-6 bg-gray-200 shrink-0 hidden" />

        {/* Pipeline name */}
        {editingName ? (
          <input
            autoFocus
            value={pipelineName}
            onChange={e => setPipelineName(e.target.value)}
            onBlur={() => setEditingName(false)}
            onKeyDown={e => e.key === 'Enter' && setEditingName(false)}
            className="text-sm font-medium border-b-2 border-indigo-400 outline-none bg-transparent text-gray-800 min-w-0 flex-1 max-w-[500px]"
          />
        ) : (
          <button onClick={() => setEditingName(true)}
            title={pipelineName}
            className="text-sm font-medium text-gray-800 hover:text-indigo-600 transition-colors whitespace-nowrap shrink-0">
            {pipelineName}
          </button>
        )}

        {RunStatusIcon && <span>{RunStatusIcon}</span>}
        <div className="flex-1" />

        {/* YAML */}
        <button
          onClick={() => setShowYaml(!showYaml)}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm border transition-colors
            ${showYaml ? 'bg-indigo-50 border-indigo-300 text-indigo-700' : 'border-gray-200 text-gray-600 hover:border-indigo-300 hover:text-indigo-600'}`}
        >
          <Code2 className="w-3.5 h-3.5" /> YAML
        </button>

        {/* Log */}
        <button
          onClick={() => setShowLog(!showLog)}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm border transition-colors
            ${showLog ? 'bg-gray-900 border-gray-700 text-gray-100' : 'border-gray-200 text-gray-600 hover:border-gray-400 hover:text-gray-800'}`}
        >
          <Terminal className="w-3.5 h-3.5" /> Log
          {running && <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />}
        </button>

        {/* Schedule */}
        <button
          onClick={async () => {
            const steps = flowToSteps(nodes, edges)
            const skillSteps = steps.filter(s => s.skillMode).map(s => s.name)
            if (skillSteps.length > 0) {
              try {
                const status = await getRecipeStatus(activeId || pipelineName, skillSteps)
                setRecipeStatus(status)
              } catch { setRecipeStatus(null) }
            } else { setRecipeStatus(null) }
            setShowSchedule(true)
          }}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm border border-gray-200 text-gray-600 hover:border-indigo-300 hover:text-indigo-600 transition-colors"
        >
          <Clock className="w-3.5 h-3.5" /> 排程
        </button>

        {/* Run / Stop */}
        {running ? (
          <button
            onClick={handleAbort}
            className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm bg-red-600 text-white hover:bg-red-700 transition-colors font-medium shadow-sm"
          >
            <Square className="w-3.5 h-3.5" /> 停止
          </button>
        ) : (
          <button
            onClick={handleRunClick}
            disabled={nodes.filter(n => n.type === 'scriptStep' || n.type === 'skillStep' || n.type === 'humanConfirmation' || n.type === 'computerUse').length === 0}
            className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors font-medium shadow-sm"
          >
            <Play className="w-3.5 h-3.5" /> 執行
          </button>
        )}
      </header>

      {/* ── Canvas area ── */}
      <div className="flex-1 relative overflow-hidden">
        <ReactFlow
          nodes={nodes}
          edges={displayEdges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeClick={onNodeClick}
          onPaneClick={onPaneClick}
          onInit={onInit}
          minZoom={0.2}
          maxZoom={2}
          deleteKeyCode={['Delete', 'Backspace']}
          defaultEdgeOptions={{ selectable: true }}
        >
          {/* Dotted grid background */}
          <Background
            variant={BackgroundVariant.Dots}
            gap={20}
            size={1.5}
            color="#d1d5db"
          />
          <Controls position="bottom-left" showInteractive={false} />
          <MiniMap
            position="bottom-right"
            nodeColor={miniMapNodeColor}
            style={{ background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 8 }}
          />

          {/* Add node buttons (top-left of canvas) */}
          <Panel position="top-left">
            <div className="flex gap-2">
              <button
                onClick={addScriptStep}
                title="新增一個執行 Python 腳本/指令的步驟"
                className="flex items-center gap-1.5 px-3 py-2 bg-white border border-blue-200 rounded-xl text-sm text-blue-600 hover:border-blue-400 hover:bg-blue-50 shadow-sm transition-colors"
              >
                <Plus className="w-3.5 h-3.5" /> Python腳本
              </button>
              <button
                onClick={addAiValidation}
                title="新增 AI 快速驗證節點"
                className="flex items-center gap-1.5 px-3 py-2 bg-white border border-amber-200 rounded-xl text-sm text-amber-600 hover:border-amber-400 hover:bg-amber-50 shadow-sm transition-colors"
              >
                <Plus className="w-3.5 h-3.5" /> AI驗證
              </button>
              <button
                onClick={addSkillStep}
                title="新增 AI 自動化步驟（自動寫程式碼）"
                className="flex items-center gap-1.5 px-3 py-2 bg-white border border-purple-200 rounded-xl text-sm text-purple-600 hover:border-purple-400 hover:bg-purple-50 shadow-sm transition-colors"
              >
                <Plus className="w-3.5 h-3.5" /> AI技能
              </button>
              <button
                onClick={addHumanConfirm}
                title="新增人工確認節點（暫停等待確認後繼續）"
                className="flex items-center gap-1.5 px-3 py-2 bg-white border border-emerald-200 rounded-xl text-sm text-emerald-600 hover:border-emerald-400 hover:bg-emerald-50 shadow-sm transition-colors"
              >
                <Plus className="w-3.5 h-3.5" /> 人工確認
              </button>
              <button
                onClick={addComputerUse}
                title="新增桌面自動化節點（錄製滑鼠鍵盤操作後重播）"
                className="flex items-center gap-1.5 px-3 py-2 bg-white border border-fuchsia-200 rounded-xl text-sm text-fuchsia-700 hover:border-fuchsia-400 hover:bg-fuchsia-50 shadow-sm transition-colors"
              >
                <Plus className="w-3.5 h-3.5" /> 桌面自動化
              </button>
            </div>
          </Panel>
        </ReactFlow>

        {/* Awaiting human decision banner */}
        {runStatus === 'awaiting' && awaitingRunId && awaitingType === 'failure' && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 z-40 bg-amber-50 border border-amber-200 rounded-2xl shadow-lg px-5 py-3 space-y-2 max-w-[600px] w-[95%]">
            {/* 標題列 + 操作按鈕 */}
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-amber-600 font-medium text-sm whitespace-nowrap">⚠️ 步驟失敗，請選擇處理方式</span>
              <div className="flex items-center gap-2 ml-auto">
                <button onClick={() => handleDecision('retry')} className="px-3 py-1.5 bg-blue-600 text-white rounded-lg text-xs font-medium hover:bg-blue-700 whitespace-nowrap">🔄 重試</button>
                <button onClick={() => setShowHintInput(!showHintInput)} className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap ${showHintInput ? 'bg-purple-700 text-white' : 'bg-purple-600 text-white hover:bg-purple-700'}`}>💬 補充指示</button>
                <button onClick={() => handleDecision('abort')} className="px-3 py-1.5 bg-red-600 text-white rounded-lg text-xs font-medium hover:bg-red-700 whitespace-nowrap">🛑 中止</button>
              </div>
            </div>
            {/* 失敗原因 */}
            {awaitingMessage && (
              <div className="bg-amber-100 border border-amber-200 rounded-lg px-3 py-2">
                <p className="text-xs font-semibold text-amber-700 mb-0.5">失敗原因</p>
                <p className="text-xs text-amber-800 leading-relaxed">{awaitingMessage}</p>
              </div>
            )}
            {/* AI 解決建議 */}
            {awaitingSuggestion && (
              <div className="bg-blue-50 border border-blue-200 rounded-lg px-3 py-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-semibold text-blue-700 mb-0.5">💡 AI 建議</p>
                    <p className="text-xs text-blue-800 leading-relaxed">{awaitingSuggestion}</p>
                  </div>
                  <a
                    href="/settings"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="shrink-0 px-2.5 py-1.5 bg-blue-600 text-white rounded-lg text-xs font-medium hover:bg-blue-700 whitespace-nowrap"
                    title="前往設定頁面安裝套件"
                  >⚙️ 安裝套件</a>
                </div>
              </div>
            )}
            {/* 補充指示輸入框 */}
            {showHintInput && (
              <div className="flex gap-2">
                <input
                  value={hintText}
                  onChange={e => setHintText(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && hintText.trim()) handleDecision('retry_with_hint', hintText.trim()) }}
                  placeholder="例如：改用 playwright、調整抓取邏輯…"
                  className="flex-1 border border-amber-300 rounded-lg px-2.5 py-1.5 text-xs outline-none focus:border-purple-400 bg-white"
                  autoFocus
                />
                <button
                  onClick={() => hintText.trim() && handleDecision('retry_with_hint', hintText.trim())}
                  disabled={!hintText.trim()}
                  className="px-3 py-1.5 bg-purple-600 text-white rounded-lg text-xs font-medium hover:bg-purple-700 disabled:opacity-50"
                >送出</button>
              </div>
            )}
          </div>
        )}
        {/* Human confirmation banner */}
        {runStatus === 'awaiting' && awaitingRunId && awaitingType === 'confirm' && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 z-40 bg-emerald-50 border border-emerald-200 rounded-2xl shadow-lg px-5 py-3 space-y-2 max-w-[560px]">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-emerald-700 font-medium text-sm whitespace-nowrap">✋ 等待人工確認</span>
              <span className="text-emerald-600 text-xs max-w-[200px] truncate">{awaitingMessage}</span>
              <div className="flex items-center gap-2 ml-auto">
                <button onClick={() => handleDecision('continue')} className="px-3 py-1.5 bg-emerald-600 text-white rounded-lg text-xs font-medium hover:bg-emerald-700 whitespace-nowrap">✅ 繼續</button>
                <button onClick={() => setShowHintInput(!showHintInput)} className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap ${showHintInput ? 'bg-purple-700 text-white' : 'bg-purple-600 text-white hover:bg-purple-700'}`}>💬 補充指示</button>
                <button onClick={() => handleDecision('abort')} className="px-3 py-1.5 bg-red-600 text-white rounded-lg text-xs font-medium hover:bg-red-700 whitespace-nowrap">🛑 中止</button>
              </div>
            </div>
            {showHintInput && (
              <div className="flex gap-2">
                <input
                  value={hintText}
                  onChange={e => setHintText(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && hintText.trim()) handleDecision('retry_with_hint', hintText.trim()) }}
                  placeholder="補充指示後會重做上一步，例如：改抓 20 筆、用其他網站…"
                  className="flex-1 border border-emerald-300 rounded-lg px-2.5 py-1.5 text-xs outline-none focus:border-purple-400 bg-white"
                  autoFocus
                />
                <button
                  onClick={() => hintText.trim() && handleDecision('retry_with_hint', hintText.trim())}
                  disabled={!hintText.trim()}
                  className="px-3 py-1.5 bg-purple-600 text-white rounded-lg text-xs font-medium hover:bg-purple-700 disabled:opacity-50 whitespace-nowrap"
                >送出</button>
              </div>
            )}
          </div>
        )}

        {/* ask_user banner — skill agent 詢問使用者 */}
        {runStatus === 'awaiting' && awaitingRunId && awaitingType === 'ask_user' && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 z-40 bg-sky-50 border border-sky-200 rounded-2xl shadow-lg px-5 py-3 space-y-2 max-w-[640px] w-[90vw]">
            <div className="flex items-start gap-2">
              <span className="text-sky-700 font-medium text-sm whitespace-nowrap">❓ AI 請求回答</span>
              <div className="flex-1 min-w-0 text-sm text-gray-800 break-words">{awaitingMessage}</div>
            </div>
            {askUserContext && (
              <div className="text-xs text-gray-500 bg-white/60 rounded px-2 py-1 border border-sky-100">
                <span className="font-medium">背景：</span>{askUserContext}
              </div>
            )}
            {askUserOptions.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {askUserOptions.map(opt => (
                  <button
                    key={opt}
                    onClick={() => handleDecision('answer', opt)}
                    className="px-3 py-1.5 bg-sky-600 text-white rounded-lg text-xs font-medium hover:bg-sky-700"
                  >{opt}</button>
                ))}
              </div>
            )}
            <div className="flex gap-2">
              <input
                value={askUserAnswer}
                onChange={e => setAskUserAnswer(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && askUserAnswer.trim()) { handleDecision('answer', askUserAnswer.trim()); setAskUserAnswer('') } }}
                placeholder={askUserOptions.length > 0 ? '或輸入自訂答案…' : '請輸入答案…'}
                className="flex-1 border border-sky-300 rounded-lg px-2.5 py-1.5 text-xs outline-none focus:border-sky-500 bg-white"
                autoFocus
              />
              <button
                onClick={() => { if (askUserAnswer.trim()) { handleDecision('answer', askUserAnswer.trim()); setAskUserAnswer('') } }}
                disabled={!askUserAnswer.trim()}
                className="px-3 py-1.5 bg-sky-600 text-white rounded-lg text-xs font-medium hover:bg-sky-700 disabled:opacity-50 whitespace-nowrap"
              >送出</button>
              <button onClick={() => handleDecision('abort')} className="px-3 py-1.5 bg-red-600 text-white rounded-lg text-xs font-medium hover:bg-red-700 whitespace-nowrap">🛑 中止</button>
            </div>
          </div>
        )}

        {/* Empty state */}
        {nodes.filter(n => n.type === 'scriptStep' || n.type === 'skillStep' || n.type === 'humanConfirmation' || n.type === 'computerUse').length === 0 && <EmptyState onAdd={addScriptStep} />}

        {/* Node config panel */}
        {selectedNode && selectedNode.type === 'computerUse' ? (
          <ComputerUsePanel
            node={selectedNode as ComputerUseNode}
            pipelineName={pipelineName}
            onUpdate={patch => updateStep(selectedNode.id, patch as Partial<StepData>)}
            onClose={() => setSelectedId(null)}
            onDelete={() => deleteStep(selectedNode.id)}
          />
        ) : selectedNode && selectedNode.type === 'humanConfirmation' ? (
          <HumanConfirmPanel
            node={selectedNode as HumanConfirmNode}
            onUpdate={patch => updateStep(selectedNode.id, patch as Partial<StepData>)}
            onClose={() => setSelectedId(null)}
            onDelete={() => deleteStep(selectedNode.id)}
          />
        ) : selectedNode && selectedNode.type === 'aiValidation' ? (
          <AiValidationPanel
            data={selectedNode.data as AiValidationData}
            onUpdate={patch => updateAiNode(selectedNode.id, patch)}
            onClose={() => setSelectedId(null)}
            onDelete={() => deleteStep(selectedNode.id)}
          />
        ) : selectedNode && selectedNode.type === 'skillStep' ? (
          <SkillConfigPanel
            node={selectedNode as SkillNode}
            onUpdate={patch => updateStep(selectedNode.id, patch as Partial<StepData>)}
            onClose={() => setSelectedId(null)}
            onDelete={() => deleteStep(selectedNode.id)}
          />
        ) : selectedNode && selectedNode.type === 'scriptStep' ? (
          <ScriptConfigPanel
            node={selectedNode as ScriptNode}
            onUpdate={patch => updateStep(selectedNode.id, patch)}
            onClose={() => setSelectedId(null)}
            onDelete={() => deleteStep(selectedNode.id)}
            aiExpectText={
              (() => {
                const outEdge = edges.find(e => e.source === selectedNode.id)
                if (!outEdge) return undefined
                const nextNode = nodes.find(n => n.id === outEdge.target)
                return nextNode?.type === 'aiValidation'
                  ? (nextNode.data as AiValidationData).expectText || undefined
                  : undefined
              })()
            }
          />
        ) : null}

        {/* YAML panel */}
        {showYaml && (
          <YamlPanel
            yaml={getYaml()}
            onImport={importYaml}
            onClose={() => setShowYaml(false)}
          />
        )}

        {/* Terminal log panel */}
        {showLog && (
          <div
            className="absolute bottom-0 left-0 right-0 bg-gray-950 border-t border-gray-700 flex flex-col z-30"
            style={{ height: logHeight, userSelect: logResizing ? 'none' : undefined }}
          >
            {/* Resize handle（上邊緣） */}
            <div
              onMouseDown={(e) => { e.preventDefault(); setLogResizing(true) }}
              onDoubleClick={() => setLogHeight(LOG_DEFAULT_HEIGHT)}
              title="拖曳調整高度・雙擊還原"
              className={`absolute top-0 left-0 right-0 h-1 cursor-row-resize z-10 transition-colors ${
                logResizing ? 'bg-indigo-500' : 'hover:bg-indigo-400'
              }`}
            />
            <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-800 shrink-0">
              <Terminal className="w-3.5 h-3.5 text-gray-400" />
              <span className="text-xs text-gray-400 font-mono">Pipeline Log</span>
              {running && <span className="text-xs text-green-400 animate-pulse">● 執行中</span>}
              {!running && runIdRef.current && <span className="text-xs text-gray-500">Run: {runIdRef.current}</span>}
              <div className="flex-1" />
              <button onClick={() => setLogLines([])} className="text-xs text-gray-500 hover:text-gray-300 px-2">清除</button>
              <button onClick={() => setShowLog(false)} className="text-gray-500 hover:text-gray-300">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <div ref={logContainerRef} className="flex-1 overflow-y-auto p-3 font-mono text-xs leading-5"
              onScroll={() => {
                const el = logContainerRef.current
                if (!el) return
                logAutoScrollRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 30
              }}>
              {logLines.length === 0 && (
                <span className="text-gray-600">尚無 log — 請先執行 Pipeline</span>
              )}
              {logLines.map((line, i) => (
                <div key={i} className={
                  /error|fail|錯誤|失敗/i.test(line) ? 'text-red-400' :
                  /warn|warning/i.test(line) ? 'text-yellow-400' :
                  /success|完成|✓/i.test(line) ? 'text-green-400' :
                  'text-gray-300'
                }>{line || '\u00a0'}</div>
              ))}
              <div ref={logEndRef} />
            </div>
          </div>
        )}
      </div>

      {/* Schedule dialog */}
      {showSchedule && (
        <ScheduleDialog yaml={getYaml()} pipelineName={pipelineName} workflowId={activeId ?? null} recipeStatus={recipeStatus} onClose={() => setShowSchedule(false)} />
      )}

      {/* Run dialog */}
      {showRunDialog && (
        <RunDialog
          recipeStatus={recipeStatus}
          onRun={handleRunConfirm}
          onClose={() => setShowRunDialog(false)}
        />
      )}

      {/* Recipe 覆蓋確認 */}
      {showRecipeConfirm && pendingRecipeRunId && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl shadow-2xl p-6 max-w-sm w-full mx-4">
            <h3 className="text-base font-semibold text-gray-900 mb-2">💾 儲存 Recipe？</h3>
            <p className="text-sm text-gray-600 mb-4">
              Pipeline 執行成功，有 {pendingRecipeCount} 個 AI 技能步驟產生了新的 Recipe。
              是否覆蓋現有 Recipe？
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => {
                  setShowRecipeConfirm(false)
                  setPendingRecipeRunId(null)
                  toast.info('已跳過 Recipe 儲存')
                }}
                className="px-4 py-2 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50"
              >
                不儲存
              </button>
              <button
                onClick={async () => {
                  try {
                    const res = await savePendingRecipes(pendingRecipeRunId)
                    toast.success(`已儲存 ${res.saved} 個 Recipe`)
                    // 刷新 recipe 狀態
                    const steps = flowToSteps(nodes as AppNode[], edges)
                    const skillSteps = steps.filter(s => s.skillMode).map(s => s.name)
                    if (skillSteps.length > 0) {
                      getRecipeStatus(pipelineName, skillSteps).then(status => {
                        const map: Record<string, boolean> = {}
                        for (const [name, info] of Object.entries(status.steps)) {
                          if (info.has_recipe) map[name] = true
                        }
                        useRunStatusStore.getState().setRecipeSteps(map)
                      }).catch(() => {})
                    }
                  } catch (e) {
                    toast.error(e instanceof Error ? e.message : '儲存失敗')
                  }
                  setShowRecipeConfirm(false)
                  setPendingRecipeRunId(null)
                }}
                className="px-4 py-2 text-sm bg-purple-600 text-white rounded-lg hover:bg-purple-700 font-medium"
              >
                覆蓋儲存
              </button>
            </div>
          </div>
        </div>
      )}
      </div>{/* end right column */}
    </div>
  )
}
