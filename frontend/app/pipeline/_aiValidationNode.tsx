'use client'
import { memo } from 'react'
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react'
import type { AiValidationData } from './_helpers'

type AiValidationNode = Node<AiValidationData>

function AiValidationNodeComponent({ data, selected }: NodeProps<AiValidationNode>) {
  const color = '#f59e0b'

  return (
    <div
      className="w-52 rounded-xl overflow-hidden shadow-md transition-shadow"
      style={{
        border: selected ? `2px solid ${color}` : '2px solid transparent',
        boxShadow: selected
          ? `0 0 0 3px ${color}33, 0 4px 16px rgba(0,0,0,0.12)`
          : '0 2px 8px rgba(0,0,0,0.10)',
      }}
    >
      <Handle type="target" position={Position.Left}
        className="!w-3 !h-3 !rounded-full !border-2 !border-white" style={{ background: color }} />

      <div className="px-3 py-2 flex items-center gap-2" style={{ background: color }}>
        <span className="text-white text-sm">✓</span>
        <span className="text-white font-semibold text-sm flex-1 truncate">AI 驗證</span>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/20 text-white font-medium">驗證</span>
      </div>

      <div className="bg-white px-3 py-2.5">
        <p className="text-xs text-gray-500 leading-relaxed" style={{
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        }}>
          {data.expectText || '點擊設定驗證描述…'}
        </p>
        {data.targetPath && (
          <p className="text-xs text-gray-400 truncate mt-1">
            {'📁 ' + data.targetPath.replace(/^.*\/([^/]+)$/, '$1')}
          </p>
        )}
      </div>

      <Handle type="source" position={Position.Right}
        className="!w-3 !h-3 !rounded-full !border-2 !border-white" style={{ background: color }} />
    </div>
  )
}

export default memo(AiValidationNodeComponent)
