'use client'
import { useState, useRef, useEffect } from 'react'
import {
  Plus, Workflow, X, Bot, ChevronUp, ChevronDown,
  Send, Loader2, Pencil, Check, Trash2, Settings, BookOpen,
  Download, Upload, Square,
} from 'lucide-react'
import Link from 'next/link'
import { toast } from 'sonner'
import ReactMarkdown from 'react-markdown'
import { useWorkflowStore } from './_store'
import {
  pipelineChat, createWorkflowApi, exportWorkflowUrl, importWorkflow,
  getPipelineScheduled, getPipelineRuns, cancelPipelineSchedule,
  getEnvPaths, type EnvPaths,
} from '@/lib/api'
import type { ScheduledTask } from '@/lib/types'

// ── AI Chat Message Type ─────────────────────────────────────────────────────
interface ChatMsg {
  role: 'user' | 'assistant'
  content: string
  hasYaml?: boolean
  yaml?: string | null
  yamlError?: string | null
}

// 根據實際專案路徑組 AI 助手的初始訊息：範例使用真實可執行的腳本路徑，
// 輸出用相對 `ai_output/<name>/` 慣例。使用者可直接把範例描述貼給 AI 產生 YAML。
function buildWelcomeMessage(env: EnvPaths): string {
  const root = env.project_root
  const financeDir = env.finance_example_dir  // 例如 ".../test-workflows/finance"
  const intro = '你好！請告訴我你想自動化的工作流程，我會幫你產生 Pipeline YAML 設定。'
  const pathNote = `📁 **輸出路徑慣例**：所有產出檔會放在 \`ai_output/<工作流名稱>/\` 子資料夾（系統自動解析到 \`${root}\`）。`

  // 範例 1：Python 腳本串接（用專案內建的 finance 範例腳本，若存在）
  let ex1: string
  if (env.has_finance_example && financeDir) {
    ex1 = `**範例 1（Python 腳本串接・使用本專案內建的財務範例）**
第一步：執行 \`python ${financeDir}\\stage1_generate_transactions.py\`，輸出到 \`ai_output/q1_finance/raw_transactions.xlsx\`
第二步：執行 \`python ${financeDir}\\stage2_clean_data.py\`，讀取上一步的 Excel，輸出到 \`ai_output/q1_finance/cleaned_transactions.xlsx\`
第三步：執行 \`python ${financeDir}\\stage3_analyze_finance.py\`，做財務彙總，輸出到 \`ai_output/q1_finance/financial_summary.xlsx\`
第四步：執行 \`python ${financeDir}\\stage4_generate_report.py\`，產出 \`ai_output/q1_finance/Q1_financial_report.xlsx\``
  } else {
    ex1 = `**範例 1（Python 腳本串接）**
第一步：執行 \`python 你的腳本.py\`，輸出到 \`ai_output/daily_report/raw.csv\`
第二步：執行 \`python 分析腳本.py\`，讀取上一步的 csv，輸出到 \`ai_output/daily_report/result.xlsx\``
  }

  // 範例 2：script + AI skill（純自然語言，讓使用者無腦可用）
  let ex2: string
  if (env.has_finance_example && financeDir) {
    ex2 = `**範例 2（Python 腳本 + AI 技能）**
第一步（Python 腳本）：執行 \`python ${financeDir}\\stage1_generate_transactions.py\`，產出 \`ai_output/demo_beautify/raw_transactions.xlsx\`
第二步（AI 技能）：把上一步產生的 Excel 美化一下 — 表頭加粗、換底色、每欄寬度自動配合內容，另存為 \`ai_output/demo_beautify/pretty.xlsx\``
  } else {
    ex2 = `**範例 2（AI 技能）**
把 \`ai_output/some_input/report.xlsx\`（或上一步產生的檔案）美化一下 — 表頭加粗、每欄寬度自動配合內容，儲存到 \`ai_output/excel_beautify/formatted_report.xlsx\``
  }

  // 範例 3：script + AI skill + human_confirm（在範例 2 基礎上加人工審核）
  let ex3: string
  if (env.has_finance_example && financeDir) {
    ex3 = `**範例 3（三種節點組合・Python + AI + 人工確認）**
第一步（Python 腳本）：執行 \`python ${financeDir}\\stage1_generate_transactions.py\` 產出 \`ai_output/demo_review/raw_transactions.xlsx\`
第二步（AI 技能）：讀取上一步的 Excel，按「部門」加總 Amount，產出一份欄位為「Department, TotalAmount, TransactionCount」的摘要 Excel：\`ai_output/demo_review/summary.xlsx\`
第三步（人工確認）：暫停並透過 Telegram 通知我檢查摘要表，確認後才完成`
  } else {
    ex3 = `**範例 3（三種節點組合）**
第一步（Python 腳本）：執行你的腳本，產出 \`ai_output/demo_review/raw.xlsx\`
第二步（AI 技能）：讀取上一步做簡易統計，輸出 \`ai_output/demo_review/summary.xlsx\`
第三步（人工確認）：暫停並透過 Telegram 通知我檢查摘要表`
  }

  return [intro, pathNote, ex1, ex2, ex3].join('\n\n')
}

