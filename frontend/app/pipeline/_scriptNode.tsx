'use client'
import { memo } from 'react'
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react'
import type { StepData } from './_helpers'
import { stepColor } from './_helpers'
import { useRunStatusStore } from './_runStatus'

const STATUS_ICON: Record<string, string> = { idle: '●', running: '⟳', success: '✓', failed: '✗' }
const STATUS_COLOR: Record<string, string> = {
  idle: 'text-white/60', running: 'text-yellow-200 animate-spin', success: 'text-green-200', failed: 'text-red-200',
}

type ScriptNode = Node<StepData>

function ScriptStepNode({ data, selected }: NodeProps<ScriptNode>) {
  const runtime = useRunStatusStore(s => s.stepStatuses[data.name])
  const status = runtime?.status ?? 'idle'
  const errorMsg = runtime?.errorMsg ?? ''

  const color = status === 'failed' ? '#ef4444'
    : status === 'success' ? '#10b981'
    : status === 'running' ? '#3b82f6'
    : '#3b82f6'

  const batchPreview = data.batch
    ? data.batch.replace(/^.*\/([^/\s]+\.py|[^/\s]+\.sh|[^/\s]+\.js)\s*$/, '$1')
    : '尚未設定指令'

  return (
    <div className="w-60 rounded-xl overflow-hidden shadow-md transition-shadow"
      style={{
        border: selected ? `2px solid ${color}` : '2px solid transparent',
        boxShadow: selected ? `0 0 0 3px ${color}33, 0 4px 16px rgba(0,0,0,0.12)` : '0 2px 8px rgba(0,0,0,0.10)',
      }}
    >
      <Handle type="target" position={Position.Left}
        className="!w-3 !h-3 !rounded-full !border-2 !border-white" style={{ background: color }} />

      {/* Header */}
      <div className="px-3 py-2.5 flex items-center gap-2" style={{ background: color }}>
        <span className="text-white text-xs">▶</span>
        <span className="text-white font-semibold text-sm flex-1 truncate leading-tight">{data.name}</span>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/20 text-white font-medium shrink-0">Python腳本</span>
        <span className={`text-sm shrink-0 ${STATUS_COLOR[status]}`}>{STATUS_ICON[status]}</span>
      </div>

      {/* Body */}
      <div className="bg-white px-3 py-2.5 space-y-1">
        <p className="text-xs text-gray-500 font-mono truncate">{batchPreview}</p>
        {data.outputPath ? (
          <p className="text-xs text-gray-400 truncate">→ {data.outputPath.replace(/^.*\/([^/]+)$/, '$1')}</p>
        ) : (
          <p className="text-xs text-gray-300 italic">（無輸出路徑）</p>
        )}
        {status === 'failed' && errorMsg && <p className="text-xs text-red-500 truncate">{errorMsg}</p>}
      </div>

      <Handle type="source" position={Position.Right}
        className="!w-3 !h-3 !rounded-full !border-2 !border-white" style={{ background: color }} />
    </div>
  )
}

export default memo(ScriptStepNode)
