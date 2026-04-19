/**
 * 輕量 Zustand store：追蹤 pipeline 執行時的步驟狀態。
 * 與 ReactFlow nodes 完全分離，避免 setNodes 觸發 ForwardRef 渲染衝突。
 */
import { create } from 'zustand'

export interface StepStatus {
  status: 'idle' | 'running' | 'success' | 'failed'
  errorMsg: string
}

interface RunStatusStore {
  /** key = step name, value = runtime status */
  stepStatuses: Record<string, StepStatus>
  edgesAnimated: boolean
  /** key = step name, true = has active recipe */
  recipeSteps: Record<string, boolean>

  setStepStatus: (name: string, s: StepStatus) => void
  setBulkStatus: (map: Record<string, StepStatus>) => void
  setEdgesAnimated: (v: boolean) => void
  setRecipeSteps: (map: Record<string, boolean>) => void
  resetAll: () => void
}

export const useRunStatusStore = create<RunStatusStore>((set) => ({
  stepStatuses: {},
  edgesAnimated: false,
  recipeSteps: {},

  setStepStatus: (name, s) =>
    set((state) => ({
      stepStatuses: { ...state.stepStatuses, [name]: s },
    })),

  setBulkStatus: (map) => set({ stepStatuses: map }),

  setEdgesAnimated: (v) => set({ edgesAnimated: v }),

  setRecipeSteps: (map) => set({ recipeSteps: map }),

  resetAll: () => set({ stepStatuses: {}, edgesAnimated: false }),
}))
