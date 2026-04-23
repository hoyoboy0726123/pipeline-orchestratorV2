import type { Node, Edge } from '@xyflow/react'

// ── 資料型別 ─────────────────────────────────────────────────────────────────

/** 腳本節點：執行用戶寫好的腳本或指令 */
export interface StepData extends Record<string, unknown> {
  name: string
  batch: string
  workingDir: string
  outputPath: string
  expect: string
  skillMode?: boolean   // optional — 僅在 YAML 序列化時使用，節點類型由 node.type 決定
  readonly?: boolean    // optional — skill 唯讀驗證模式
  skill?: string        // optional — 掛載的 Claude Code skill 名稱
  askMode?: boolean     // optional — 詢問模式（LLM 積極問使用者）
  humanConfirm?: boolean           // optional — 人工確認步驟
  humanConfirmMessage?: string     // optional — 確認訊息
  humanConfirmNotifyTelegram?: boolean  // optional — 是否 Telegram 通知
  humanConfirmScreenshot?: boolean     // optional — 是否自動截圖
  // 桌面自動化節點（computer_use）
  computerUse?: boolean                  // optional — 桌面自動化步驟
  computerUseActions?: ComputerUseAction[]  // optional — 動作序列
  computerUseAssetsDir?: string          // optional — 錨點圖片資料夾
  computerUseFailFast?: boolean          // optional — 遇錯立即中止
  cvThreshold?: number                   // CV 比對門檻：0.65 / 0.80 / 0.90
  cvSearchOnlyNear?: boolean             // true = 只搜錄製座標附近
  cvSearchRadius?: number                // 附近搜尋半徑（px），預設 400
  cvTriggerHover?: boolean               // true = 比對前先觸發 hover 效果（匹配錄製時的 hover 狀態）
  cvHoverWaitMs?: number                 // hover 等待時間（ms）：200 或 400
  cvCoordFallback?: boolean              // true = CV 失敗時退回錄製座標硬點
  timeout: number
  retry: number
  index: number
  status: 'idle' | 'running' | 'success' | 'failed'
  errorMsg: string
}

/** 技能節點：LLM 自動撰寫並執行程式碼 */
export interface SkillData extends Record<string, unknown> {
  name: string
  taskDescription: string
  workingDir: string
  outputPath: string
  expectedOutput: string
  readonly: boolean
  skill: string         // 掛載的 Claude Code skill 名稱（空字串 = 不掛載）
  askMode: boolean      // 詢問模式：LLM 遇到任何不確定就主動 ask_user 問用戶
  timeout: number
  retry: number
  index: number
  status: 'idle' | 'running' | 'success' | 'failed'
  errorMsg: string
}

/** AI 驗證節點：輕量 LLM 快速驗證前一步輸出 */
export interface AiValidationData extends Record<string, unknown> {
  expectText: string
  targetPath: string
  skillMode: boolean   // 保留：控制驗證時是否可執行程式碼
  index: number
}

/** 人工確認節點：暫停 Pipeline 等待人為確認 */
export interface HumanConfirmData extends Record<string, unknown> {
  name: string
  message: string          // 自訂確認訊息
  notifyTelegram: boolean  // 是否透過 Telegram 通知
  screenshot: boolean      // 是否自動截圖並傳送到 Telegram
  timeout: number          // 等待超時（秒）
  index: number
  status: 'idle' | 'running' | 'success' | 'failed'
  errorMsg: string
}