// ── Countdown Hook ──────────────────────────────────────────────────────────
function useCountdown(nextRun: string | null) {
  const [text, setText] = useState('')
  useEffect(() => {
    if (!nextRun) { setText(''); return }
    const calc = () => {
      // 解析日期並檢查有效性
      const targetDate = new Date(nextRun)
      const now = new Date()
      
      if (isNaN(targetDate.getTime())) { 
        setText('')
        return 
      }
      
      let diff = targetDate.getTime() - now.getTime()
      
      // 如果 diff 為負但絕對值很小（10秒內），視為即將執行
      if (diff <= 0) {
        if (diff > -10000) setText('即將執行…')
        else setText('') 
        return
      }
      
      const h = Math.floor(diff / 3600000)
      const m = Math.floor((diff % 3600000) / 60000)
      const s = Math.floor((diff % 60000) / 1000)
      
      if (h > 24) setText('1天以上')
      else if (h > 0) setText(`${h}時${m}分後執行`)
      else if (m > 0) setText(`${m}分${s}秒後執行`)
      else setText(`${s}秒後執行`)
    }
    calc()
    const iv = setInterval(calc, 1000)
    return () => clearInterval(iv)
  }, [nextRun])
  return text
}

// ── Workflow List Item ───────────────────────────────────────────────────────
function WorkflowItem({
  id, name, active, updatedAt, nextRun, runStatus,
  onSelect, onRename, onDelete, onExport,
}: {
  id: string; name: string; active: boolean; updatedAt: number; nextRun: string | null
  runStatus: 'idle' | 'running' | 'completed' | 'failed' | null
  onSelect: () => void
  onRename: (n: string) => void
  onDelete: () => void
  onExport: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft]     = useState(name)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { if (editing) inputRef.current?.focus() }, [editing])
  useEffect(() => { setDraft(name) }, [name])

  const commit = () => {
    const newName = draft.trim()
    if (!newName || newName === name) { setEditing(false); return }
    const ok = confirm(
      `確定要把「${name}」改成「${newName}」嗎？\n\n` +
      `⚠️ 注意：\n` +
      `• 若步驟有使用「預設輸出路徑」（沒手動指定），下次執行會改寫到 ai_output/${newName}/ 資料夾，舊檔案不會搬過去\n` +
      `• 若後續步驟依賴前一步驟的輸出，可能因路徑改變導致 Recipe 快取失效，需要重新生成\n\n` +
      `建議：改名前最好所有節點都已明確指定「輸出路徑」。`
    )
    if (!ok) { setDraft(name); setEditing(false); return }
    onRename(newName)
    setEditing(false)
  }

  const countdown = useCountdown(nextRun)

  const relTime = (() => {
    const diff = Date.now() - updatedAt
    if (diff < 60000) return '剛才'
    if (diff < 3600000) return `${Math.floor(diff / 60000)} 分鐘前`
    if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小時前`
    return new Date(updatedAt).toLocaleDateString('zh-TW', { month: 'short', day: 'numeric' })
  })()

  return (
    <div
      onClick={() => { if (!editing) onSelect() }}
      className={`group relative flex items-center gap-2 px-3 py-2.5 rounded-xl cursor-pointer transition-colors ${
        active ? 'bg-indigo-50 border border-indigo-200' : 'hover:bg-gray-50 border border-transparent'
      }`}
    >
      <Workflow className={`w-4 h-4 shrink-0 ${active ? 'text-indigo-600' : 'text-gray-400'}`} />
      <div className="flex-1 min-w-0">
        {editing ? (
          <input
            ref={inputRef}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false) }}
            className="w-full text-sm font-medium text-gray-800 bg-transparent outline-none border-b border-indigo-400"
            onClick={e => e.stopPropagation()}
          />
        ) : (
          <p title={name} className={`text-sm font-medium truncate ${active ? 'text-indigo-700' : 'text-gray-700'}`}>{name}</p>
        )}
        {runStatus === 'running' ? (
          <p className="text-xs text-indigo-500 font-medium mt-0.5 flex items-center gap-1">
            <Loader2 className="w-3 h-3 animate-spin" />
            執行中…
          </p>
        ) : runStatus === 'completed' ? (
          <p className="text-xs text-emerald-500 font-medium mt-0.5">已完成</p>
        ) : runStatus === 'failed' ? (
          <p className="text-xs text-red-500 font-medium mt-0.5">執行失敗</p>
        ) : countdown ? (
          <div className="flex items-center gap-2 mt-0.5">
            <p className="text-xs text-amber-500 font-medium flex items-center gap-1">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
              {countdown}
            </p>
            <button
              onClick={async (e) => {
                e.stopPropagation()
                if (confirm(`確定取消「${name}」的排程執行？`)) {
                  try {
                    await cancelPipelineSchedule(name)
                    toast.success('排程已取消')
                    // 這裡依賴 Sidebar 的 fetchSchedules 每 15 秒同步一次
                  } catch (err) {
                    toast.error('取消失敗')
                  }
                }
              }}
              className="p-0.5 rounded hover:bg-amber-100 text-amber-600 transition-colors"
              title="取消排程"
            >
              <Square className="w-2.5 h-2.5 fill-current" />
            </button>
          </div>
        ) : (
          <p className="text-xs text-gray-400 mt-0.5">{relTime}</p>
        )}
      </div>
      {/* Action buttons */}
      <div className="shrink-0 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        {!editing && (
          <>
            <button onClick={e => { e.stopPropagation(); setEditing(true) }}
              className="p-1 rounded hover:bg-gray-200 text-gray-400 hover:text-gray-600" title="重新命名">
              <Pencil className="w-3 h-3" />
            </button>
            <button onClick={e => { e.stopPropagation(); onExport() }}
              className="p-1 rounded hover:bg-blue-50 text-gray-400 hover:text-blue-600" title="匯出">
              <Download className="w-3 h-3" />
            </button>
          </>
        )}
        {editing && (
          <button onClick={e => { e.stopPropagation(); commit() }}
            className="p-1 rounded hover:bg-green-100 text-green-500">
            <Check className="w-3 h-3" />
          </button>
        )}
        <button onClick={e => { e.stopPropagation(); onDelete() }}
          className="p-1 rounded hover:bg-red-50 text-gray-400 hover:text-red-500" title="刪除">
          <Trash2 className="w-3 h-3" />
        </button>
      </div>
    </div>
  )
}

// ── Sidebar ──────────────────────────────────────────────────────────────────
interface SidebarProps {
  onYamlApply: (yaml: string, mode: 'new' | 'overwrite') => void
}

const SIDEBAR_WIDTH_KEY = 'pipeline-sidebar-width'
const SIDEBAR_MIN_WIDTH = 256
const SIDEBAR_MAX_WIDTH = 560
const SIDEBAR_DEFAULT_WIDTH = 256

export default function Sidebar({ onYamlApply }: SidebarProps) {
  const {
    workflows, activeId,
    createWorkflow, updateWorkflow, removeWorkflow, setActive,
  } = useWorkflowStore()

  // ── 拖曳調寬 ─────────────────────────────────────────────────────
  const [width, setWidth] = useState(SIDEBAR_DEFAULT_WIDTH)
  const [resizing, setResizing] = useState(false)
  useEffect(() => {
    const saved = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY))
    if (saved >= SIDEBAR_MIN_WIDTH && saved <= SIDEBAR_MAX_WIDTH) setWidth(saved)
  }, [])
  useEffect(() => {
    if (!resizing) return
    const onMove = (e: MouseEvent) => {
      const w = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, e.clientX))
      setWidth(w)
    }
    const onUp = () => {
      setResizing(false)
      try { localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width)) } catch {}
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [resizing, width])
  // 停止拖曳時寫入最新寬度
  useEffect(() => {
    if (resizing) return
    try { localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width)) } catch {}
  }, [width, resizing])

  const [showChat, setShowChat] = useState(false)
  const [showNameModal, setShowNameModal] = useState(false)
  const [newName, setNewName] = useState('')
  const nameInputRef = useRef<HTMLInputElement>(null)
  const [messages, setMessages] = useState<ChatMsg[]>([
    { role: 'assistant', content: '你好！請告訴我你想自動化的工作流程，我會幫你產生 Pipeline YAML 設定。\n\n（正在載入專案路徑資訊…）' }
  ])

  // 載入專案實際路徑，把初始訊息中的路徑替換成真實可用的版本
  useEffect(() => {
    getEnvPaths().then(env => {
      setMessages(prev => {
        // 只替換初始那一條（仍是預設內容時）；使用者已有對話就不覆蓋
        if (prev.length !== 1 || prev[0].role !== 'assistant') return prev
        return [{ role: 'assistant', content: buildWelcomeMessage(env) }]
      })
    }).catch(() => {/* ignore — 沿用預設訊息 */})
  }, [])
  const [input, setInput]     = useState('')
  const [loading, setLoading] = useState(false)
  const chatEndRef = useRef<HTMLDivElement>(null)

  // 排程倒數：定期查詢排程並建立 name → nextRun 對應
  const [scheduleMap, setScheduleMap] = useState<Record<string, string>>({})
  useEffect(() => {
    const fetchSchedules = async () => {
      try {
        const tasks = await getPipelineScheduled()
        const map: Record<string, string> = {}
        for (const t of tasks) {
          if (t.next_run && t.name) map[t.name] = t.next_run
        }
        setScheduleMap(map)
      } catch { /* ignore */ }
    }
    fetchSchedules()
    const iv = setInterval(fetchSchedules, 15000)
    return () => clearInterval(iv)
  }, [])

  // 各工作流執行狀態：name → 'running' | 'completed' | 'failed'
  const [runStatusMap, setRunStatusMap] = useState<Record<string, 'running' | 'completed' | 'failed'>>({})
  useEffect(() => {
    const fetchRuns = async () => {
      try {
        const runs = await getPipelineRuns()
        const map: Record<string, 'running' | 'completed' | 'failed'> = {}
        const recentThreshold = 3 * 60 * 1000 // 完成/失敗狀態只顯示 3 分鐘
        for (const r of runs) {
          const name = r.pipeline_name
          if (r.status === 'running' || r.status === 'awaiting_human') {
            map[name] = 'running'
          } else if (!map[name] && r.ended_at) {
            const age = Date.now() - new Date(r.ended_at).getTime()
            if (age < recentThreshold) {
              if (r.status === 'completed') map[name] = 'completed'
              else if (r.status === 'failed' || r.status === 'aborted') map[name] = 'failed'
            }
          }
        }
        setRunStatusMap(map)
      } catch { /* ignore */ }
    }
    fetchRuns()
    const iv = setInterval(fetchRuns, 3000)
    return () => clearInterval(iv)
  }, [])

  // 自動滾到底部
  useEffect(() => {
    if (showChat) chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, showChat])

  // 初始化：從 API 載入工作流，並遷移 localStorage 舊資料
  useEffect(() => {
    const init = async () => {
      // 1) 先嘗試遷移 localStorage 的工作流到後端
      const LS_KEY = 'pipeline-workflows-v1'
      try {
        const raw = localStorage.getItem(LS_KEY)
        if (raw) {
          const parsed = JSON.parse(raw)
          const oldWorkflows: Array<{ id: string; name: string; nodes: any[]; edges: any[]; validate: boolean }> = parsed?.state?.workflows ?? []
          if (oldWorkflows.length > 0) {
            let migrated = 0
            for (const wf of oldWorkflows) {
              try {
                await createWorkflowApi(
                  wf.name,
                  { nodes: wf.nodes ?? [], edges: wf.edges ?? [] },
                  wf.validate ?? false,
                )
                migrated++
              } catch { /* 單筆失敗不中斷 */ }
            }
            if (migrated > 0) {
              toast.success(`已從瀏覽器遷移 ${migrated} 個工作流到資料庫`)
              // 只有成功遷移才清除 localStorage
              localStorage.removeItem(LS_KEY)
            }
          }
        }
      } catch { /* localStorage 讀取失敗不中斷 */ }

      // 2) 從 API 載入
      try {
        await useWorkflowStore.getState().fetchWorkflows()
        if (useWorkflowStore.getState().workflows.length === 0) {
          await createWorkflow('我的第一個工作流')
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : '後端連線失敗')
      }
    }
    init()
  }, []) // eslint-disable-line

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`確定刪除「${name}」？此操作會一併刪除相關的 Recipe 和執行紀錄。`)) return
    try {
      await removeWorkflow(id)
      if (useWorkflowStore.getState().workflows.length === 0) {
        await createWorkflow('新工作流')
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '刪除失敗')
    }
  }

  const handleExport = async (id: string) => {
    try {
      const res = await fetch(exportWorkflowUrl(id))
      if (!res.ok) throw new Error('匯出失敗')
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      const disposition = res.headers.get('Content-Disposition')
      const match = disposition?.match(/filename\*=UTF-8''(.+)/)
      a.download = match ? decodeURIComponent(match[1]) : 'workflow.zip'
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch (err: any) {
      toast.error(err.message || '匯出失敗')
    }
  }

  const importRef = useRef<HTMLInputElement>(null)
  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = '' // 允許重複選同一檔案
    try {
      const res = await importWorkflow(file)
      await useWorkflowStore.getState().fetchWorkflows()
      useWorkflowStore.getState().setActive(res.workflow.id)
      let msg = `已匯入「${res.workflow.name}」`
      if (res.recipe_count > 0) msg += `，含 ${res.recipe_count} 個 Recipe`
      toast.success(msg)
      if (res.has_local_scripts) {
        toast.info('此工作流包含本地腳本步驟，請先確認相關腳本檔案已準備好才能執行', { duration: 6000 })
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '匯入失敗')
    }
  }

  const handleSend = async () => {
    const text = input.trim()
    if (!text || loading) return
    const userMsg: ChatMsg = { role: 'user', content: text }
    const newMsgs = [...messages, userMsg]
    setMessages(newMsgs)
    setInput('')
    setLoading(true)
    try {
      const res = await pipelineChat(
        newMsgs.map(m => ({ role: m.role, content: m.content }))
      )
      setMessages(prev => [
        ...prev,
        {
          role: 'assistant',
          content: res.reply,
          hasYaml: res.has_yaml,
          yaml: res.yaml_content,
          yamlError: res.yaml_error ?? null,
        },
      ])
      if (res.yaml_error) {
        toast.error(`產生的 YAML 有語法問題：${res.yaml_error.slice(0, 120)}`)
      }
    } catch (e) {
      toast.error('AI 回應失敗')
    } finally {
      setLoading(false)
    }
  }

  const submitCreate = async () => {
    const name = newName.trim()
    if (!name) { toast.error('名稱不能為空'); return }
    setShowNameModal(false)
    try {
      await createWorkflow(name)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '建立失敗，請稍後再試')
    }
  }

  return (
    <div
      className="shrink-0 h-full flex flex-col bg-white border-r border-gray-200 overflow-hidden relative"
      style={{ width, userSelect: resizing ? 'none' : undefined }}
    >
      {/* ── Resize Handle（右邊界） ── */}
      <div
        onMouseDown={(e) => { e.preventDefault(); setResizing(true) }}
        onDoubleClick={() => setWidth(SIDEBAR_DEFAULT_WIDTH)}
        title="拖曳調整寬度・雙擊還原"
        className={`absolute top-0 right-0 bottom-0 w-1 cursor-col-resize z-30 transition-colors ${
          resizing ? 'bg-indigo-400' : 'hover:bg-indigo-300'
        }`}
      />

      {/* ── 新增工作流：命名對話框 ── */}
      {showNameModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setShowNameModal(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-[420px] p-5" onClick={e => e.stopPropagation()}>
            <h3 className="text-base font-semibold text-gray-800 mb-1">新增工作流</h3>
            <p className="text-xs text-gray-500 mb-4">為工作流命名（也可之後重新命名）</p>
            <input
              ref={nameInputRef}
              value={newName}
              onChange={e => setNewName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') submitCreate(); if (e.key === 'Escape') setShowNameModal(false) }}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-400/20"
              placeholder="工作流名稱"
            />
            <div className="mt-3 p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs leading-relaxed">
              <div className="font-medium text-amber-800 mb-1">⚠️ 關於名稱的提醒</div>
              <ul className="text-amber-700 space-y-0.5 ml-4 list-disc">
                <li>名稱會成為「預設輸出資料夾」的路徑（<code className="font-mono">ai_output/名稱/</code>）</li>
                <li>未來改名會造成預設路徑變更，可能導致 Recipe 快取失效、舊檔案留在舊路徑</li>
                <li>建議：取一個穩定的名字，每個節點都**明確指定輸出路徑**以避免後續問題</li>
              </ul>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setShowNameModal(false)}
                className="px-4 py-1.5 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50">取消</button>
              <button onClick={submitCreate}
                className="px-4 py-1.5 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700">建立</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Logo ── */}
      <div className="flex items-center gap-2.5 px-4 py-4 border-b border-gray-100">
        <div className="w-7 h-7 bg-indigo-600 rounded-lg flex items-center justify-center shrink-0">
          <Workflow className="w-4 h-4 text-white" />
        </div>
        <span className="font-bold text-gray-800 text-sm flex-1">Pipeline</span>
        <Link
          href="/recipes"
          className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors"
          title="Recipe Book"
        >
          <BookOpen className="w-4 h-4" />
        </Link>
        <Link
          href="/settings"
          className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors"
          title="設定"
        >
          <Settings className="w-4 h-4" />
        </Link>
      </div>

      {/* ── New / Import Workflow Buttons ── */}
      <div className="px-3 pt-3 pb-2 flex gap-1.5">
        <button
          onClick={() => {
            const existingNames = new Set(workflows.map(w => w.name))
            let suggested = '新工作流'
            let i = 1
            while (existingNames.has(suggested)) { suggested = `新工作流(${i})`; i++ }
            setNewName(suggested)
            setShowNameModal(true)
            setTimeout(() => nameInputRef.current?.select(), 50)
          }}
          className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 bg-indigo-600 text-white rounded-xl text-xs font-medium hover:bg-indigo-700 transition-colors shadow-sm"
        >
          <Plus className="w-3.5 h-3.5" />
          新增
        </button>
        <button
          onClick={() => importRef.current?.click()}
          className="flex items-center justify-center gap-1.5 px-3 py-2 border border-gray-200 text-gray-600 rounded-xl text-xs font-medium hover:bg-gray-50 transition-colors"
          title="匯入工作流 (.zip)"
        >
          <Upload className="w-3.5 h-3.5" />
          匯入
        </button>
        <input ref={importRef} type="file" accept=".zip" className="hidden" onChange={handleImport} />
      </div>

      {/* ── Workflow List ── */}
      <div className="flex-1 overflow-y-auto px-2 py-1 space-y-0.5 min-h-0">
        {workflows.length === 0 && (
          <p className="text-xs text-gray-400 text-center py-6">尚無工作流</p>
        )}
        {workflows.map(wf => (
          <WorkflowItem
            key={wf.id}
            id={wf.id}
            name={wf.name}
            active={wf.id === activeId}
            updatedAt={wf.updatedAt}
            nextRun={scheduleMap[wf.name] ?? null}
            runStatus={runStatusMap[wf.name] ?? null}
            onSelect={() => setActive(wf.id)}
            onRename={name => updateWorkflow(wf.id, { name })}
            onDelete={() => handleDelete(wf.id, wf.name)}
            onExport={() => handleExport(wf.id)}
          />
        ))}
      </div>

      {/* ── AI Assistant Section ──
          展開時以 absolute 覆蓋在 sidebar 下緣，佔 75% 高度（約蓋住工作流列表），收合時回到底部單列按鈕
      */}
      <div
        className={
          showChat
            ? 'absolute inset-x-0 bottom-0 top-1/4 bg-white border-t border-gray-100 flex flex-col z-20 shadow-lg'
            : 'border-t border-gray-100 flex flex-col'
        }
      >
        {/* Toggle button */}
        <button
          onClick={() => setShowChat(!showChat)}
          className={`flex items-center gap-2 px-4 py-3 text-sm transition-colors ${
            showChat ? 'text-indigo-600 bg-indigo-50' : 'text-gray-600 hover:text-indigo-600 hover:bg-gray-50'
          }`}
        >
          <Bot className="w-4 h-4 shrink-0" />
          <span className="font-medium flex-1 text-left">AI 助手</span>
          {loading && <Loader2 className="w-3.5 h-3.5 animate-spin text-indigo-500" />}
          {!loading && (showChat ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />)}
        </button>

        {/* Chat panel */}
        {showChat && (
          <div className="flex flex-col flex-1 min-h-0 border-t border-gray-100">
            {/* Messages */}
            <div className="flex-1 overflow-y-auto p-2.5 space-y-2.5">
              {messages.map((msg, i) => (
                <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  {msg.role === 'assistant' && (
                    <div className="w-5 h-5 rounded-full bg-indigo-100 flex items-center justify-center shrink-0 mt-0.5 mr-1.5">
                      <Bot className="w-3 h-3 text-indigo-600" />
                    </div>
                  )}
                  <div className={`max-w-[88%] min-w-0 rounded-xl px-2.5 py-1.5 text-xs leading-relaxed break-words overflow-hidden ${
                    msg.role === 'user'
                      ? 'bg-indigo-600 text-white rounded-br-sm'
                      : 'bg-gray-100 text-gray-700 rounded-bl-sm'
                  }`} style={{ overflowWrap: 'anywhere', wordBreak: 'break-word' }}>
                    {msg.role === 'assistant' ? (
                      <div className="prose prose-xs max-w-none prose-p:my-0.5 prose-pre:text-xs prose-pre:whitespace-pre-wrap prose-code:break-all">
                        <ReactMarkdown>{msg.content.replace(/YAML_READY\n```yaml[\s\S]*?```/g, '（已偵測到 YAML ↓）')}</ReactMarkdown>
                      </div>
                    ) : (
                      <span className="whitespace-pre-wrap">{msg.content}</span>
                    )}
                    {msg.hasYaml && msg.yamlError && (
                      <div className="mt-1.5 p-2 rounded-lg bg-red-50 border border-red-200 text-[11px] text-red-700 leading-relaxed">
                        ⚠️ YAML 有問題，建議請 AI 修正後再套用：<br/>
                        <code className="break-all">{msg.yamlError}</code>
                      </div>
                    )}
                    {msg.hasYaml && msg.yaml && (
                      <div className="mt-1.5 grid grid-cols-2 gap-1">
                        <button
                          onClick={() => onYamlApply(msg.yaml!, 'new')}
                          title="建立一個新的工作流來放這份 YAML，不碰目前的"
                          className={`flex items-center justify-center gap-1 py-1 rounded-lg text-xs font-medium transition-colors ${
                            msg.yamlError
                              ? 'bg-amber-500 hover:bg-amber-400 text-white'
                              : 'bg-emerald-500 hover:bg-emerald-400 text-white'
                          }`}
                        >
                          ＋ 建立新工作流
                        </button>
                        <button
                          onClick={() => {
                            if (!confirm('這會覆蓋目前工作流的內容（無法還原）。確定要繼續嗎？')) return
                            onYamlApply(msg.yaml!, 'overwrite')
                          }}
                          title="用這份 YAML 覆蓋目前工作流（會彈確認）"
                          className="flex items-center justify-center gap-1 py-1 rounded-lg text-xs font-medium border border-gray-300 bg-white hover:bg-gray-50 text-gray-600 transition-colors"
                        >
                          ⚠ 覆蓋目前
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
              {loading && (
                <div className="flex items-center gap-2 text-xs text-gray-400 pl-7">
                  <Loader2 className="w-3 h-3 animate-spin" /> 思考中…
                </div>
              )}
              <div ref={chatEndRef} />
            </div>

            {/* Input */}
            <div className="p-2 border-t border-gray-100 flex gap-1.5 items-end">
              <textarea
                value={input}
                onChange={e => setInput(e.target.value)}
                placeholder="描述你的工作流…（Enter 換行）"
                disabled={loading}
                rows={2}
                className="flex-1 border border-gray-200 rounded-xl px-2.5 py-1.5 text-xs outline-none focus:border-indigo-400 transition-colors disabled:bg-gray-50 resize-none"
              />
              <button
                onClick={handleSend}
                disabled={!input.trim() || loading}
                className="w-7 h-7 flex items-center justify-center bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 disabled:opacity-40 transition-colors shrink-0"
              >
                <Send className="w-3 h-3" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
