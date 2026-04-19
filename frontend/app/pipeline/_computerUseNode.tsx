'use client'
import { memo } from 'react'
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react'
import type { ComputerUseData } from './_helpers'
import { useRunStatusStore } from './_runStatus'

const STATUS_ICON: Record<string, string> = { idle: '●', running: '⟳', success: '✓', failed: '✗' }
const STATUS_COLOR: Record<string, string> = {
  idle: 'text-white/60', running: 'text-yellow-200 animate-spin', success: 'text-green-200', failed: 'text-red-200',
}

const NODE_COLOR = '#9333ea'  // 紫色 — 區分於其他節點

type ComputerUseNodeType = Node<ComputerUseData>

function ComputerUseNodeComponent({ data, selected }: NodeProps<ComputerUseNodeType>) {
  const runtime = useRunStatusStore(s => s.stepStatuses[data.name])
  const status = runtime?.status ?? 'idle'
  const actionCount = data.actions?.length ?? 0

  const color = status === 'failed' ? '#ef4444'
    : status === 'success' ? '#10b981'
    : status === 'running' ? '#f59e0b'
    : NODE_COLOR

  return (
    <div className="w-56 rounded-xl overflow-hidden shadow-md transition-shadow"
      style={{
        border: selected ? `2px solid ${color}` : '2px solid transparent',
        boxShadow: selected ? `0 0 0 3px ${color}33, 0 4px 16px rgba(0,0,0,0.12)` : '0 2px 8px rgba(0,0,0,0.10)',
      }}
    >
      <Handle type="target" position={Position.Left}
        className="!w-3 !h-3 !rounded-full !border-2 !border-white" style={{ background: color }} />

      {/* Header */}
      <div className="px-3 py-2.5 flex items-center gap-2" style={{ background: color }}>
        <span className="text-white text-xs">🖱</span>
        <span className="text-white font-semibold text-sm flex-1 truncate leading-tight">{data.name}</span>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/20 text-white font-medium shrink-0">桌面自動化</span>
        <span className={`text-sm shrink-0 ${STATUS_COLOR[status]}`}>{STATUS_ICON[status]}</span>
      </div>

      {/* Body */}
      <div className="bg-white px-3 py-2.5 space-y-1">
        <p className="text-xs text-purple-700">
          {actionCount > 0 ? `${actionCount} 個動作` : '尚未錄製任何動作'}
        </p>
        <div className="flex items-center gap-1.5 text-xs text-gray-400">
          {data.failFast && <span title="遇錯即停">⚡</span>}
          <span>超時 {Math.floor(data.timeout / 60)}m</span>
          {data.retry > 0 && <span>・重試 {data.retry}×</span>}
        </div>
      </div>

      <Handle type="source" position={Position.Right}
        className="!w-3 !h-3 !rounded-full !border-2 !border-white" style={{ background: color }} />
    </div>
  )
}

export default memo(ComputerUseNodeComponent)