// 桌面自動化動作（對應 backend ComputerUseAction）
export interface ComputerUseAction {
  type: 'click_image' | 'click_at' | 'type_text' | 'hotkey' | 'wait' | 'wait_image' | 'screenshot' | 'scroll' | 'drag'
  image?: string
  image2?: string        // 次錨點（多錨點驗證）
  dx2?: number           // 次錨點相對點擊點的 X 位移
  dy2?: number           // 次錨點相對點擊點的 Y 位移
  x?: number
  y?: number
  x2?: number
  y2?: number
  dy?: number
  text?: string
  keys?: string[]
  seconds?: number
  timeout_sec?: number
  confidence?: number
  button?: 'left' | 'right' | 'middle'
  clicks?: number
  description?: string
  use_coord?: boolean   // 勾起 = 強制用絕對座標，跳過圖像比對
  hold_sec?: number     // click 長按時間（>0 時回放走 mouseDown→sleep→mouseUp）
  modifiers?: string[]  // click 時按著的修飾鍵（如 ["ctrl"]、["ctrl","shift"]）
  use_ocr?: boolean     // click_image 顯式 OCR 啟用（勾選才跑 OCR，避免 silent 填字但沒觸發）
  ocr_text?: string     // OCR 目標文字（跟 use_ocr=true 搭配才生效）
  anchor_off_x?: number // 點擊相對錨點影像中心的偏移 x
  anchor_off_y?: number // 點擊相對錨點影像中心的偏移 y
  full_image?: string   // 全螢幕截圖檔名（手動圈選編輯錨點時用）
  full_left?: number    // 全螢幕截圖對應的虛擬桌面原點 X（可能是負值）
  full_top?: number     // 全螢幕截圖對應的虛擬桌面原點 Y
}

export interface ComputerUseData extends Record<string, unknown> {
  name: string
  actions: ComputerUseAction[]
  assetsDir: string         // 錨點圖片資料夾（相對工作流）
  failFast: boolean         // 遇錯立即中止
  cvThreshold: number       // CV 比對門檻：0.65 寬鬆 / 0.80 標準 / 0.90 嚴格
  cvSearchOnlyNear: boolean // true = 只搜錄製座標附近（找不到直接 FAIL）
  cvSearchRadius: number    // 附近搜尋半徑（px），預設 400
  cvTriggerHover: boolean   // true = 比對前先 moveTo 錄製座標觸發 hover
  cvHoverWaitMs: number     // hover 等待 ms：200（快）/ 400（保險）
  cvCoordFallback: boolean  // true = CV 失敗時退回錄製座標硬點（跟 only_near 獨立）
  timeout: number           // 秒（執行上限）
  retry: number
  index: number
  status: 'idle' | 'running' | 'success' | 'failed'
  errorMsg: string
}

export type ScriptNode = Node<StepData>
export type SkillNode = Node<SkillData>
export type AiValidationNode = Node<AiValidationData>
export type HumanConfirmNode = Node<HumanConfirmData>
export type ComputerUseNode = Node<ComputerUseData>
export type AppNode = Node<StepData | AiValidationData | SkillData | HumanConfirmData | ComputerUseData>

export function newAiValidationData(index = 0): AiValidationData {
  return { expectText: '', targetPath: '', skillMode: false, index }
}

let _confirmCounter = 0
export function newHumanConfirmData(index = 0): HumanConfirmData {
  _confirmCounter++
  return {
    name: `人工確認 ${_confirmCounter}`,
    message: '',
    notifyTelegram: true,
    screenshot: false,
    timeout: 3600,
    index,
    status: 'idle',
    errorMsg: '',
  }
}

let _computerUseCounter = 0
export function newComputerUseData(index = 0): ComputerUseData {
  _computerUseCounter++
  return {
    name: `桌面自動化 ${_computerUseCounter}`,
    actions: [],
    assetsDir: '',
    failFast: true,
    cvThreshold: 0.65,
    cvSearchOnlyNear: false,
    cvSearchRadius: 400,
    cvTriggerHover: true,
    cvHoverWaitMs: 200,
    cvCoordFallback: true,
    timeout: 300,
    retry: 0,
    index,
    status: 'idle',
    errorMsg: '',
  }
}

