'use client'
import { useState, useEffect } from 'react'
import { X, FolderOpen, ChevronDown, ChevronUp } from 'lucide-react'
import type { StepData, ScriptNode } from './_helpers'
import { fsBrowse, fsCheckVenv } from '@/lib/api'
import { toast } from 'sonner'

// ── 執行前綴 ─────────────────────────────────────────────────────────────────
const EXEC_PREFIXES = [
  { label: 'python',                           value: 'python',                platform: 'cross' },
  { label: 'python3',                          value: 'python3',               platform: 'cross' },
  { label: 'node',                             value: 'node',                  platform: 'cross' },
  { label: 'npx',                              value: 'npx',                   platform: 'cross' },
  { label: '直接執行（不加前綴）',               value: '',                      platform: 'cross' },
  { label: '.venv/bin/python (venv)',          value: '.venv/bin/python',       platform: 'unix' },
  { label: 'bash',                             value: 'bash',                  platform: 'unix' },
  { label: 'sh',                               value: 'sh',                   platform: 'unix' },
  { label: 'py (Windows Launcher)',            value: 'py',                    platform: 'win' },
  { label: 'py -3 (Windows Py3)',              value: 'py -3',                 platform: 'win' },
  { label: '.venv\\Scripts\\python (Win venv)', value: '.venv\\Scripts\\python', platform: 'win' },
  { label: 'cmd /c',                           value: 'cmd /c',               platform: 'win' },
  { label: 'powershell -File',                 value: 'powershell -File',      platform: 'win' },
]

function splitBatch(batch: string): { prefix: string; filePath: string } {
  const sorted = [...EXEC_PREFIXES].sort((a, b) => b.value.length - a.value.length)
  for (const p of sorted) {
    if (p.value && batch.startsWith(p.value + ' '))
      return { prefix: p.value, filePath: batch.slice(p.value.length + 1).trim() }
  }
  return { prefix: '', filePath: batch }
}

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
              <button onClick={() => browse('/' + crumbs.slice(0, i + 1).join('/').replace(/^~/, `~`))}
                className="hover:text-indigo-600 transition-colors">{c}</button>
            </span>
          ))}
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
          {loading && <p className="text-center text-gray-400 py-4 text-sm">載入中…</p>}
          {!loading && items.length === 0 && <p className="text-center text-gray-400 py-4 text-sm">（空目錄）</p>}
          {!loading && items.map(item => (
            <button key={item.path} onClick={() => item.is_dir ? browse(item.path) : onSelect(item.path)}
              className="w-full flex items-center gap-2 px-3 py-1.5 rounded-lg hover:bg-indigo-50 text-left transition-colors">
              <span className="text-base">{item.is_dir ? '📁' : '📄'}</span>
              <span className="text-sm text-gray-700 truncate flex-1">{item.name}</span>
              {item.is_dir && <span className="text-xs text-gray-400 shrink-0">›</span>}
            </button>
          ))}
        </div>
        <div className="border-t p-3 space-y-2">
          <div className="flex gap-2">
            <input value={manualPath} onChange={e => setManualPath(e.target.value)} placeholder="手動輸入路徑…"
              className="flex-1 border border-gray-200 rounded-lg px-2.5 py-1.5 text-sm outline-none focus:border-indigo-400 font-mono" />
            <button onClick={() => manualPath && onSelect(manualPath)}
              className="px-3 py-1.5 bg-indigo-600 text-white rounded-lg text-sm hover:bg-indigo-700 transition-colors">確認</button>
          </div>
          <button onClick={() => onSelect(currentPath)}
            className="w-full py-1.5 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50 transition-colors"
          >使用目前目錄：{currentPath}</button>
        </div>
      </div>
    </div>
  )
}

// ── ScriptConfigPanel ─────────────────────────────────────────────────────────
interface Props {
  node: ScriptNode
  onUpdate: (data: Partial<StepData>) => void
  onClose: () => void
  onDelete: () => void
  aiExpectText?: string
}

