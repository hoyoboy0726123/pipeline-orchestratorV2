'use client'
import { useState, useEffect } from 'react'
import { X, FolderOpen, ChevronDown, ChevronUp, Sparkles } from 'lucide-react'
import type { SkillData, SkillNode } from './_helpers'
import { fsBrowse, listAvailableSkills, type AvailableSkill } from '@/lib/api'
import { toast } from 'sonner'
import { useRunStatusStore } from './_runStatus'

// ── File Browser Modal ────────────────────────────────────────────────────────
interface BrowseItem { name: string; is_dir: boolean; path: string }

function FileBrowser({ onSelect, onClose }: { onSelect: (p: string) => void; onClose: () => void }) {
  const [currentPath, setCurrentPath] = useState('~')
  const [items, setItems] = useState<BrowseItem[]>([])
  const [loading, setLoading] = useState(false)
  const [manualPath, setManualPath] = useState('')

  const browse = async (p: string) => {
    setLoading(true)
    try {
      const data = await fsBrowse(p)
      setItems(data.items ?? [])
      setCurrentPath(data.path ?? p)
    } catch { toast.error('瀏覽失敗') }
    finally { setLoading(false) }
  }

  useEffect(() => { browse('~') }, [])

  const crumbs = currentPath.replace(/^\/Users\/[^/]+/, '~').split('/').filter(Boolean)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-2xl shadow-2xl w-[480px] max-h-[70vh] flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <span className="font-semibold text-sm text-gray-700">選擇檔案</span>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X className="w-4 h-4" /></button>
        </div>
        <div className="flex items-center gap-1 px-4 py-2 text-xs text-gray-500 flex-wrap border-b bg-gray-50">
          {crumbs.map((c, i) => (
            <span key={i} className="flex items-center gap-1">
              {i > 0 && <span className="text-gray-300">/</span>}
              <button onClick={() => browse('/' + crumbs.slice(0, i + 1).join('/').replace(/^~/, '~'))}
                className="hover:text-purple-600 transition-colors">{c}</button>
            </span>
          ))}
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
          {loading && <p className="text-center text-gray-400 py-4 text-sm">載入中…</p>}
          {!loading && items.length === 0 && <p className="text-center text-gray-400 py-4 text-sm">（空目錄）</p>}
          {!loading && items.map(item => (
            <button key={item.path} onClick={() => item.is_dir ? browse(item.path) : onSelect(item.path)}
              className="w-full flex items-center gap-2 px-3 py-1.5 rounded-lg hover:bg-purple-50 text-left transition-colors">
              <span className="text-base">{item.is_dir ? '📁' : '📄'}</span>
              <span className="text-sm text-gray-700 truncate flex-1">{item.name}</span>
              {item.is_dir && <span className="text-xs text-gray-400 shrink-0">›</span>}
            </button>
          ))}
        </div>
        <div className="border-t p-3 space-y-2">
          <div className="flex gap-2">
            <input value={manualPath} onChange={e => setManualPath(e.target.value)} placeholder="手動輸入路徑…"
              className="flex-1 border border-gray-200 rounded-lg px-2.5 py-1.5 text-sm outline-none focus:border-purple-400 font-mono" />
            <button onClick={() => manualPath && onSelect(manualPath)}
              className="px-3 py-1.5 bg-purple-600 text-white rounded-lg text-sm hover:bg-purple-700 transition-colors">確認</button>
          </div>
          <button onClick={() => onSelect(currentPath)}
            className="w-full py-1.5 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50 transition-colors"
          >使用目前目錄：{currentPath}</button>
        </div>
      </div>
    </div>
  )
}

// ── SkillConfigPanel ─────────────────────────────────────────────────────────
const SKILL_COLOR = '#8b5cf6'

interface Props {
  node: SkillNode
  onUpdate: (data: Partial<SkillData>) => void
  onClose: () => void
  onDelete: () => void
}