let _counter = 0
export function newStepData(index = 0): StepData {
  _counter++
  return {
    name: `Python腳本 ${_counter}`,
    batch: '',
    workingDir: '',
    outputPath: '',
    expect: '',
    timeout: 300,
    retry: 0,
    index,
    status: 'idle',
    errorMsg: '',
  }
}

let _skillCounter = 0
export function newSkillData(index = 0): SkillData {
  _skillCounter++
  return {
    name: `AI技能 ${_skillCounter}`,
    taskDescription: '',
    workingDir: '',
    outputPath: '',
    expectedOutput: '',
    readonly: false,
    skill: '',
    askMode: false,
    timeout: 300,
    retry: 0,
    index,
    status: 'idle',
    errorMsg: '',
  }
}

// ── 節點顏色（依 index 循環）──────────────────────────────────────────────────
const COLORS = ['#6366f1','#0ea5e9','#10b981','#f59e0b','#ec4899','#8b5cf6','#14b8a6','#f97316']
export const stepColor = (index: number) => COLORS[index % COLORS.length]

// ── Steps → ReactFlow nodes + edges ──────────────────────────────────────────
export function stepsToFlow(steps: StepData[]): { nodes: AppNode[]; edges: Edge[] } {
  const nodes: AppNode[] = steps.map((s, i) => {
    if (s.computerUse) {
      return {
        id: `step-${i}`,
        type: 'computerUse' as const,
        position: { x: i * 320, y: 160 },
        data: {
          name: s.name,
          actions: s.computerUseActions || [],
          assetsDir: s.computerUseAssetsDir || '',
          failFast: s.computerUseFailFast ?? true,
          cvThreshold: s.cvThreshold ?? 0.65,
          cvSearchOnlyNear: s.cvSearchOnlyNear ?? false,
          cvSearchRadius: s.cvSearchRadius ?? 400,
          cvTriggerHover: s.cvTriggerHover ?? true,
          cvHoverWaitMs: s.cvHoverWaitMs ?? 200,
          cvCoordFallback: s.cvCoordFallback ?? true,
          timeout: s.timeout,
          retry: s.retry,
          index: i,
          status: 'idle' as const,
          errorMsg: '',
        } as ComputerUseData,
      }
    }
    if (s.humanConfirm) {
      return {
        id: `step-${i}`,
        type: 'humanConfirmation' as const,
        position: { x: i * 320, y: 160 },
        data: {
          name: s.name,
          message: s.humanConfirmMessage || '',
          notifyTelegram: s.humanConfirmNotifyTelegram ?? true,
          screenshot: s.humanConfirmScreenshot ?? false,
          timeout: s.timeout || 3600,
          index: i,
          status: 'idle' as const,
          errorMsg: '',
        } as HumanConfirmData,
      }
    }
    if (s.skillMode) {
      // 向後相容：舊格式 skillMode=true → skillStep 節點
      return {
        id: `step-${i}`,
        type: 'skillStep' as const,
        position: { x: i * 320, y: 160 },
        data: {
          name: s.name,
          taskDescription: s.batch,
          workingDir: s.workingDir,
          outputPath: s.outputPath,
          expectedOutput: s.expect,
          readonly: s.readonly || false,
          skill: s.skill || '',
          askMode: s.askMode || false,
          timeout: s.timeout,
          retry: s.retry,
          index: i,
          status: 'idle' as const,
          errorMsg: '',
        } as SkillData,
      }
    }
    return {
      id: `step-${i}`,
      type: 'scriptStep' as const,
      position: { x: i * 320, y: 160 },
      data: { ...s, index: i, skillMode: undefined },
    }
  })

  const edges: Edge[] = steps.slice(0, -1).map((_, i) => ({
    id: `e-${i}`,
    source: `step-${i}`,
    target: `step-${i + 1}`,
    type: 'smoothstep',
    animated: steps[i].status === 'running',
    style: { stroke: stepColor(i), strokeWidth: 2 },
  }))

  return { nodes, edges }
}

