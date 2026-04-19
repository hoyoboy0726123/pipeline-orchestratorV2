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
          <span className="text-xs text-gray-400">LLM 快速檢查前一步的輸出是否符合預期（約 5 秒）</span>
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

      </div>

      <div className="p-4 border-t bg-amber-50">
        <p className="text-xs text-amber-600">此節點的描述會自動寫入前一步驟的 AI 驗證欄位</p>
      </div>
    </div>
  )
}
