'use client'
import { X } from 'lucide-react'
import type { HumanConfirmData, HumanConfirmNode } from './_helpers'

const CONFIRM_COLOR = '#10b981'

interface Props {
  node: HumanConfirmNode
  onUpdate: (data: Partial<HumanConfirmData>) => void
  onClose: () => void
  onDelete: () => void
}

export default function HumanConfirmPanel({ node, onUpdate, onClose, onDelete }: Props) {
  const data = node.data
  const inputCls = 'w-full border border-gray-200 rounded-lg px-2.5 py-1.5 text-sm outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-400/20 bg-white'

  return (
    <div className="absolute top-0 right-0 h-full w-[380px] bg-white shadow-2xl border-l border-gray-100 flex flex-col z-30 overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3.5 border-b" style={{ borderTopColor: CONFIRM_COLOR, borderTopWidth: 3 }}>
        <span className="w-8 h-8 rounded-full flex items-center justify-center text-white text-sm font-bold shrink-0"
          style={{ background: CONFIRM_COLOR }}>✋</span>
        <div className="flex-1 min-w-0">
          <span className="font-semibold text-gray-800 text-sm block truncate">人工確認節點</span>
          <span className="text-xs text-gray-400">暫停 Pipeline 等待人工確認，可透過 Telegram 或網頁操作</span>
        </div>
        <button onClick={onDelete} title="刪除" className="text-gray-300 hover:text-red-400 transition-colors p-1">🗑</button>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600 transition-colors"><X className="w-4 h-4" /></button>
      </div>

      {/* Fields */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Name */}
        <div>
          <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide block mb-1.5">節點名稱</label>
          <input value={data.name} onChange={e => onUpdate({ name: e.target.value })} className={`${inputCls} font-mono`} placeholder="人工確認" />
        </div>

        {/* Message */}
        <div>
          <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide block mb-2">確認訊息</label>
          <textarea
            rows={4}
            value={data.message}
            onChange={e => onUpdate({ message: e.target.value })}
            placeholder={'（選填）自訂確認提示…\n例如：請確認抓取的資料筆數正確，再繼續進行分析'}
            className={`${inputCls} resize-none text-xs leading-relaxed`}
          />
          <p className="text-xs text-gray-400 mt-1.5">留空則顯示預設訊息：「請確認上一步結果是否正確」</p>
        </div>

        {/* Telegram toggle */}
        <div className="flex items-center justify-between p-3 rounded-xl border border-gray-200 bg-gray-50/50">
          <div className="flex-1 min-w-0 mr-3">
            <div className="text-sm font-medium text-gray-700">📱 Telegram 通知</div>
            <p className="text-xs text-gray-400 mt-0.5">
              {data.notifyTelegram
                ? '已啟用：暫停時會透過 Telegram 發送摘要和確認按鈕'
                : '已關閉：僅透過網頁 UI 等待確認'}
            </p>
          </div>
          <button
            onClick={() => onUpdate({ notifyTelegram: !data.notifyTelegram })}
            className={`relative w-11 h-6 rounded-full transition-colors shrink-0 ${
              data.notifyTelegram ? 'bg-emerald-500' : 'bg-gray-300'
            }`}
          >
            <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${
              data.notifyTelegram ? 'translate-x-5' : 'translate-x-0'
            }`} />
          </button>
        </div>

        {/* Screenshot toggle */}
        <div className="flex items-center justify-between p-3 rounded-xl border border-gray-200 bg-gray-50/50">
          <div className="flex-1 min-w-0 mr-3">
            <div className="text-sm font-medium text-gray-700">📸 自動截圖</div>
            <p className="text-xs text-gray-400 mt-0.5">
              {data.screenshot
                ? '已啟用：暫停前自動截取螢幕畫面，附帶到 Telegram 通知'
                : '已關閉：不截取螢幕畫面'}
            </p>
          </div>
          <button
            onClick={() => onUpdate({ screenshot: !data.screenshot })}
            className={`relative w-11 h-6 rounded-full transition-colors shrink-0 ${
              data.screenshot ? 'bg-emerald-500' : 'bg-gray-300'
            }`}
          >
            <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${
              data.screenshot ? 'translate-x-5' : 'translate-x-0'
            }`} />
          </button>
        </div>

        {/* Timeout */}
        <div>
          <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide block mb-1.5">等待超時</label>
          <div className="grid grid-cols-4 gap-2 mb-2">
            {[
              { v: 600, label: '10 分鐘' },
              { v: 1800, label: '30 分鐘' },
              { v: 3600, label: '1 小時' },
              { v: 86400, label: '24 小時' },
            ].map(opt => (
              <button
                key={opt.v}
                onClick={() => onUpdate({ timeout: opt.v })}
                className={`py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                  data.timeout === opt.v
                    ? 'border-emerald-500 bg-emerald-50 text-emerald-700'
                    : 'border-gray-200 text-gray-600 hover:border-emerald-300'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <input
            type="number"
            min={60}
            max={259200}
            value={data.timeout}
            onChange={e => onUpdate({ timeout: parseInt(e.target.value) || 3600 })}
            className={`${inputCls} font-mono`}
          />
          <p className="text-xs text-gray-400 mt-1">超過此秒數未確認，Pipeline 自動中止</p>
        </div>
      </div>

      {/* Footer */}
      <div className="p-4 border-t bg-emerald-50">
        <div className="flex items-center justify-between text-xs text-gray-400">
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full" style={{ background: CONFIRM_COLOR }} />
            人工確認節點
          </span>
          <span className={`px-2 py-0.5 rounded-full font-medium ${
            data.status === 'success' ? 'bg-green-100 text-green-700' :
            data.status === 'failed'  ? 'bg-red-100 text-red-700' :
            data.status === 'running' ? 'bg-amber-100 text-amber-700' :
            'bg-gray-100 text-gray-500'
          }`}>
            {data.status === 'idle' ? '等待中' : data.status === 'running' ? '確認中' : data.status === 'success' ? '已確認' : '已中止'}
          </span>
        </div>
      </div>
    </div>
  )
}
