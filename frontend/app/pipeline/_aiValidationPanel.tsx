'use client'
import { X } from 'lucide-react'
import type { AiValidationData } from './_helpers'

interface Props {
  data: AiValidationData
  onUpdate: (patch: Partial<AiValidationData>) => void
  onClose: () => void
  onDelete: () => void
}

export default function AiValidationPanel({ data, onUpdate, onClose, onDelete }: Props) {
  const color = '#f59e0b'
  const inputCls = 'w-full border border-gray-200 rounded-lg px-2.5 py-1.5 text-sm outline-none focus:border-amber-400 focus:ring-1 focus:ring-amber-400/20 bg-white'
  const skillOn = data.skillMode === true

  return (
    <div className="absolute top-0 right-0 h-full w-[380px] bg-white shadow-2xl border-l border-gray-100 flex flex-col z-30 overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3.5 border-b" style={{ borderTopColor: color, borderTopWidth: 3 }}>
        <span
          className="w-8 h-8 rounded-full flex items-center justify-center text-white text-sm font-bold shrink-0"
          style={{ background: color }}
        >
          ✓
        </span>
        <div className="flex-1 min-w-0">
          <span className="font-semibold text-gray-800 text-sm block truncate">AI 驗證節點</span>
          <span className="text-xs text-gray-400">
            {skillOn
              ? '深度驗證：ReAct agent 多輪寫程式查（30~60 秒、耗 token）'
              : 'LLM 快速檢查前一步的輸出是否符合預期（約 5 秒）'}
          </span>
        </div>
        <button onClick={onDelete} title="刪除節點" className="text-gray-300 hover:text-red-400 transition-colors p-1">
          🗑
        </button>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600 transition-colors">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        <div>
          <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide block mb-1.5">驗證描述</label>
          <textarea
            rows={4}
            value={data.expectText}
            onChange={e => onUpdate({ expectText: e.target.value })}
            placeholder={'用自然語言描述 AI 應該確認什麼…\n例如：確認輸出的 CSV 包含至少 100 筆資料，且欄位 email 格式正確'}
            className={`${inputCls} resize-none font-mono text-xs leading-relaxed`}
          />
          <p className="text-xs text-gray-400 mt-1.5">AI 會在前一步驟完成後，依據此描述驗證執行結果</p>
        </div>

        <div>
          <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide block mb-1.5">驗證目標路徑（選填）</label>
          <input
            value={data.targetPath}
            onChange={e => onUpdate({ targetPath: e.target.value })}
            placeholder="~/output/result.csv"
            className={`${inputCls} font-mono`}
          />
          <p className="text-xs text-gray-400 mt-1">指定要驗證的輸出檔案路徑，留空則驗證前一步驟的標準輸出</p>
        </div>

        {/* 驗證深度（Skill 模式 toggle）：預設關＝快速；開啟＝深度 ReAct 多輪查 */}
        <div className="rounded-xl border border-amber-200 bg-amber-50/40 p-3">
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={skillOn}
              onChange={e => onUpdate({ skillMode: e.target.checked })}
              className="mt-0.5 w-4 h-4 accent-amber-600"
            />
            <div className="flex-1">
              <div className="text-sm font-medium text-gray-800">深度驗證（Skill 模式）</div>
              <p className="text-[11px] text-gray-600 leading-relaxed mt-0.5">
                {skillOn ? (
                  <>
                    <strong>已啟用</strong>：驗證器是 ReAct agent，可以反覆 run_python / read_file / view_image 來深度檢查（例：用 openpyxl 拆 chart 看 dPt 顏色、看 PNG 圖確認渲染）。
                    <br /><span className="text-amber-700">⚠ 30–60 秒、耗 token；只在文字檢查不夠用時開</span>
                  </>
                ) : (
                  <>
                    <strong>關（預設）</strong>：一次性 LLM call、看 stdout + 自動附上輸出圖檔，5 秒內回。適合一般驗證。
                  </>
                )}
              </p>
            </div>
          </label>
        </div>
      </div>

      <div className="p-4 border-t bg-amber-50">
        <p className="text-xs text-amber-600">此節點的描述會自動寫入前一步驟的 AI 驗證欄位</p>
      </div>
    </div>
  )
}
