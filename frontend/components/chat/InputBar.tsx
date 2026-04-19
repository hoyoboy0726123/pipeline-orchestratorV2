'use client'

import { useState, useRef, type KeyboardEvent } from 'react'
import { Send, StopCircle, ChevronDown } from 'lucide-react'
import type { OutputFormat } from '@/lib/types'
import { cn } from '@/lib/utils'

const FORMAT_OPTIONS: { value: OutputFormat; label: string }[] = [
  { value: 'md',    label: 'Markdown' },
  { value: 'table', label: '表格' },
  { value: 'json',  label: 'JSON' },
  { value: 'yaml',  label: 'YAML' },
  { value: 'csv',   label: 'CSV' },
]

interface InputBarProps {
  onSend: (task: string, format: OutputFormat) => void
  disabled?: boolean
  onStop?: () => void
}

export function InputBar({ onSend, disabled, onStop }: InputBarProps) {
  const [text, setText] = useState('')
  const [format, setFormat] = useState<OutputFormat>('md')
  const [showFmtMenu, setShowFmtMenu] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const handleSend = () => {
    const trimmed = text.trim()
    if (!trimmed || disabled) return
    onSend(trimmed, format)
    setText('')
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleInput = () => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }

  const currentFmtLabel = FORMAT_OPTIONS.find(f => f.value === format)?.label ?? 'Markdown'

  return (
    <div className="border-t border-gray-200 bg-white px-4 py-4">
      <div className="max-w-3xl mx-auto">
        <div className="flex items-end gap-2 bg-white border border-gray-200 rounded-2xl px-4 py-3 shadow-sm
                        focus-within:ring-2 focus-within:ring-brand-500/25 focus-within:border-brand-400
                        transition-all duration-150">

          {/* Textarea */}
          <textarea
            ref={textareaRef}
            value={text}
            onChange={e => { setText(e.target.value); handleInput() }}
            onKeyDown={handleKeyDown}
            placeholder="輸入任務... (Shift+Enter 換行，Enter 送出)"
            rows={1}
            disabled={disabled}
            className="flex-1 resize-none outline-none text-sm text-gray-900 placeholder-gray-400
                       bg-transparent leading-relaxed max-h-48 disabled:opacity-60"
          />

          {/* Right controls */}
          <div className="flex items-center gap-2 shrink-0 pb-0.5">
            {/* Format selector */}
            <div className="relative">
              <button
                onClick={() => setShowFmtMenu(v => !v)}
                className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700
                           bg-gray-100 hover:bg-gray-200 px-2.5 py-1.5 rounded-lg transition-colors"
              >
                {currentFmtLabel}
                <ChevronDown className="w-3 h-3" />
              </button>
              {showFmtMenu && (
                <div className="absolute bottom-full mb-1 right-0 bg-white border border-gray-200
                                rounded-xl shadow-lg py-1 min-w-[100px] z-10">
                  {FORMAT_OPTIONS.map(opt => (
                    <button
                      key={opt.value}
                      onClick={() => { setFormat(opt.value); setShowFmtMenu(false) }}
                      className={cn(
                        'w-full text-left px-3 py-1.5 text-xs hover:bg-gray-50 transition-colors',
                        format === opt.value ? 'text-brand-600 font-medium' : 'text-gray-700'
                      )}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Send / Stop */}
            {disabled ? (
              <button
                onClick={onStop}
                className="w-8 h-8 rounded-xl bg-red-100 hover:bg-red-200 text-red-600
                           flex items-center justify-center transition-colors"
              >
                <StopCircle className="w-4 h-4" />
              </button>
            ) : (
              <button
                onClick={handleSend}
                disabled={!text.trim()}
                className={cn(
                  'w-8 h-8 rounded-xl flex items-center justify-center transition-all duration-150',
                  text.trim()
                    ? 'bg-brand-600 hover:bg-brand-700 text-white'
                    : 'bg-gray-100 text-gray-300 cursor-not-allowed'
                )}
              >
                <Send className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>

        <p className="text-center text-xs text-gray-400 mt-2">
          AI 可能出錯，重要決策請自行查驗
        </p>
      </div>
    </div>
  )
}