export default function ScriptConfigPanel({ node, onUpdate, onClose, onDelete, aiExpectText }: Props) {
  const data = node.data
  const color = '#3b82f6'
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [browserTarget, setBrowserTarget] = useState<'batch' | 'output' | null>(null)
  const [venvChecking, setVenvChecking] = useState(false)

  const { prefix: initPrefix } = splitBatch(data.batch)
  const [selectedPrefix, setSelectedPrefix] = useState(initPrefix || 'python')

  useEffect(() => {
    const { prefix } = splitBatch(data.batch)
    setSelectedPrefix(prefix || 'python')
  }, [node.id])

  const upd = (patch: Partial<StepData>) => onUpdate(patch)
  const { filePath } = splitBatch(data.batch)
  const isUsingVenv = data.batch.includes('.venv') && data.batch.includes('python')
  const pyPathMatch = data.batch.match(/(?:python\S*|\.venv[/\\]\S*python\S*)\s+(\S+\.py)/)
  const pyPath = pyPathMatch?.[1] ?? null

  const handleVenvToggle = async (checked: boolean) => {
    if (!pyPath) return
    const sep = pyPath.includes('\\') ? '\\' : '/'
    const scriptDir = pyPath.substring(0, pyPath.lastIndexOf(sep))
    if (!checked) {
      const fallback = selectedPrefix.includes('venv') ? 'python' : selectedPrefix || 'python'
      upd({ batch: `${fallback} ${pyPath}` }); setSelectedPrefix(fallback); return
    }
    setVenvChecking(true)
    try {
      const res = await fsCheckVenv(scriptDir)
      if (res.has_venv && res.python_path) {
        upd({ batch: `${res.python_path} ${pyPath}` })
        const isWin = res.python_path.includes('Scripts')
        setSelectedPrefix(isWin ? '.venv\\Scripts\\python' : '.venv/bin/python')
        toast.success('已切換為虛擬環境 Python')
      } else {
        toast.error(`找不到 .venv，請先在專案目錄建立虛擬環境`, { duration: 8000 })
      }
    } catch { toast.error('檢查虛擬環境失敗') }
    finally { setVenvChecking(false) }
  }

  const inputCls = 'w-full border border-gray-200 rounded-lg px-2.5 py-1.5 text-sm outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-400/20 bg-white font-mono'

  return (
    <>
      {browserTarget && (
        <FileBrowser
          onSelect={path => {
            if (browserTarget === 'batch') {
              let prefix = selectedPrefix
              if (path.endsWith('.sh'))                    { prefix = 'bash';    setSelectedPrefix('bash') }
              else if (path.endsWith('.bat') || path.endsWith('.cmd')) { prefix = 'cmd /c'; setSelectedPrefix('cmd /c') }
              else if (path.endsWith('.ps1'))              { prefix = 'powershell -File'; setSelectedPrefix('powershell -File') }
              else if (path.endsWith('.js') || path.endsWith('.mjs')) { prefix = 'node'; setSelectedPrefix('node') }
              else if (path.endsWith('.py') && !prefix)   { prefix = 'python'; setSelectedPrefix('python') }
              upd({ batch: prefix ? `${prefix} ${path}` : path })
            } else {
              upd({ outputPath: path })
            }
            setBrowserTarget(null)
          }}
          onClose={() => setBrowserTarget(null)}
        />
      )}

      <div className="absolute top-0 right-0 h-full w-[380px] bg-white shadow-2xl border-l border-gray-100 flex flex-col z-30 overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-3.5 border-b" style={{ borderTopColor: color, borderTopWidth: 3 }}>
          <span className="w-8 h-8 rounded-full flex items-center justify-center text-white text-sm font-bold shrink-0"
            style={{ background: color }}>▶</span>
          <div className="flex-1 min-w-0">
            <span className="font-semibold text-gray-800 text-sm block truncate">Python腳本節點</span>
            <span className="text-xs text-gray-400">執行你寫好的腳本或 Shell 指令</span>
          </div>
          <button onClick={onDelete} title="刪除" className="text-gray-300 hover:text-red-400 transition-colors p-1">🗑</button>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 transition-colors"><X className="w-4 h-4" /></button>
        </div>

        {/* Fields */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Name */}
          <div>
            <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide block mb-1.5">步驟名稱</label>
            <input value={data.name} onChange={e => upd({ name: e.target.value })} className={inputCls} placeholder="描述這個步驟的功能" />
          </div>

          {/* Command */}
          <div>
            <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide block mb-2">執行指令</label>
            <select value={selectedPrefix}
              onChange={e => { const p = e.target.value; setSelectedPrefix(p); if (filePath) upd({ batch: p ? `${p} ${filePath}` : filePath }) }}
              className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-xs bg-white text-gray-700 outline-none focus:border-indigo-400 cursor-pointer mb-1.5">
              <optgroup label="跨平台">
                {EXEC_PREFIXES.filter(p => p.platform === 'cross').map((p, i) => <option key={`c-${i}`} value={p.value}>{p.label}</option>)}
              </optgroup>
              <optgroup label="macOS / Linux">
                {EXEC_PREFIXES.filter(p => p.platform === 'unix').map((p, i) => <option key={`u-${i}`} value={p.value}>{p.label}</option>)}
              </optgroup>
              <optgroup label="Windows">
                {EXEC_PREFIXES.filter(p => p.platform === 'win').map((p, i) => <option key={`w-${i}`} value={p.value}>{p.label}</option>)}
              </optgroup>
            </select>
            <div className="flex gap-1.5 mb-1.5">
              <input value={splitBatch(data.batch).filePath}
                onChange={e => { const fp = e.target.value; upd({ batch: selectedPrefix ? `${selectedPrefix} ${fp}` : fp }) }}
                placeholder="選擇或輸入腳本路徑" className={`${inputCls} flex-1`} />
              <button onClick={() => setBrowserTarget('batch')}
                className="shrink-0 w-8 h-8 flex items-center justify-center border border-gray-200 rounded-lg hover:bg-indigo-50 text-gray-400 hover:text-indigo-600 transition-colors">
                <FolderOpen className="w-3.5 h-3.5" /></button>
            </div>
            {data.batch && (
              <div className="text-xs text-gray-400 font-mono bg-gray-50 rounded-lg px-2.5 py-1.5 break-all">▶ {data.batch}</div>
            )}
            {pyPath && (
              <label className="flex items-center gap-2 mt-2 cursor-pointer select-none">
                <input type="checkbox" checked={isUsingVenv} onChange={e => handleVenvToggle(e.target.checked)}
                  disabled={venvChecking} className="w-3.5 h-3.5 rounded accent-indigo-500" />
                <span className="text-xs text-gray-500">{venvChecking ? '偵測中…' : '使用 .venv 虛擬環境'}</span>
              </label>
            )}
          </div>

          {/* Output path */}
          <div>
            <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide block mb-1.5">輸出路徑</label>
            <div className="flex gap-1.5">
              <input value={data.outputPath} onChange={e => upd({ outputPath: e.target.value })}
                placeholder="~/ai_output/..." className={`${inputCls} flex-1`} />
              <button onClick={() => setBrowserTarget('output')}
                className="shrink-0 w-8 h-8 flex items-center justify-center border border-gray-200 rounded-lg hover:bg-indigo-50 text-gray-400 hover:text-indigo-600 transition-colors">
                <FolderOpen className="w-3.5 h-3.5" /></button>
            </div>
            <p className="text-xs text-gray-400 mt-1">Pipeline 用此路徑確認步驟是否成功執行</p>
          </div>

          {/* Advanced */}
          <div>
            <button onClick={() => setShowAdvanced(!showAdvanced)}
              className="flex items-center gap-1.5 text-xs font-semibold text-gray-500 uppercase tracking-wide hover:text-indigo-600 transition-colors">
              {showAdvanced ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
              進階設定
            </button>
            {showAdvanced && (
              <div className="mt-3 space-y-3 pl-4 border-l-2 border-gray-100">
                <div className="flex gap-3">
                  <div className="flex-1">
                    <label className="text-xs text-gray-500 block mb-1">逾時（秒）</label>
                    <input type="number" min={10} max={3600} value={data.timeout}
                      onChange={e => upd({ timeout: parseInt(e.target.value) || 300 })} className={inputCls} />
                  </div>
                  <div className="flex-1">
                    <label className="text-xs text-gray-500 block mb-1">自動重試次數</label>
                    <input type="number" min={0} max={5} value={data.retry}
                      onChange={e => upd({ retry: parseInt(e.target.value) || 0 })} className={inputCls} />
                  </div>
                </div>
                <div>
                  <label className="text-xs text-gray-500 block mb-1">期望輸出描述</label>
                  {aiExpectText ? (
                    <div className="w-full border border-amber-200 bg-amber-50 rounded-lg px-2.5 py-1.5 text-xs font-mono text-amber-700 leading-relaxed">
                      <span className="text-amber-400 mr-1">✓</span>{aiExpectText}
                    </div>
                  ) : (
                    <textarea rows={2} value={data.expect} onChange={e => upd({ expect: e.target.value })}
                      placeholder="描述輸出應包含什麼內容…" className={`${inputCls} resize-none`} />
                  )}
                </div>
                <div>
                  <label className="text-xs text-gray-500 block mb-1">工作目錄</label>
                  <input value={data.workingDir} onChange={e => upd({ workingDir: e.target.value })}
                    placeholder="（留空 = 使用預設目錄）" className={inputCls} />
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 border-t bg-gray-50">
          <div className="flex items-center justify-between text-xs text-gray-400">
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full" style={{ background: color }} />
              Python腳本節點
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
