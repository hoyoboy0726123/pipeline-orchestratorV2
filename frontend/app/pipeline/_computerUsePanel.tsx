'use client'
import { useEffect, useRef, useState } from 'react'
import { X, Circle, Square as StopIcon, Play, Trash2, ChevronUp, ChevronDown, Pencil } from 'lucide-react'
import { toast } from 'sonner'
import type { ComputerUseData, ComputerUseNode, ComputerUseAction } from './_helpers'
import {
  startComputerUseRecording,
  stopComputerUseRecording,
  getComputerUseRecordingStatus,
  loadComputerUseRecording,
  deleteComputerUseAssets,
} from '@/lib/api'
import AnchorEditorModal from './_anchorEditorModal'

const NODE_COLOR = '#9333ea'

interface Props {
  node: ComputerUseNode
  pipelineName: string       // 用於推導預設 assets_dir
  onUpdate: (data: Partial<ComputerUseData>) => void
  onClose: () => void
  onDelete: () => void
}

export default function ComputerUsePanel({ node, pipelineName, onUpdate, onClose, onDelete }: Props) {
  const data = node.data
  const inputCls = 'w-full border border-gray-200 rounded-lg px-2.5 py-1.5 text-sm outline-none focus:border-purple-400 focus:ring-1 focus:ring-purple-400/20 bg-white'

  // 錄製狀態
  const [recording, setRecording] = useState(false)
  const [statusText, setStatusText] = useState('')
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // CV 比對設定摺疊（預設收折，避免佔太多空間）
  const [cvOpen, setCvOpen] = useState(false)

  // 預設錄製輸出目錄
  const defaultAssetsDir = data.assetsDir ||
    `ai_output/${pipelineName || 'pipeline'}/${data.name}_assets`

  // 錄製過程輪詢狀態
  useEffect(() => {
    if (!recording) {
      if (pollRef.current) clearInterval(pollRef.current)
      pollRef.current = null
      return
    }
    const poll = async () => {
      try {
        const s = await getComputerUseRecordingStatus()
        if (s.recording) {
          setStatusText(`錄製中… ${s.action_count ?? 0} 個動作`)
        } else {
          // 錄製已被 F9 或後端自行停止
          setRecording(false)
          setStatusText('')
          await handleLoadRecording()
        }
      } catch {/* ignore transient errors */}
    }
    pollRef.current = setInterval(poll, 1000)
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [recording])

  const handleStart = async () => {
    if (recording) return
    try {
      const sessionId = `${data.name}-${Date.now()}`
      await startComputerUseRecording(sessionId, defaultAssetsDir)
      onUpdate({ assetsDir: defaultAssetsDir })
      setRecording(true)
      setStatusText('錄製中…（按 F9 或這個按鈕結束）')
      toast.success('🔴 開始錄製。請操作螢幕，F9 停止。')
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const handleStop = async () => {
    try {
      await stopComputerUseRecording()
      setRecording(false)
      setStatusText('')
      await handleLoadRecording()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const handleLoadRecording = async () => {
    try {
      const res = await loadComputerUseRecording(defaultAssetsDir)
      onUpdate({ actions: res.actions || [], assetsDir: defaultAssetsDir })
      toast.success(`已載入 ${res.actions?.length ?? 0} 個動作`)
    } catch (e) {
      // 錄製尚未停好或目錄不存在是正常狀況
      console.warn('Load recording:', e)
    }
  }

  // 動作操作
  const moveAction = (i: number, dir: -1 | 1) => {
    const next = [...(data.actions || [])]
    const j = i + dir
    if (j < 0 || j >= next.length) return
    ;[next[i], next[j]] = [next[j], next[i]]
    onUpdate({ actions: next })
  }
  const deleteAction = (i: number) => {
    const next = [...(data.actions || [])]
    next.splice(i, 1)
    onUpdate({ actions: next })
  }
  const [editingAnchor, setEditingAnchor] = useState<number | null>(null)
  const applyAnchorPatch = (i: number, patch: Partial<ComputerUseAction>) => {
    const next = [...(data.actions || [])]
    next[i] = { ...next[i], ...patch }
    onUpdate({ actions: next })
  }

  const toggleUseCoord = (i: number) => {
    const next = [...(data.actions || [])]
    const cur = { ...next[i] }
    // 預設視為 true（座標模式）；toggle 後：true → false（圖像）、false → true（座標）
    const currentlyUsingCoord = cur.use_coord !== false
    cur.use_coord = !currentlyUsingCoord
    // 切回「強制座標」時必須同時關掉 OCR（座標模式下 OCR 不會跑、會讓使用者誤會）
    if (cur.use_coord === true) {
      cur.use_ocr = false
      cur.ocr_text = ''
    }
    next[i] = cur
    onUpdate({ actions: next })
  }

  return (
    <div className="absolute top-0 right-0 h-full w-[420px] bg-white shadow-2xl border-l border-gray-100 flex flex-col z-30 overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3.5 border-b" style={{ borderTopColor: NODE_COLOR, borderTopWidth: 3 }}>
        <span className="w-8 h-8 rounded-full flex items-center justify-center text-white text-sm font-bold shrink-0"
          style={{ background: NODE_COLOR }}>🖱</span>
        <div className="flex-1 min-w-0">
          <span className="font-semibold text-gray-800 text-sm block truncate">桌面自動化節點</span>
          <span className="text-xs text-gray-400">錄製滑鼠/鍵盤操作，以圖像錨點穩定回放</span>
        </div>
        <button onClick={onDelete} title="刪除" className="text-gray-300 hover:text-red-400 transition-colors p-1">🗑</button>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600 transition-colors"><X className="w-4 h-4" /></button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Name */}
        <div>
          <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide block mb-1.5">節點名稱</label>
          <input value={data.name} onChange={e => onUpdate({ name: e.target.value })} className={`${inputCls} font-mono`} />
        </div>

        {/* 錄製按鈕 */}
        <div className="p-3 rounded-lg border border-purple-200 bg-purple-50/50 space-y-2">
          <div className="flex items-center gap-2">
            {!recording ? (
              <button onClick={handleStart}
                className="flex-1 flex items-center justify-center gap-2 px-3 py-2 bg-red-500 hover:bg-red-600 text-white rounded-lg text-sm font-medium transition-colors">
                <Circle className="w-3.5 h-3.5 fill-current" />
                開始錄製
              </button>
            ) : (
              <button onClick={handleStop}
                className="flex-1 flex items-center justify-center gap-2 px-3 py-2 bg-gray-700 hover:bg-gray-800 text-white rounded-lg text-sm font-medium transition-colors">
                <StopIcon className="w-3.5 h-3.5" />
                停止錄製
              </button>
            )}
          </div>
          {recording && (
            <p className="text-xs text-red-600 flex items-center gap-1.5">
              <span className="inline-block w-2 h-2 rounded-full bg-red-500 animate-pulse" />
              {statusText}
            </p>
          )}
          <p className="text-[11px] text-gray-500 leading-relaxed">
            按下開始後切換到要自動化的應用操作即可。點擊會擷取周圍 80×80 的錨點圖（存在 <code className="font-mono text-purple-700">assets_dir</code> 中）。按 F9 或這個按鈕可停止。
          </p>
        </div>

        {/* 動作列表 */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
              動作序列（{data.actions?.length ?? 0}）
            </label>
            {data.actions && data.actions.length > 0 && (
              <button onClick={async () => {
                const dir = data.assetsDir || defaultAssetsDir
                const alsoDelete = confirm(
                  '清除所有動作？\n\n按「確定」會同時刪除磁碟上的錨點圖資料夾（建議，避免殘留檔）。\n按「取消」則只清空節點動作、保留磁碟檔（通常不需要）。'
                )
                onUpdate({ actions: [] })
                if (alsoDelete && dir) {
                  try {
                    const r = await deleteComputerUseAssets(dir)
                    if (r.deleted) toast.success(`已刪除錨點資料夾：${r.path}`)
                    else toast.info(r.reason || '資料夾不存在')
                  } catch (e) {
                    toast.error((e as Error).message)
                  }
                }
              }}
                className="text-[11px] text-red-500 hover:text-red-700">清除全部</button>
            )}
          </div>
          {(!data.actions || data.actions.length === 0) ? (
            <p className="text-xs text-gray-400 text-center py-6 border border-dashed border-gray-200 rounded-lg">
              尚未錄製任何動作
            </p>
          ) : (
            <div className="space-y-1.5">
              {data.actions.map((a: ComputerUseAction, i: number) => (
                <div key={i} className="flex items-start gap-2 p-2 bg-gray-50 border border-gray-200 rounded-lg">
                  <span className="text-[10px] font-mono text-gray-400 pt-0.5">#{i + 1}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-[11px] px-1.5 py-0.5 rounded font-mono bg-purple-100 text-purple-700">
                        {a.type}
                      </span>
                      {a.image && <span className="text-[11px] text-gray-500 truncate">{a.image}</span>}
                      {/* 預設用絕對座標（穩定又快）；畫面會動（視窗被搬走等）時才切到圖像比對 */}
                      {a.type === 'click_image' && (() => {
                        const usingCoord = a.use_coord !== false
                        return (
                          <button onClick={() => toggleUseCoord(i)}
                            title={usingCoord
                              ? '目前用絕對座標點擊（預設、快速）；按一下切到圖像比對（視窗位置會變時用）'
                              : '目前用圖像比對；按一下切回絕對座標（預設、較穩定）'}
                            className={`text-[10px] px-1.5 py-0.5 rounded border transition-colors ${
                              !usingCoord
                                ? 'bg-amber-100 border-amber-300 text-amber-800'
                                : 'bg-white border-gray-200 text-gray-400 hover:text-gray-700 hover:border-gray-400'
                            }`}
                          >
                            {!usingCoord ? '🔍 圖像比對' : '圖像比對'}
                          </button>
                        )
                      })()}
                      {/* 手動編輯錨點（click_image/drag 有 full_image 時才顯示） */}
                      {(a.type === 'click_image' || a.type === 'drag') && a.full_image && (
                        <button onClick={() => setEditingAnchor(i)}
                          title="手動圈選錨點（用全螢幕截圖重新定義這個動作要比對的區域）"
                          className="text-[10px] px-1.5 py-0.5 rounded border bg-white border-purple-200 text-purple-600 hover:bg-purple-50">
                          <Pencil className="w-2.5 h-2.5 inline" /> 編輯錨點
                        </button>
                      )}
                    </div>
                    {a.description && <p className="text-xs text-gray-600 mt-0.5 truncate">{a.description}</p>}
                    {a.text && <p className="text-xs text-gray-500 mt-0.5 truncate font-mono">"{a.text}"</p>}
                    {a.keys && a.keys.length > 0 && (
                      <p className="text-xs text-gray-500 mt-0.5 font-mono">{a.keys.join('+')}</p>
                    )}
                    {typeof a.seconds === 'number' && a.seconds > 0 && (
                      <p className="text-xs text-gray-500 mt-0.5">{a.seconds}s</p>
                    )}
                    {/* OCR 文字比對（只對 click_image action 顯示）
                        用 checkbox 控制啟用，避免原本「填了 ocr_text 但 use_coord 還是 true → OCR 根本沒跑」的 silent bug。
                        規則：
                          - checkbox 勾選 = input enable + 強制圖像比對模式（use_coord=false）
                          - 勾選當下如果 input 為空，自動把焦點放進 input 提示使用者填字
                          - 取消勾選 = 清空 ocr_text（input 自動 disable）
                          - 不動 use_coord（使用者可能想切回座標模式，讓他自由選）
                        OCR 啟用狀態由 use_ocr 欄位控制（新增的顯式 boolean），ocr_text 只放內容 */}
                    {a.type === 'click_image' && (() => {
                      const ocrEnabled = a.use_ocr === true
                      const inputId = `ocr-input-${i}`
                      return (
                        <div className="mt-1 flex items-center gap-1.5">
                          <label className="flex items-center gap-1 shrink-0 cursor-pointer select-none"
                            title={ocrEnabled
                              ? '已啟用 OCR 文字比對；執行時會先用 Windows OCR 找下列文字，找不到才 fallback CV'
                              : '勾選後用 Windows OCR 找文字（取代 CV 圖像比對）'}>
                            <input
                              type="checkbox"
                              checked={ocrEnabled}
                              onChange={e => {
                                if (e.target.checked) {
                                  // 開啟 OCR：強制切圖像比對模式，並 focus input 讓使用者填字
                                  applyAnchorPatch(i, { use_ocr: true, use_coord: false })
                                  setTimeout(() => {
                                    const el = document.getElementById(inputId) as HTMLInputElement | null
                                    el?.focus()
                                  }, 50)
                                } else {
                                  // 關閉 OCR：清空文字和 use_ocr 旗標；use_coord 不動
                                  applyAnchorPatch(i, { use_ocr: false, ocr_text: '' })
                                }
                              }}
                              className="w-3 h-3 rounded accent-purple-600"
                            />
                            <span className={`text-[10px] ${ocrEnabled ? 'text-purple-700 font-medium' : 'text-gray-500'}`}>
                              🔤 OCR
                            </span>
                          </label>
                          <input
                            id={inputId}
                            type="text"
                            value={a.ocr_text || ''}
                            onChange={e => applyAnchorPatch(i, { ocr_text: e.target.value })}
                            disabled={!ocrEnabled}
                            placeholder={ocrEnabled ? '要找的文字（例：關閉、下載）' : '勾選 OCR 才能填寫'}
                            className={`flex-1 min-w-0 text-[11px] px-1.5 py-0.5 rounded border outline-none ${
                              ocrEnabled
                                ? 'border-purple-300 bg-white focus:border-purple-500 focus:ring-1 focus:ring-purple-400/20'
                                : 'border-gray-200 bg-gray-50 text-gray-400 cursor-not-allowed'
                            }`}
                          />
                        </div>
                      )
                    })()}
                  </div>
                  <div className="flex flex-col shrink-0">
                    <button onClick={() => moveAction(i, -1)} className="p-0.5 text-gray-400 hover:text-gray-700 disabled:opacity-30" disabled={i === 0}>
                      <ChevronUp className="w-3 h-3" />
                    </button>
                    <button onClick={() => moveAction(i, 1)} className="p-0.5 text-gray-400 hover:text-gray-700 disabled:opacity-30" disabled={i === (data.actions!.length - 1)}>
                      <ChevronDown className="w-3 h-3" />
                    </button>
                  </div>
                  <button onClick={() => deleteAction(i)} className="text-gray-300 hover:text-red-500 shrink-0">
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Assets 目錄 */}
        <div>
          <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide block mb-1.5">
            錨點圖片資料夾（相對專案根或絕對路徑）
          </label>
          <input value={data.assetsDir} onChange={e => onUpdate({ assetsDir: e.target.value })}
            placeholder={defaultAssetsDir}
            className={`${inputCls} font-mono text-xs`} />
        </div>

        {/* 選項 */}
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input type="checkbox" checked={data.failFast}
              onChange={e => onUpdate({ failFast: e.target.checked })} className="w-4 h-4 accent-purple-600" />
            <span className="text-gray-700">遇錯立即中止（fail_fast）</span>
          </label>
        </div>

        {/* CV 比對設定（可摺疊，預設收折） */}
        <div className="rounded-xl border border-gray-200 bg-gray-50/50 overflow-hidden">
          <button
            type="button"
            onClick={() => setCvOpen(v => !v)}
            className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-gray-100/80 transition-colors"
          >
            {cvOpen ? <ChevronUp className="w-3.5 h-3.5 text-gray-400" />
                    : <ChevronDown className="w-3.5 h-3.5 text-gray-400" />}
            <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide flex-1">CV 比對設定</span>
            <span className="text-[11px] text-gray-400 font-mono">
              {(data.cvThreshold ?? 0.65)}{data.cvSearchOnlyNear ? ' · 只搜附近' : ''}{(data.cvTriggerHover ?? true) ? ` · hover ${data.cvHoverWaitMs ?? 200}ms` : ''}
            </span>
          </button>
          {cvOpen && (
            <div className="px-3 pb-3 space-y-3 border-t border-gray-200">
              <div className="pt-3" />
              {/* 比對門檻 3 段 */}
              <div>
                <label className="text-xs text-gray-600 block mb-1.5">比對門檻</label>
                <div className="grid grid-cols-3 gap-1">
                  {[
                    { v: 0.65, label: '寬鬆', hint: '容錯高，DPI 差異容忍' },
                    { v: 0.80, label: '標準', hint: '預設 sweet spot' },
                    { v: 0.90, label: '嚴格', hint: '幾乎不誤判' },
                  ].map(opt => (
                    <button
                      key={opt.v}
                      type="button"
                      onClick={() => onUpdate({ cvThreshold: opt.v })}
                      title={opt.hint}
                      className={`px-2 py-1.5 rounded-lg text-xs font-medium transition-colors border ${
                        (data.cvThreshold ?? 0.65) === opt.v
                          ? 'bg-purple-500 text-white border-purple-500'
                          : 'bg-white text-gray-600 border-gray-200 hover:border-purple-300'
                      }`}
                    >
                      {opt.label} {opt.v}
                    </button>
                  ))}
                </div>
              </div>

              {/* 只搜附近 toggle */}
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input type="checkbox" checked={data.cvSearchOnlyNear}
                  onChange={e => onUpdate({ cvSearchOnlyNear: e.target.checked })}
                  className="w-4 h-4 accent-purple-600" />
                <span className="text-gray-700">只搜錄製座標附近</span>
              </label>
              <p className="text-[11px] text-gray-400 leading-relaxed pl-6 -mt-1">
                {data.cvSearchOnlyNear
                  ? '開啟：只在附近搜尋，不擴大到全螢幕（避免跨螢幕找錯位置）'
                  : '關閉：附近找不到 → 擴大到全螢幕 CV 搜尋'}
              </p>

              {/* CV 失敗退回座標 toggle */}
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input type="checkbox" checked={data.cvCoordFallback ?? true}
                  onChange={e => onUpdate({ cvCoordFallback: e.target.checked })}
                  className="w-4 h-4 accent-purple-600" />
                <span className="text-gray-700">CV 失敗退回錄製座標</span>
              </label>
              <p className="text-[11px] text-gray-400 leading-relaxed pl-6 -mt-1">
                {(data.cvCoordFallback ?? true)
                  ? '開啟（建議）：CV 完全找不到時退回原錄製座標硬點下去 — 對畫面變動小的場景多一層保險'
                  : '關閉：CV 失敗就直接 FAIL，不亂點。適合畫面動態大、原座標可能無效的情境'}
              </p>

              {/* 觸發 hover toggle */}
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input type="checkbox" checked={data.cvTriggerHover ?? true}
                  onChange={e => onUpdate({ cvTriggerHover: e.target.checked })}
                  className="w-4 h-4 accent-purple-600" />
                <span className="text-gray-700">比對前觸發 hover 效果</span>
              </label>
              <p className="text-[11px] text-gray-400 leading-relaxed pl-6 -mt-1">
                {(data.cvTriggerHover ?? true)
                  ? '開啟（建議）：先把游標移到錄製座標 + 等待，讓 Windows hover highlight 出現後再比對。'
                  : '關閉：跳過 hover 觸發、每次 click_image 會快一點。若錨點不含 hover 變色區域可關掉'}
              </p>

              {/* hover 等待 2 段 */}
              {(data.cvTriggerHover ?? true) && (
                <div>
                  <label className="text-xs text-gray-600 block mb-1.5">Hover 等待時間</label>
                  <div className="grid grid-cols-2 gap-1">
                    {[
                      { v: 200, label: '快', hint: '200ms，夠大多數 Windows UI' },
                      { v: 400, label: '保險', hint: '400ms，應付 fade-in 較慢的動畫或遠端桌面' },
                    ].map(opt => (
                      <button
                        key={opt.v}
                        type="button"
                        onClick={() => onUpdate({ cvHoverWaitMs: opt.v })}
                        title={opt.hint}
                        className={`px-2 py-1.5 rounded-lg text-xs font-medium transition-colors border ${
                          (data.cvHoverWaitMs ?? 200) === opt.v
                            ? 'bg-purple-500 text-white border-purple-500'
                            : 'bg-white text-gray-600 border-gray-200 hover:border-purple-300'
                        }`}
                      >
                        {opt.label} {opt.v}ms
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* 搜尋半徑 */}
              <div>
                <label className="text-xs text-gray-600 block mb-1.5">
                  附近搜尋半徑
                  <span className="text-gray-400 font-normal">
                    （實際搜尋 {(data.cvSearchRadius ?? 400) * 2}×{(data.cvSearchRadius ?? 400) * 2} px）
                  </span>
                </label>
                <input
                  type="number"
                  min={50}
                  max={2000}
                  step={50}
                  value={data.cvSearchRadius ?? 400}
                  onChange={e => {
                    const v = parseInt(e.target.value) || 400
                    onUpdate({ cvSearchRadius: Math.max(50, Math.min(2000, v)) })
                  }}
                  className={inputCls}
                />
                <p className="text-[11px] text-gray-400 mt-1">
                  視窗很少移動 → 可調小（150-200）更快更準；常跨螢幕 → 調大（600-800）
                </p>
              </div>
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide block mb-1.5">超時（秒）</label>
            <input type="number" value={data.timeout}
              onChange={e => onUpdate({ timeout: parseInt(e.target.value) || 300 })} className={inputCls} />
          </div>
          <div>
            <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide block mb-1.5">重試次數</label>
            <input type="number" value={data.retry}
              onChange={e => onUpdate({ retry: parseInt(e.target.value) || 0 })} className={inputCls} />
          </div>
        </div>

        <div className="p-2.5 bg-yellow-50 border border-yellow-200 rounded-lg text-[11px] text-yellow-800 leading-relaxed">
          <strong>⚠ 安全提醒</strong>：執行時滑鼠會實際操作系統。失控可把滑鼠甩到螢幕左上角 (0,0) 立即中止。動作數上限 500。
        </div>
      </div>

      {/* 手動圈選錨點 Modal */}
      {editingAnchor !== null && data.actions && data.actions[editingAnchor] && (
        <AnchorEditorModal
          action={data.actions[editingAnchor]}
          actionIndex={editingAnchor}
          assetsDir={data.assetsDir || defaultAssetsDir}
          onApply={(patch) => applyAnchorPatch(editingAnchor, patch)}
          onClose={() => setEditingAnchor(null)}
        />
      )}
    </div>
  )
}
