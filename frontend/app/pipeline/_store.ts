import { create } from 'zustand'
import type { Edge } from '@xyflow/react'
import type { AppNode } from './_helpers'
import {
  listWorkflows, createWorkflowApi, updateWorkflowApi, deleteWorkflowApi,
  type WorkflowData,
} from '@/lib/api'

// ── 一個工作流的完整資料 ─────────────────────────────────────────────────────
export interface Workflow {
  id: string
  name: string
  nodes: AppNode[]
  edges: Edge[]
  validate: boolean
  updatedAt: number
}

/** 遷移舊節點類型：pipelineStep → scriptStep / skillStep */
function migrateNodes(nodes: AppNode[]): AppNode[] {
  return nodes.map(n => {
    if (n.type === 'pipelineStep') {
      const d = n.data as Record<string, any>
      if (d.skillMode) {
        return {
          ...n,
          type: 'skillStep' as const,
          data: {
            name: d.name ?? '',
            taskDescription: d.batch ?? '',
            workingDir: d.workingDir ?? '',
            outputPath: d.outputPath ?? '',
            expectedOutput: d.expect ?? '',
            readonly: d.readonly ?? false,
            skill: d.skill ?? '',
            timeout: d.timeout ?? 300,
            retry: d.retry ?? 0,
            index: d.index ?? 0,
            status: 'idle' as const,
            errorMsg: '',
          },
        }
      }
      return { ...n, type: 'scriptStep' as const }
    }
    // humanConfirmation 節點不需遷移，直接保留
    return n
  })
}

function apiToWorkflow(d: WorkflowData): Workflow {
  return {
    id: d.id,
    name: d.name,
    nodes: migrateNodes((d.canvas?.nodes ?? []) as AppNode[]),
    edges: (d.canvas?.edges ?? []) as Edge[],
    validate: d.validate,
    updatedAt: d.updated_at * 1000,  // backend uses seconds, frontend uses ms
  }
}

// ── Store ────────────────────────────────────────────────────────────────────
interface WorkflowStore {
  workflows: Workflow[]
  activeId:  string | null
  loaded:    boolean         // 是否已從 API 載入

  // CRUD (all async, hit backend API)
  fetchWorkflows: () => Promise<void>
  createWorkflow: (name?: string) => Promise<string>   // returns new id
  updateWorkflow: (id: string, patch: Partial<Omit<Workflow, 'id'>>) => void
  removeWorkflow: (id: string) => Promise<void>
  setActive:      (id: string) => void
  getActive:      () => Workflow | undefined

  // 儲存目前畫布狀態（debounced by caller）
  saveCanvas: (id: string, nodes: AppNode[], edges: Edge[]) => void
}

// 防抖佇列：合併多次快速 saveCanvas / updateWorkflow 呼叫
const _pendingUpdates = new Map<string, { timer: ReturnType<typeof setTimeout>; patch: Record<string, any> }>()

function _debouncedApiUpdate(id: string, patch: Record<string, any>) {
  const existing = _pendingUpdates.get(id)
  if (existing) {
    clearTimeout(existing.timer)
    Object.assign(existing.patch, patch)
  } else {
    _pendingUpdates.set(id, { timer: 0 as any, patch: { ...patch } })
  }
  const entry = _pendingUpdates.get(id)!
  entry.timer = setTimeout(async () => {
    _pendingUpdates.delete(id)
    try {
      await updateWorkflowApi(id, entry.patch)
    } catch {
      // 靜默失敗 — 本地狀態已更新，下次 fetchWorkflows 會同步
    }
  }, 500)
}

export const useWorkflowStore = create<WorkflowStore>()(
  (set, get) => ({
    workflows: [],
    activeId:  null,
    loaded:    false,

    fetchWorkflows: async () => {
      try {
        const data = await listWorkflows()
        const workflows = data.map(apiToWorkflow)
        const { activeId } = get()
        const active = activeId && workflows.find(w => w.id === activeId)
          ? activeId
          : (workflows[0]?.id ?? null)
        set({ workflows, activeId: active, loaded: true })
      } catch {
        set({ loaded: true })
      }
    },

    createWorkflow: async (name) => {
      const data = await createWorkflowApi(name ?? '新工作流')
      const wf = apiToWorkflow(data)
      set(s => ({ workflows: [...s.workflows, wf], activeId: wf.id }))
      return wf.id
    },

    updateWorkflow: (id, patch) => {
      // 立即更新本地狀態
      set(s => ({
        workflows: s.workflows.map(w =>
          w.id === id ? { ...w, ...patch, updatedAt: Date.now() } : w
        ),
      }))
      // 異步 debounced 更新後端
      const apiPatch: Record<string, any> = {}
      if (patch.name !== undefined) apiPatch.name = patch.name
      if (patch.validate !== undefined) apiPatch.validate = patch.validate
      if (Object.keys(apiPatch).length > 0) {
        _debouncedApiUpdate(id, apiPatch)
      }
    },

    removeWorkflow: async (id) => {
      set(s => {
        const ws = s.workflows.filter(w => w.id !== id)
        const activeId = s.activeId === id ? (ws[ws.length - 1]?.id ?? null) : s.activeId
        return { workflows: ws, activeId }
      })
      try {
        await deleteWorkflowApi(id)
      } catch {
        // 靜默
      }
    },

    setActive: (id) => set({ activeId: id }),

    getActive: () => {
      const { workflows, activeId } = get()
      return workflows.find(w => w.id === activeId)
    },

    saveCanvas: (id, nodes, edges) => {
      // 立即更新本地狀態
      set(s => ({
        workflows: s.workflows.map(w =>
          w.id === id ? { ...w, nodes, edges, updatedAt: Date.now() } : w
        ),
      }))
      // 異步 debounced 更新後端
      _debouncedApiUpdate(id, { canvas: { nodes, edges } })
    },
  })
)