// ── ReactFlow nodes → ordered steps（只包含有邊連接的節點）──────────────────────
export function flowToSteps(nodes: AppNode[], edges: Edge[]): StepData[] {
  // 收集 AI 驗證節點，建立 predecessor → aiData 映射
  const aiNodeIds = new Set<string>()
  const aiDataByPredecessor = new Map<string, AiValidationData>()

  for (const n of nodes) {
    if (n.type === 'aiValidation') {
      aiNodeIds.add(n.id)
      const inEdge = edges.find(e => e.target === n.id)
      if (inEdge) aiDataByPredecessor.set(inEdge.source, n.data as AiValidationData)
    }
  }

  // 過濾出可執行節點（scriptStep + skillStep + humanConfirmation + computerUse）
  const execNodeIds = new Set<string>()
  const execNodes: AppNode[] = []
  for (const n of nodes) {
    if (n.type === 'scriptStep' || n.type === 'skillStep' || n.type === 'humanConfirmation' || n.type === 'computerUse') {
      execNodeIds.add(n.id)
      execNodes.push(n)
    }
  }
  if (execNodes.length === 0) return []

  // 建立虛擬邊（跳過 AI 驗證節點）
  const virtualEdges: Edge[] = []
  for (const e of edges) {
    if (aiNodeIds.has(e.source)) continue
    if (aiNodeIds.has(e.target)) {
      const aiOutEdge = edges.find(e2 => e2.source === e.target)
      if (aiOutEdge && execNodeIds.has(aiOutEdge.target)) {
        virtualEdges.push({ ...e, target: aiOutEdge.target, id: `v-${e.id}` })
      }
      continue
    }
    if (execNodeIds.has(e.source) && execNodeIds.has(e.target)) {
      virtualEdges.push(e)
    }
  }

  // 找起點（無入邊的節點）
  const hasIncoming = new Set(virtualEdges.map(e => e.target))
  const starts = execNodes.filter(n => !hasIncoming.has(n.id))
  if (!starts.length) return []

  // 沿邊走，只收集有連接的節點
  const adj = new Map<string, string>()
  virtualEdges.forEach(e => adj.set(e.source, e.target))

  const ordered: AppNode[] = []
  const visited = new Set<string>()
  let cur: string | undefined = starts[0].id
  while (cur && !visited.has(cur)) {
    visited.add(cur)
    const node = execNodes.find(n => n.id === cur)
    if (node) ordered.push(node)
    cur = adj.get(cur)
  }

  // 孤立節點不加入（邊驅動執行）

  return ordered.map((n, i) => {
    const aiData = aiDataByPredecessor.get(n.id)

    if (n.type === 'computerUse') {
      const d = n.data as ComputerUseData
      return {
        name: d.name,
        batch: '',
        workingDir: '',
        outputPath: '',
        expect: '',
        computerUse: true,
        computerUseActions: d.actions,
        computerUseAssetsDir: d.assetsDir,
        computerUseFailFast: d.failFast,
        cvThreshold: d.cvThreshold,
        cvSearchOnlyNear: d.cvSearchOnlyNear,
        cvSearchRadius: d.cvSearchRadius,
        cvTriggerHover: d.cvTriggerHover,
        cvHoverWaitMs: d.cvHoverWaitMs,
        cvCoordFallback: d.cvCoordFallback,
        timeout: d.timeout,
        retry: d.retry,
        index: i,
        status: d.status,
        errorMsg: d.errorMsg,
      } as StepData
    }

    if (n.type === 'humanConfirmation') {
      const d = n.data as HumanConfirmData
      return {
        name: d.name,
        batch: '',
        workingDir: '',
        outputPath: '',
        expect: '',
        humanConfirm: true,
        humanConfirmMessage: d.message,
        humanConfirmNotifyTelegram: d.notifyTelegram,
        humanConfirmScreenshot: d.screenshot,
        timeout: d.timeout,
        retry: 0,
        index: i,
        status: d.status,
        errorMsg: d.errorMsg,
      } as StepData
    }

    if (n.type === 'skillStep') {
      const d = n.data as SkillData
      return {
        name: d.name,
        batch: d.taskDescription,
        workingDir: d.workingDir || '',
        outputPath: d.outputPath,
        expect: aiData?.expectText || d.expectedOutput,
        skillMode: true,
        readonly: d.readonly || false,
        skill: d.skill || '',
        askMode: d.askMode || false,
        timeout: d.timeout,
        retry: d.retry,
        index: i,
        status: d.status,
        errorMsg: d.errorMsg,
      } as StepData
    }

    const d = n.data as StepData
    return {
      name: d.name,
      batch: d.batch,
      workingDir: d.workingDir || '',
      outputPath: (aiData?.targetPath && !d.outputPath) ? aiData.targetPath : d.outputPath,
      expect: aiData?.expectText || d.expect,
      skillMode: aiData?.skillMode || false,
      timeout: d.timeout,
      retry: d.retry,
      index: i,
      status: d.status,
      errorMsg: d.errorMsg,
    } as StepData
  })
}

