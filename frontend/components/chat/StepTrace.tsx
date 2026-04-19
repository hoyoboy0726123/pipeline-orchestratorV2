'use client'

import { ChevronDown, ChevronUp, Wrench, Brain, ListChecks, CheckCircle2 } from 'lucide-react'
import { useState } from 'react'
import type { StepEvent } from '@/lib/types'
import { cn } from '@/lib/utils'

interface StepTraceProps {
  steps: StepEvent[]
}

const stepIcon = (type: StepEvent['type']) => {
  switch (type) {
    case 'plan':       return <ListChecks className="w-3.5 h-3.5 text-brand-500" />
    case 'thinking':   return <Brain className="w-3.5 h-3.5 text-amber-500" />
    case 'tool_call':  return <Wrench className="w-3.5 h-3.5 text-emerald-500" />
    case 'done':       return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
    default:           return <div className="w-3.5 h-3.5 rounded-full bg-gray-300" />
  }
}

const stepLabel = (s: StepEvent): string => {
  switch (s.type) {
    case 'plan':      return `規劃：${s.plan?.join(' → ')?.slice(0, 60) ?? ''}`
    case 'thinking':  return `思考：${(s.message ?? '').slice(0, 80)}`
    case 'tool_call': return `工具：${s.tool}(${(s.args ?? '').slice(0, 40)})`
    case 'status':    return s.message ?? ''
    case 'done':      return '任務完成'
    case 'error':     return `錯誤：${s.message}`
    default:          return s.message ?? ''
  }
}

export function StepTrace({ steps }: StepTraceProps) {
  const [open, setOpen] = useState(false)
  if (steps.length === 0) return null

  return (
    <div className="mt-2 mb-1">
      <button
        onClick={() => setOpen(v => !v)}
        className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-600 transition-colors"
      >
        {open ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        {open ? '收起' : `查看執行過程（${steps.length} 步驟）`}
      </button>

      {open && (
        <div className="mt-2 space-y-1.5 pl-2 border-l-2 border-gray-100">
          {steps.map((s, i) => (
            <div key={i} className="flex items-start gap-2">
              <div className="mt-0.5 shrink-0">{stepIcon(s.type)}</div>
              <p className={cn(
                'text-xs leading-relaxed',
                s.type === 'error' ? 'text-red-500' : 'text-gray-500'
              )}>
                {stepLabel(s)}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
