'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, BookOpen, RefreshCw, Trash2, CheckCircle2, XCircle, Code2, ChevronDown, ChevronRight } from 'lucide-react'
import { toast, Toaster } from 'sonner'
import { listRecipes, deleteRecipe, deleteWorkflowRecipes, listWorkflows, type Recipe, type WorkflowData } from '@/lib/api'
import { cn } from '@/lib/utils'

function formatTime(ts: number): string {
  if (!ts) return '—'
  const d = new Date(ts * 1000)
  return d.toLocaleString('zh-TW', { hour12: false })
}

function formatDuration(sec: number): string {
  if (!sec) return '—'
  if (sec < 60) return `${sec.toFixed(1)}s`
  return `${(sec / 60).toFixed(1)}m`
}

export default function RecipesPage() {
  const [recipes, setRecipes] = useState<Recipe[]>([])
  const [workflows, setWorkflows] = useState<WorkflowData[]>([])
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    try {
      const [data, wfs] = await Promise.all([listRecipes(), listWorkflows()])
      setRecipes(data)
      setWorkflows(wfs)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  // workflow_id → name 的查找表
  const wfNames = useMemo(() => {
    const map = new Map<string, string>()
    workflows.forEach(w => map.set(w.id, w.name))
    return map
  }, [workflows])

  // 依 workflow 分組
  const grouped = useMemo(() => {
    const map = new Map<string, Recipe[]>()
    recipes.forEach(r => {
      const key = r.workflow_id
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(r)
    })
    return Array.from(map.entries()).map(([wfId, list]) => ({
      workflowId: wfId,
      workflowName: wfNames.get(wfId) || wfId,
      list: list.sort((a, b) => a.step_name.localeCompare(b.step_name)),
    }))
  }, [recipes, wfNames])

  const handleDeleteOne = async (r: Recipe) => {
    const wfName = wfNames.get(r.workflow_id) || r.workflow_id
    if (!confirm(`確定刪除「${wfName} / ${r.step_name}」的 recipe？下次執行會重新叫 LLM 學習。`)) return
    try {
      await deleteRecipe(r.workflow_id, r.step_name)
      toast.success('已刪除')
      load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const handleDeleteWorkflow = async (workflowId: string, workflowName: string) => {
    if (!confirm(`確定清除「${workflowName}」的所有 recipe？下次執行全部重新學習。`)) return
    try {
      const n = await deleteWorkflowRecipes(workflowId)
      toast.success(`已刪除 ${n} 筆 recipe`)
      load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  return (
    <div className="flex-1 overflow-auto bg-gray-50">
      <Toaster position="top-right" richColors />
      <div className="max-w-5xl mx-auto p-8">
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <Link
            href="/pipeline"
            className="p-2 rounded-lg text-gray-500 hover:text-gray-900 hover:bg-white transition-colors"
            title="回到 Pipeline"
          >
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div className="w-10 h-10 rounded-xl bg-brand-100 flex items-center justify-center">
            <BookOpen className="w-5 h-5 text-brand-700" />
          </div>
          <div className="flex-1">
            <h1 className="text-xl font-semibold text-gray-900">Recipe Book</h1>
            <p className="text-sm text-gray-500">成功執行的步驟會被快取，下次輸入 schema 相符就直接重跑，跳過 LLM。</p>
          </div>
          <button
            onClick={load}
            className="p-2 rounded-lg text-gray-500 hover:text-gray-900 hover:bg-white transition-colors"
            title="重新整理"
          >
            <RefreshCw className={cn('w-5 h-5', loading && 'animate-spin')} />
          </button>
        </div>

        {/* Content */}
        {loading ? (
          <div className="bg-white rounded-xl border border-gray-200 p-8 text-center text-gray-400">
            <RefreshCw className="w-5 h-5 animate-spin inline-block mr-2" />
            載入中...
          </div>
        ) : grouped.length === 0 ? (
          <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
            <BookOpen className="w-10 h-10 text-gray-300 mx-auto mb-3" />
            <p className="text-gray-500 text-sm">尚無快取 recipe</p>
            <p className="text-gray-400 text-xs mt-1">跑過一次成功的 Skill 模式步驟就會自動記錄在這裡</p>
          </div>
        ) : (
          <div className="space-y-4">
            {grouped.map(({ workflowId, workflowName, list }) => (
              <div key={workflowId} className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                {/* Workflow header */}
                <div className="px-6 py-3 bg-gray-50/70 border-b border-gray-100 flex items-center justify-between">
                  <div>
                    <div className="text-sm font-semibold text-gray-900">{workflowName}</div>
                    <div className="text-xs text-gray-500">{list.length} 個步驟</div>
                  </div>
                  <button
                    onClick={() => handleDeleteWorkflow(workflowId, workflowName)}
                    className="text-xs px-3 py-1.5 text-red-600 hover:bg-red-50 rounded-lg transition-colors flex items-center gap-1.5"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    全部清除
                  </button>
                </div>
                {/* Step rows */}
                <div className="divide-y divide-gray-100">
                  {list.map((r) => {
                    const key = r.recipe_id
                    const isOpen = expanded === key
                    return (
                      <div key={key} className="">
                        <div className="px-6 py-3 flex items-center gap-3">
                          <button
                            onClick={() => setExpanded(isOpen ? null : key)}
                            className="text-gray-400 hover:text-gray-700"
                          >
                            {isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                          </button>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium text-gray-900 truncate">{r.step_name}</span>
                              {r.disabled && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-100 text-red-700">已停用</span>
                              )}
                              {r.was_interactive && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700" title="首次建立時有使用 ask_user 取得使用者回答，答案已寫入 code">
                                  ⚠️ 首次有人工回答
                                </span>
                              )}
                            </div>
                            <div className="text-xs text-gray-500 flex items-center gap-3 mt-0.5">
                              <span className="flex items-center gap-1">
                                <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                                {r.success_count} 次成功
                              </span>
                              {r.fail_count > 0 && (
                                <span className="flex items-center gap-1">
                                  <XCircle className="w-3 h-3 text-red-600" />
                                  {r.fail_count} 次失敗
                                </span>
                              )}
                              <span>平均 {formatDuration(r.avg_runtime_sec)}</span>
                              <span className="text-gray-400">· 最後成功 {formatTime(r.last_success_at)}</span>
                            </div>
                          </div>
                          <button
                            onClick={() => handleDeleteOne(r)}
                            className="text-gray-400 hover:text-red-600 hover:bg-red-50 p-1.5 rounded-lg transition-colors"
                            title="刪除並重新學習"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                        {isOpen && (
                          <div className="px-6 pb-4 pl-14 space-y-3">
                            {r.output_path && (
                              <div>
                                <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">輸出</div>
                                <div className="font-mono text-xs text-gray-700 bg-gray-50 rounded px-2 py-1 break-all">{r.output_path}</div>
                              </div>
                            )}
                            {Object.keys(r.input_fingerprints).length > 0 && (
                              <div>
                                <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">輸入指紋</div>
                                <div className="space-y-1">
                                  {Object.entries(r.input_fingerprints).map(([path, fp]) => (
                                    <div key={path} className="font-mono text-xs">
                                      <div className="text-gray-700 break-all">{path}</div>
                                      <div className="text-gray-400 ml-2">→ {fp}</div>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                            <div>
                              <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1 flex items-center gap-1.5">
                                <Code2 className="w-3 h-3" />
                                快取程式碼（Python {r.python_version}）
                              </div>
                              <pre className="font-mono text-xs bg-gray-900 text-gray-100 p-3 rounded-lg overflow-x-auto max-h-96 overflow-y-auto">{r.code}</pre>
                            </div>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