export default function SkillConfigPanel({ node, onUpdate, onClose, onDelete }: Props) {
  const data = node.data
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [browserTarget, setBrowserTarget] = useState<'output' | 'workingDir' | null>(null)
  const hasRecipe = useRunStatusStore(s => s.recipeSteps[data.name])
  const [skills, setSkills] = useState<AvailableSkill[]>([])
  const [skillsLoading, setSkillsLoading] = useState(false)
  const [skillsError, setSkillsError] = useState('')

  useEffect(() => {
    setSkillsLoading(true)
    listAvailableSkills()
      .then(r => {
        setSkills(r.skills || [])
        if (!r.exists) {
          setSkillsError(`找不到 skill 目錄：${r.skills_root}（使用 npx skills add 安裝）`)
        } else if ((r.skills || []).length === 0) {
          setSkillsError('目錄存在但沒有任何 skill')
        }
      })
      .catch(e => setSkillsError(e?.message || '載入失敗'))
      .finally(() => setSkillsLoading(false))
  }, [])

  const selectedSkill = skills.find(s => s.display_name === data.skill || s.name === data.skill)

  const inputCls = 'w-full border border-gray-200 rounded-lg px-2.5 py-1.5 text-sm outline-none focus:border-purple-400 focus:ring-1 focus:ring-purple-400/20 bg-white'

  return (
    <>
      {browserTarget && (
        <FileBrowser
          onSelect={path => {
            if (browserTarget === 'output') {
              onUpdate({ outputPath: path })
            } else {
              onUpdate({ workingDir: path })
            }
            setBrowserTarget(null)
          }}
          onClose={() => setBrowserTarget(null)}
        />
      )}

      <div className="absolute top-0 right-0 h-full w-[380px] bg-white shadow-2xl border-l border-gray-100 flex flex-col z-30 overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-3.5 border-b" style={{ borderTopColor: SKILL_COLOR, borderTopWidth: 3 }}>
          <span className="w-8 h-8 rounded-full flex items-center justify-center text-white text-sm font-bold shrink-0"
            style={{ background: SKILL_COLOR }}>✨</span>
          <div className="flex-1 min-w-0">
            <span className="font-semibold text-gray-800 text-sm block truncate">AI技能節點</span>
            <span className="text-xs text-gray-400">AI 根據描述自動撰寫並執行程式碼，成功後儲存為 Recipe</span>
          </div>
          <button onClick={onDelete} title="刪除" className="text-gray-300 hover:text-red-400 transition-colors p-1">🗑</button>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 transition-colors"><X className="w-4 h-4" /></button>
        </div>

        {/* Fields */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Name */}
          <div>
            <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide block mb-1.5">步驟名稱</label>
            <input value={data.name} onChange={e => onUpdate({ name: e.target.value })} className={`${inputCls} font-mono`} placeholder="描述這個步驟的功能" />
          </div>

          {/* Task Description */}
          <div>
            <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide block mb-2">任務描述</label>
            <textarea
              rows={5}
              value={data.taskDescription}
              onChange={e => onUpdate({ taskDescription: e.target.value })}
              placeholder={'用自然語言描述 AI 應該做什麼…\n例如：到 Yahoo Finance 抓取台積電（2330.TW）最近 30 天的收盤價，存成 CSV 檔案，欄位包含日期和收盤價'}
              className={`${inputCls} resize-none font-mono text-xs leading-relaxed`}
            />
            <p className="text-xs text-gray-400 mt-1.5">AI 會根據描述自動撰寫 Python 程式碼並執行</p>
          </div>

          {/* Claude Code Skill mount */}
          <div>
            <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide block mb-1.5 flex items-center gap-1">
              <Sparkles className="w-3 h-3" />
              掛載 Skill <span className="text-gray-300 font-normal normal-case">（選填）</span>
            </label>
            <select
              value={data.skill || ''}
              onChange={e => onUpdate({ skill: e.target.value })}
              disabled={skillsLoading}
              className={`${inputCls} font-mono disabled:opacity-50`}
            >
              <option value="">（不掛載）</option>
              {skills.map(s => (
                <option key={s.display_name} value={s.display_name}>
                  {s.display_name}
                </option>
              ))}
            </select>
            {skillsLoading && <p className="text-xs text-gray-400 mt-1">載入中…</p>}
            {!skillsLoading && skillsError && <p className="text-xs text-amber-500 mt-1">{skillsError}</p>}
            {selectedSkill && (
              <div className="mt-2 p-2.5 rounded-lg bg-purple-50 border border-purple-100 text-xs">
                <div className="font-medium text-purple-700 mb-1">{selectedSkill.name}</div>
                {selectedSkill.description && (
                  <div className="h-20 overflow-y-auto pr-1 mb-1.5 text-gray-600 leading-relaxed">
                    {selectedSkill.description}
                  </div>
                )}
                <div className="flex gap-2 text-[11px] text-gray-400">
                  {selectedSkill.has_scripts && <span>📜 scripts</span>}
                  {selectedSkill.has_references && <span>📖 references</span>}
                  {selectedSkill.has_assets && <span>🎨 assets</span>}
                </div>
              </div>
            )}
            {data.skill && (
              <div className="mt-2 p-2.5 rounded-lg bg-amber-50 border border-amber-200 text-xs leading-relaxed">
                <div className="font-medium text-amber-800 mb-1">⚠️ 模型能力提醒</div>
                <p className="text-amber-700">
                  Skill 功能需要模型有足夠推理能力才能正確理解 SKILL.md 與使用子資源腳本。建議：
                </p>
                <ul className="text-amber-700 mt-1 ml-3 list-disc space-y-0.5">
                  <li><b>Groq / Gemini / OpenRouter</b>：使用各家旗艦或大型模型（非輕量版）</li>
                  <li><b>Ollama</b>：避免使用 8B 以下小模型（能力不足會忽略 skill 指示）</li>
                </ul>
                <p className="text-amber-700 mt-1">若結果不如預期，切換更強的模型並以「完整模式」重跑覆蓋 recipe。</p>
              </div>
            )}
          </div>

          {/* Output path */}
          <div>
            <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide block mb-1.5">輸出路徑</label>
            <div className="flex gap-1.5">
              <input value={data.outputPath} onChange={e => onUpdate({ outputPath: e.target.value })}
                placeholder="~/ai_output/..." className={`${inputCls} font-mono flex-1`} />
              <button onClick={() => setBrowserTarget('output')}
                className="shrink-0 w-8 h-8 flex items-center justify-center border border-gray-200 rounded-lg hover:bg-purple-50 text-gray-400 hover:text-purple-600 transition-colors">
                <FolderOpen className="w-3.5 h-3.5" /></button>
            </div>
            <p className="text-xs text-gray-400 mt-1">AI 會將結果寫入此路徑</p>
          </div>

          {/* Readonly toggle */}
          <div className="flex items-center justify-between p-3 rounded-xl border border-gray-200 bg-gray-50/50">
            <div className="flex-1 min-w-0 mr-3">
              <div className="text-sm font-medium text-gray-700">🔒 唯讀驗證模式</div>
              <p className="text-xs text-gray-400 mt-0.5">
                {data.readonly
                  ? '已啟用：AI 只做深度驗證，禁止修改任何檔案來完成任務'
                  : '關閉中：AI 可自由讀寫檔案來完成任務'}
              </p>
            </div>
            <button
              onClick={() => onUpdate({ readonly: !data.readonly })}
              className={`relative w-11 h-6 rounded-full transition-colors shrink-0 ${
                data.readonly ? 'bg-amber-500' : 'bg-gray-300'
              }`}
            >
              <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${
                data.readonly ? 'translate-x-5' : 'translate-x-0'
              }`} />
            </button>
          </div>

          {/* Expected Output */}
          <div>
            <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide block mb-1.5">預期輸出描述</label>
            <textarea
              rows={3}
              value={data.expectedOutput}
              onChange={e => onUpdate({ expectedOutput: e.target.value })}
              placeholder="描述輸出應包含什麼內容…&#10;例如：CSV 檔案包含至少 20 筆資料，有 date 和 close 欄位"
              className={`${inputCls} resize-none text-xs leading-relaxed`}
            />
            <p className="text-xs text-gray-400 mt-1">AI 完成後會用此描述深度驗證輸出是否正確</p>
          </div>

          {/* Recipe status */}
          {hasRecipe && (
            <div className="p-3 rounded-xl bg-amber-50 border border-amber-200">
              <div className="flex items-center gap-2">
                <span className="text-amber-500">⚡</span>
                <span className="text-sm font-medium text-amber-700">已有 Recipe 快取</span>
              </div>
              <p className="text-xs text-amber-600 mt-1">下次可選擇「快速模式」直接使用已驗證的程式碼執行</p>
            </div>
          )}

          {/* Advanced */}
          <div>
            <button onClick={() => setShowAdvanced(!showAdvanced)}
              className="flex items-center gap-1.5 text-xs font-semibold text-gray-500 uppercase tracking-wide hover:text-purple-600 transition-colors">
              {showAdvanced ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
              進階設定
            </button>
            {showAdvanced && (
              <div className="mt-3 space-y-3 pl-4 border-l-2 border-purple-100">
                <div className="flex gap-3">
                  <div className="flex-1">
                    <label className="text-xs text-gray-500 block mb-1">逾時（秒）</label>
                    <input type="number" min={10} max={3600} value={data.timeout}
                      onChange={e => onUpdate({ timeout: parseInt(e.target.value) || 300 })} className={inputCls} />
                  </div>
                  <div className="flex-1">
                    <label className="text-xs text-gray-500 block mb-1">自動重試次數</label>
                    <input type="number" min={0} max={5} value={data.retry}
                      onChange={e => onUpdate({ retry: parseInt(e.target.value) || 0 })} className={inputCls} />
                  </div>
                </div>
                <div>
                  <label className="text-xs text-gray-500 block mb-1">工作目錄</label>
                  <div className="flex gap-1.5">
                    <input value={data.workingDir} onChange={e => onUpdate({ workingDir: e.target.value })}
                      placeholder="（留空 = 使用預設目錄）" className={`${inputCls} font-mono flex-1`} />
                    <button onClick={() => setBrowserTarget('workingDir')}
                      className="shrink-0 w-8 h-8 flex items-center justify-center border border-gray-200 rounded-lg hover:bg-purple-50 text-gray-400 hover:text-purple-600 transition-colors">
                      <FolderOpen className="w-3.5 h-3.5" /></button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 border-t bg-purple-50">
          <div className="flex items-center justify-between text-xs text-gray-400">
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full" style={{ background: SKILL_COLOR }} />
              AI技能節點
            </span>
            <span className={`px-2 py-0.5 rounded-full font-medium ${
              data.status === 'success' ? 'bg-green-100 text-green-700' :
              data.status === 'failed'  ? 'bg-red-100 text-red-700' :
              data.status === 'running' ? 'bg-blue-100 text-blue-700' :
              'bg-gray-100 text-gray-500'
            }`}>
              {data.status === 'idle' ? '等待中' : data.status === 'running' ? '執行中' : data.status === 'success' ? '成功' : '失敗'}
            </span>
          </div>
        </div>
      </div>
    </>
  )
}
