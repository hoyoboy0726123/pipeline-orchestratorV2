'use client'
import { useState, useRef, useEffect } from 'react'
import {
  BaseEdge, EdgeLabelRenderer, getSmoothStepPath, useReactFlow,
  type EdgeProps, type Edge,
} from '@xyflow/react'
import { Plus, Trash2, Code2, Sparkles, Hand, Zap, BookOpen } from 'lucide-react'

/**
 * 自訂 Edge：hover 時在中點浮出 + 跟 🗑️ 按鈕（n8n 風格）
 *   + → 開小選單選要插什麼節點，插入後自動把現有 edge 拆成「src → new → tgt」
 *   🗑️ → 刪除這條 edge
 *
 * 註冊方式：ReactFlow edgeTypes={{ insertable: InsertableEdge }}
 * 新建 edge 都給 type: 'insertable'
 */
export default function InsertableEdge(props: EdgeProps<Edge>) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition,
          markerEnd, style, source, target } = props
  const [hover, setHover] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const rf = useReactFlow()

  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX, sourceY, sourcePosition,
    targetX, targetY, targetPosition,
  })

  const handleDelete = () => {
    rf.setEdges(es => es.filter(e => e.id !== id))
  }

  // 取得要新增節點的大概位置（edge 中點）
  const handleInsert = (nodeType: 'scriptStep' | 'skillStep' | 'aiValidation' | 'humanConfirmation' | 'computerUse') => {
    setMenuOpen(false)
    // 觸發全域事件讓 page.tsx 去處理（page.tsx 擁有 newStepData/newSkillData 等 factory）
    // 這樣邏輯不會跨檔重複
    const event = new CustomEvent('pipeline-insert-node-on-edge', {
      detail: { edgeId: id, source, target, nodeType, labelX, labelY },
    })
    window.dispatchEvent(event)
  }

  // 點外面關選單
  const menuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!menuOpen) return
    const h = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    window.addEventListener('mousedown', h)
    return () => window.removeEventListener('mousedown', h)
  }, [menuOpen])

  return (
    <>
      <BaseEdge id={id} path={edgePath} markerEnd={markerEnd} style={style} />
      {/* 透明加寬熱區：預設 edge 才 2px 寬 hover 不到，加一條 20px 透明 path 擴大感應區 */}
      <path
        d={edgePath}
        fill="none"
        stroke="transparent"
        strokeWidth={20}
        style={{ cursor: 'pointer' }}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
      />
      <EdgeLabelRenderer>
        <div
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            pointerEvents: 'all',
          }}
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
        >
          {(hover || menuOpen) && (
            <div className="flex items-center gap-1 bg-white rounded-lg shadow-lg border border-gray-200 px-1 py-1">
              <button
                onClick={() => setMenuOpen(v => !v)}
                className="w-7 h-7 flex items-center justify-center rounded hover:bg-blue-50 text-blue-600 transition-colors"
                title="在這裡插入新節點"
              >
                <Plus className="w-4 h-4" />
              </button>
              <button
                onClick={handleDelete}
                className="w-7 h-7 flex items-center justify-center rounded hover:bg-red-50 text-red-600 transition-colors"
                title="刪除這條連線"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          )}
          {menuOpen && (
            <div
              ref={menuRef}
              className="absolute top-full mt-1 left-1/2 -translate-x-1/2 bg-white rounded-lg shadow-xl border border-gray-200 py-1 min-w-[180px] z-50"
            >
              <div className="text-[11px] text-gray-500 px-3 py-1 border-b border-gray-100">插入節點</div>
              <button onClick={() => handleInsert('scriptStep')}
                className="w-full px-3 py-1.5 text-sm flex items-center gap-2 hover:bg-blue-50 text-left">
                <Code2 className="w-3.5 h-3.5 text-blue-600" /> Python 腳本
              </button>
              <button onClick={() => handleInsert('skillStep')}
                className="w-full px-3 py-1.5 text-sm flex items-center gap-2 hover:bg-purple-50 text-left">
                <Sparkles className="w-3.5 h-3.5 text-purple-600" /> AI 技能
              </button>
              <button onClick={() => handleInsert('aiValidation')}
                className="w-full px-3 py-1.5 text-sm flex items-center gap-2 hover:bg-amber-50 text-left">
                <BookOpen className="w-3.5 h-3.5 text-amber-600" /> AI 驗證
              </button>
              <button onClick={() => handleInsert('humanConfirmation')}
                className="w-full px-3 py-1.5 text-sm flex items-center gap-2 hover:bg-emerald-50 text-left">
                <Hand className="w-3.5 h-3.5 text-emerald-600" /> 人工確認
              </button>
              <button onClick={() => handleInsert('computerUse')}
                className="w-full px-3 py-1.5 text-sm flex items-center gap-2 hover:bg-rose-50 text-left">
                <Zap className="w-3.5 h-3.5 text-rose-600" /> 桌面自動化
              </button>
            </div>
          )}
        </div>
      </EdgeLabelRenderer>
    </>
  )
}