// ── Steps → YAML string ───────────────────────────────────────────────────────
export function stepsToYaml(name: string, steps: StepData[]): string {
  // 自動判斷 validate：有 skill 步驟或任何步驟有 expect → 啟用
  const needsValidate = steps.some(s => s.skillMode || !!s.expect)
  const lines: string[] = [
    `name: ${name || 'my-pipeline'}`,
    `validate: ${needsValidate}`,
    ``,
    `steps:`,
  ]
  for (const s of steps) {
    lines.push(`  - name: ${s.name}`)
    if (s.humanConfirm) {
      lines.push(`    human_confirm: true`)
      if (s.humanConfirmMessage) lines.push(`    message: "${s.humanConfirmMessage.replace(/"/g, '\\"')}"`)
      if (s.humanConfirmNotifyTelegram === false) lines.push(`    notify_telegram: false`)
      if (s.humanConfirmScreenshot) lines.push(`    screenshot: true`)
      if (s.timeout && s.timeout !== 3600) lines.push(`    timeout: ${s.timeout}`)
      continue
    }
    if (s.computerUse) {
      lines.push(`    computer_use: true`)
      if (s.computerUseAssetsDir) lines.push(`    assets_dir: ${s.computerUseAssetsDir}`)
      if (s.computerUseFailFast === false) lines.push(`    fail_fast: false`)
      if (s.cvThreshold !== undefined && s.cvThreshold !== 0.65) lines.push(`    cv_threshold: ${s.cvThreshold}`)
      if (s.cvSearchOnlyNear) lines.push(`    cv_search_only_near: true`)
      if (s.cvSearchRadius !== undefined && s.cvSearchRadius !== 400) lines.push(`    cv_search_radius: ${s.cvSearchRadius}`)
      if (s.cvTriggerHover === false) lines.push(`    cv_trigger_hover: false`)
      if (s.cvHoverWaitMs !== undefined && s.cvHoverWaitMs !== 200) lines.push(`    cv_hover_wait_ms: ${s.cvHoverWaitMs}`)
      if (s.cvCoordFallback === false) lines.push(`    cv_coord_fallback: false`)
      if (s.computerUseActions && s.computerUseActions.length > 0) {
        // 以 JSON 陣列寫入 actions（一行一動作，夠精簡又能 yaml parse）
        lines.push(`    actions:`)
        for (const a of s.computerUseActions) {
          // 用 flow 寫法把每個 action 壓成一行 JSON
          const compact = JSON.stringify(a)
          lines.push(`      - ${compact}`)
        }
      }
      if (s.timeout !== 300) lines.push(`    timeout: ${s.timeout}`)
      // computer_use 一定寫 retry（即使是 0），因為 backend PipelineStep 預設 retry=1
      // 對 UI 自動化來說 retry 從動作 #1 重跑會重複點擊造成副作用，所以預期是 retry=0
      lines.push(`    retry: ${s.retry ?? 0}`)
      continue
    }
    if (s.workingDir) lines.push(`    working_dir: ${s.workingDir}`)
    if (s.batch) {
      if (s.batch.includes('\n') || s.batch.length > 80) {
        lines.push(`    batch: |`)
        for (const bl of s.batch.split('\n')) {
          lines.push(`      ${bl}`)
        }
      } else {
        lines.push(`    batch: ${s.batch}`)
      }
    }
    if (s.skillMode) lines.push(`    skill_mode: true`)
    if (s.skill) lines.push(`    skill: ${s.skill}`)
    if (s.readonly) lines.push(`    readonly: true`)
    if (s.askMode) lines.push(`    ask_mode: true`)
    if (s.outputPath || s.expect) {
      lines.push(`    output:`)
      if (s.outputPath) lines.push(`      path: ${s.outputPath}`)
      if (s.expect) {
        lines.push(`      ai_validation: true`)
        if (s.expect.includes('\n') || s.expect.length > 80) {
          lines.push(`      description: |`)
          for (const dl of s.expect.split('\n')) {
            lines.push(`        ${dl}`)
          }
        } else {
          lines.push(`      description: "${s.expect.replace(/"/g, '\\"')}"`)
        }
      }
      if (s.skillMode) lines.push(`      skill_mode: true`)
    }
    if (s.timeout !== 300) lines.push(`    timeout: ${s.timeout}`)
    if (s.retry > 0)       lines.push(`    retry: ${s.retry}`)
  }
  return lines.join('\n')
}

