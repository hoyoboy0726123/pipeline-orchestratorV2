import { create } from 'zustand'
import type { AgentMode } from './types'

interface ChatStore {
  pendingTask: string | null
  pendingMode: AgentMode
  setPending: (task: string, mode: AgentMode) => void
  clearPending: () => void
}

export const useChatStore = create<ChatStore>((set) => ({
  pendingTask: null,
  pendingMode: 'auto',
  setPending: (task, mode) => set({ pendingTask: task, pendingMode: mode }),
  clearPending: () => set({ pendingTask: null, pendingMode: 'auto' }),
}))