// ── YAML string → steps ───────────────────────────────────────────────────────
export function parseYaml(raw: string): { name: string; validate: boolean; steps: StepData[] } | null {
  try {
    const lines = raw.split('\n')
    let stepIndent = 2
    for (const line of lines) {
      const m = line.match(/^(\s*)- name:/)
      if (m) { stepIndent = m[1].length; break }
    }

    let name = 'my-pipeline'
    let validate = false
    const steps: StepData[] = []
    let cur: Partial<StepData> | null = null
    let inOutput = false
    let multilineTarget: 'batch' | 'expect' | null = null
    let multilineIndent = 0
    let multilineLines: string[] = []

    const flushMultiline = () => {
      if (multilineTarget && cur && multilineLines.length > 0) {
        const text = multilineLines.join('\n').replace(/\n+$/, '')
        if (multilineTarget === 'batch') cur.batch = text
        else cur.expect = text
      }
      multilineTarget = null
      multilineLines = []
      multilineIndent = 0
    }

    for (let li = 0; li < lines.length; li++) {
      const line = lines[li]
      const t = line.trim()

      if (multilineTarget) {
        if (t === '') { multilineLines.push(''); continue }
        const leadingSpaces = line.match(/^(\s*)/)?.[1].length ?? 0
        if (leadingSpaces >= multilineIndent) {
          multilineLines.push(line.slice(multilineIndent))
          continue
        }
        flushMultiline()
      }

      if (!t || t.startsWith('#') || t === 'pipeline:' || t === 'steps:') continue

      if (/^name:/.test(t) && !cur) {
        name = t.replace(/^name:\s*/, '')
      } else if (/^validate:/.test(t) && !cur) {
        validate = /true/.test(t)
      } else if (/^- name:/.test(t)) {
        flushMultiline()
        if (cur) steps.push(buildStep(cur, steps.length))
        cur = { name: t.replace(/^-\s*name:\s*/, '') }
        inOutput = false
      } else if (/^working_dir:/.test(t) && cur) {
        cur.workingDir = t.replace(/^working_dir:\s*/, '')
        inOutput = false
      } else if (/^batch:/.test(t) && cur) {
        const val = t.replace(/^batch:\s*/, '')
        if (val === '|' || val === '>') {
          multilineTarget = 'batch'
          const nextLine = lines[li + 1]
          multilineIndent = nextLine ? (nextLine.match(/^(\s*)/)?.[1].length ?? 0) : 0
        } else {
          cur.batch = val
        }
        inOutput = false
      } else if (/^output:/.test(t) && cur) {
        inOutput = true
      } else if (/^path:/.test(t) && cur && inOutput) {
        cur.outputPath = t.replace(/^path:\s*/, '')
      } else if (/^(expect|description):/.test(t) && cur && inOutput) {
        const val = t.replace(/^(expect|description):\s*/, '').replace(/^"|"$/g, '')
        if (val === '|' || val === '>') {
          multilineTarget = 'expect'
          const nextLine = lines[li + 1]
          multilineIndent = nextLine ? (nextLine.match(/^(\s*)/)?.[1].length ?? 0) : 0
        } else {
          cur.expect = val
        }
      } else if (/^ai_validation:/.test(t) && cur && inOutput) {
        if (/true/.test(t)) validate = true
      } else if (/^skill_mode:/.test(t) && cur) {
        cur.skillMode = /true/.test(t)
      } else if (/^skill:/.test(t) && cur) {
        cur.skill = t.replace(/^skill:\s*/, '').replace(/^"|"$/g, '')
      } else if (/^readonly:/.test(t) && cur) {
        cur.readonly = /true/.test(t)
      } else if (/^ask_mode:/.test(t) && cur) {
        cur.askMode = /true/.test(t)
      } else if (/^human_confirm:/.test(t) && cur) {
        cur.humanConfirm = /true/.test(t)
      } else if (/^message:/.test(t) && cur) {
        cur.humanConfirmMessage = t.replace(/^message:\s*/, '').replace(/^"|"$/g, '')
      } else if (/^notify_telegram:/.test(t) && cur) {
        cur.humanConfirmNotifyTelegram = /true/.test(t)
      } else if (/^screenshot:/.test(t) && cur) {
        cur.humanConfirmScreenshot = /true/.test(t)
      } else if (/^timeout:/.test(t) && cur) {
        cur.timeout = parseInt(t.replace(/^timeout:\s*/, '')) || 300
        inOutput = false
      } else if (/^retry:/.test(t) && cur) {
        cur.retry = parseInt(t.replace(/^retry:\s*/, '')) || 0
        inOutput = false
      } else if (cur && t && !t.startsWith('-')) {
        // 不匹配任何 key 的行 → 追加到 batch（處理長文字被換行的情況）
        if (cur.batch && !inOutput) {
          cur.batch += ' ' + t
        } else if (cur.expect && inOutput) {
          cur.expect += ' ' + t
        }
      }
    }
    flushMultiline()
    if (cur) steps.push(buildStep(cur, steps.length))
    return { name, validate, steps }
  } catch { return null }
}

function buildStep(partial: Partial<StepData>, index: number): StepData {
  return {
    name: partial.name ?? `步驟 ${index + 1}`,
    batch: partial.batch ?? '',
    workingDir: partial.workingDir ?? '',
    outputPath: partial.outputPath ?? '',
    expect: partial.expect ?? '',
    skillMode: partial.skillMode ?? false,
    readonly: partial.readonly ?? false,
    skill: partial.skill ?? '',
    humanConfirm: partial.humanConfirm ?? false,
    humanConfirmMessage: partial.humanConfirmMessage ?? '',
    humanConfirmNotifyTelegram: partial.humanConfirmNotifyTelegram ?? true,
    humanConfirmScreenshot: partial.humanConfirmScreenshot ?? false,
    timeout: partial.timeout ?? (partial.humanConfirm ? 3600 : 300),
    retry: partial.retry ?? 0,
    index,
    status: 'idle',
    errorMsg: '',
  }
}
