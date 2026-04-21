'use client'
import { useEffect, useRef, useState } from 'react'
import { X, Check, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
import type { ComputerUseAction } from './_helpers'
import { computerUseAssetImageUrl, cropAnchorFromFull } from '@/lib/api'

interface Props {
  action: ComputerUseAction
  actionIndex: number
  assetsDir: string
  onApply: (patch: Partial<ComputerUseAction>) => void
  onClose: () => void
}

/**
 * 手動圈選錨點 Modal。
 * 顯示錄製當下的全螢幕截圖、點擊位置的紅十字、可拖曳的綠色裁切框。
 * 使用者按確認 → 呼叫後端裁出新錨點並更新 action。
 */
export default function AnchorEditorModal({ action, actionIndex, assetsDir, onApply, onClose }: Props) {
  // 目前僅支援有 full_image 的 action（新錄製才有）
  const fullImg = action.full_image || ''
  const fullLeft = action.full_left || 0
  const fullTop = action.full_top || 0

  // 點擊位置（虛擬桌面絕對座標；可拖曳紅十字調整）
  const [clickPos, setClickPos] = useState(() => ({
    x: action.x || 0,
    y: action.y || 0,
  }))

  // 裁切框（虛擬桌面絕對座標）— 預設 240×80，之後會由已存的錨點圖尺寸反推取代
  const [box, setBox] = useState(() => ({
    left: (action.x || 0) - 120,
    top: (action.y || 0) - 40,
    width: 240,
    height: 80,
  }))
  // 開 Modal 時嘗試載入目前的錨點圖，從尺寸 + anchor_off_x/y 反推上次裁切框的位置
  // 這樣第二次開啟時框位置/大小 = 上次儲存的，不會退回預設 240×80
  useEffect(() => {
    if (!action.image) return
    const img = new Image()
    img.onload = () => {
      const W = img.naturalWidth
      const H = img.naturalHeight
      const ax = action.anchor_off_x || 0
      const ay = action.anchor_off_y || 0
      // click 在影像中的相對位置：click_dx = ax + W/2
      // 影像左上（虛擬桌面絕對座標） = click - click_dx
      const clickX = action.x || 0
      const clickY = action.y || 0
      const imgLeft = clickX - (ax + W / 2)
      const imgTop = clickY - (ay + H / 2)
      setBox({ left: Math.round(imgLeft), top: Math.round(imgTop), width: W, height: H })
    }
    img.onerror = () => {/* ignore — 用預設框 */}
    img.src = computerUseAssetImageUrl(assetsDir, action.image)
  }, [action.image, action.anchor_off_x, action.anchor_off_y, action.x, action.y, assetsDir])

  // Canvas / 圖片
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const [imgLoaded, setImgLoaded] = useState(false)
  const [displayScale, setDisplayScale] = useState(1)  // 縮放比（fit to viewport）
  const [preview, setPreview] = useState<string>('')

  // 拖曳狀態（新增 move-click 拖紅十字）
  const [dragMode, setDragMode] = useState<'none' | 'move' | 'resize-br' | 'resize-tl' | 'move-click'>('none')
  const dragRef = useRef({ startX: 0, startY: 0, boxLeft: 0, boxTop: 0, boxW: 0, boxH: 0, clickX: 0, clickY: 0 })

  // 載入 full image
  useEffect(() => {
    if (!fullImg) return
    const url = computerUseAssetImageUrl(assetsDir, fullImg)
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      imgRef.current = img
      setImgLoaded(true)
    }
    img.onerror = () => toast.error('無法載入全螢幕截圖（full_*.png）')
    img.src = url
  }, [fullImg, assetsDir])

  // 計算 fit-to-viewport 縮放（用左側容器實際尺寸）
  useEffect(() => {
    if (!imgLoaded || !imgRef.current || !containerRef.current) return
    const img = imgRef.current
    const cont = containerRef.current
    const recalc = () => {
      const viewportW = cont.clientWidth - 40   // 預留 padding
      const viewportH = cont.clientHeight - 40
      const scale = Math.min(viewportW / img.width, viewportH / img.height, 1)
      setDisplayScale(scale)
    }
    recalc()
    const ro = new ResizeObserver(recalc)
    ro.observe(cont)
    return () => ro.disconnect()
  }, [imgLoaded])

  // 重繪 Canvas
  useEffect(() => {
    const canvas = canvasRef.current
    const img = imgRef.current
    if (!canvas || !img || !imgLoaded) return
    const dispW = img.width * displayScale
    const dispH = img.height * displayScale
    canvas.width = dispW
    canvas.height = dispH
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(img, 0, 0, dispW, dispH)

    // 紅十字標點擊位置（full 圖座標 = absolute - full_left/top）
    const cx = (clickPos.x - fullLeft) * displayScale
    const cy = (clickPos.y - fullTop) * displayScale
    // 外層白色描邊讓紅十字在各種背景下都看得清楚
    ctx.strokeStyle = 'white'
    ctx.lineWidth = 5
    ctx.beginPath()
    ctx.moveTo(cx - 18, cy); ctx.lineTo(cx + 18, cy)
    ctx.moveTo(cx, cy - 18); ctx.lineTo(cx, cy + 18)
    ctx.stroke()
    ctx.strokeStyle = 'red'
    ctx.lineWidth = 2.5
    ctx.beginPath()
    ctx.moveTo(cx - 18, cy); ctx.lineTo(cx + 18, cy)
    ctx.moveTo(cx, cy - 18); ctx.lineTo(cx, cy + 18)
    ctx.stroke()
    // 中心小圓點
    ctx.fillStyle = 'red'
    ctx.beginPath(); ctx.arc(cx, cy, 4, 0, 2 * Math.PI); ctx.fill()
    ctx.strokeStyle = 'white'
    ctx.lineWidth = 1.5
    ctx.stroke()

    // 綠色裁切框
    const bx = (box.left - fullLeft) * displayScale
    const by = (box.top - fullTop) * displayScale
    const bw = box.width * displayScale
    const bh = box.height * displayScale
    ctx.strokeStyle = '#10b981'
    ctx.lineWidth = 2
    ctx.setLineDash([6, 4])
    ctx.strokeRect(bx, by, bw, bh)
    ctx.setLineDash([])
    // 四個角的小方塊當 resize handle
    ctx.fillStyle = '#10b981'
    const hs = 8
    ctx.fillRect(bx - hs / 2, by - hs / 2, hs, hs)                   // 左上
    ctx.fillRect(bx + bw - hs / 2, by + bh - hs / 2, hs, hs)         // 右下
  }, [imgLoaded, displayScale, box, clickPos.x, clickPos.y, fullLeft, fullTop])

  // 更新右側預覽
  useEffect(() => {
    const img = imgRef.current
    if (!img || !imgLoaded) return
    const pCanvas = document.createElement('canvas')
    pCanvas.width = box.width
    pCanvas.height = box.height
    const ctx = pCanvas.getContext('2d')!
    const sx = box.left - fullLeft
    const sy = box.top - fullTop
    ctx.drawImage(img, sx, sy, box.width, box.height, 0, 0, box.width, box.height)
    setPreview(pCanvas.toDataURL('image/png'))
  }, [imgLoaded, box, fullLeft, fullTop])

  // 計算 variance（簡單版：RGB 標準差）
  const [variance, setVariance] = useState(0)
  useEffect(() => {
    const img = imgRef.current
    if (!img || !imgLoaded) return
    const tCanvas = document.createElement('canvas')
    tCanvas.width = Math.min(box.width, 100)
    tCanvas.height = Math.min(box.height, 100)
    const ctx = tCanvas.getContext('2d')!
    const sx = box.left - fullLeft
    const sy = box.top - fullTop
    ctx.drawImage(img, sx, sy, box.width, box.height, 0, 0, tCanvas.width, tCanvas.height)
    const data = ctx.getImageData(0, 0, tCanvas.width, tCanvas.height).data
    let sum = 0, sumSq = 0, n = 0
    for (let i = 0; i < data.length; i += 4) {
      const gray = (data[i] + data[i + 1] + data[i + 2]) / 3
      sum += gray; sumSq += gray * gray; n++
    }
    const mean = sum / n
    const v = sumSq / n - mean * mean
    setVariance(Math.round(v))
  }, [imgLoaded, box, fullLeft, fullTop])

  // 滑鼠事件處理（Canvas 相對座標 → full 圖座標）
  const canvasToFull = (cx: number, cy: number) => ({
    x: cx / displayScale + fullLeft,
    y: cy / displayScale + fullTop,
  })

  const onMouseDown = (e: React.MouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect()
    const cx = e.clientX - rect.left
    const cy = e.clientY - rect.top
    // 紅十字優先判斷（在綠框內但靠近紅十字時優先拖紅十字）
    const crossX = (clickPos.x - fullLeft) * displayScale
    const crossY = (clickPos.y - fullTop) * displayScale
    const nearCross = Math.abs(cx - crossX) < 12 && Math.abs(cy - crossY) < 12
    // 在哪個 handle 上？
    const bx = (box.left - fullLeft) * displayScale
    const by = (box.top - fullTop) * displayScale
    const bw = box.width * displayScale
    const bh = box.height * displayScale
    const nearTL = Math.abs(cx - bx) < 10 && Math.abs(cy - by) < 10
    const nearBR = Math.abs(cx - (bx + bw)) < 10 && Math.abs(cy - (by + bh)) < 10
    const inside = cx >= bx && cx <= bx + bw && cy >= by && cy <= by + bh
    let mode: typeof dragMode = 'none'
    if (nearCross) mode = 'move-click'
    else if (nearTL) mode = 'resize-tl'
    else if (nearBR) mode = 'resize-br'
    else if (inside) mode = 'move'
    if (mode === 'none') return
    setDragMode(mode)
    dragRef.current = {
      startX: cx, startY: cy,
      boxLeft: box.left, boxTop: box.top, boxW: box.width, boxH: box.height,
      clickX: clickPos.x, clickY: clickPos.y,
    }
    e.preventDefault()
  }

  const onMouseMove = (e: React.MouseEvent) => {
    if (dragMode === 'none') return
    const rect = canvasRef.current!.getBoundingClientRect()
    const cx = e.clientX - rect.left
    const cy = e.clientY - rect.top
    const dx = (cx - dragRef.current.startX) / displayScale
    const dy = (cy - dragRef.current.startY) / displayScale
    if (dragMode === 'move-click') {
      setClickPos({
        x: Math.round(dragRef.current.clickX + dx),
        y: Math.round(dragRef.current.clickY + dy),
      })
    } else if (dragMode === 'move') {
      setBox(b => ({ ...b, left: dragRef.current.boxLeft + Math.round(dx), top: dragRef.current.boxTop + Math.round(dy) }))
    } else if (dragMode === 'resize-br') {
      setBox(b => ({
        ...b,
        width: Math.max(20, dragRef.current.boxW + Math.round(dx)),
        height: Math.max(20, dragRef.current.boxH + Math.round(dy)),
      }))
    } else if (dragMode === 'resize-tl') {
      setBox(b => ({
        left: dragRef.current.boxLeft + Math.round(dx),
        top: dragRef.current.boxTop + Math.round(dy),
        width: Math.max(20, dragRef.current.boxW - Math.round(dx)),
        height: Math.max(20, dragRef.current.boxH - Math.round(dy)),
      }))
    }
  }

  const onMouseUp = () => setDragMode('none')

  // 確認：呼叫後端裁切
  const handleConfirm = async () => {
    try {
      const saveAs = `img_${String(actionIndex + 1).padStart(3, '0')}_manual.png`
      const res = await cropAnchorFromFull({
        dir: assetsDir,
        full_image: fullImg,
        click_x: clickPos.x,
        click_y: clickPos.y,
        full_left: fullLeft,
        full_top: fullTop,
        crop_left: box.left,
        crop_top: box.top,
        crop_width: box.width,
        crop_height: box.height,
        save_as: saveAs,
      })
      onApply({
        image: res.image,
        anchor_off_x: res.anchor_off_x,
        anchor_off_y: res.anchor_off_y,
        x: clickPos.x,       // 點擊座標（可能被拖曳調整過）
        y: clickPos.y,
        // 編輯錨點的意義就是「要用圖像比對」→ 自動切到圖像模式（use_coord=false）
        // 不然系統還是走座標模式，永遠點原座標、錨點完全沒用到
        use_coord: false,
      })
      toast.success(`錨點已更新（${res.width}×${res.height}, variance=${res.variance}）`)
      onClose()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  // 重置：回到預設 240×80 以點擊點為中心
  const handleReset = () => {
    setBox({ left: clickPos.x - 120, top: clickPos.y - 40, width: 240, height: 80 })
  }

  if (!fullImg) {
    return (
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
        <div className="bg-white rounded-xl p-6 max-w-md">
          <h3 className="text-lg font-semibold mb-2">無法編輯錨點</h3>
          <p className="text-sm text-gray-600 mb-4">
            這個動作沒有錄製時的全螢幕截圖（可能是舊版錄製的）。請重新錄製這個動作才能手動圈選錨點。
          </p>
          <button onClick={onClose} className="px-4 py-1.5 bg-gray-200 rounded-lg text-sm">關閉</button>
        </div>
      </div>
    )
  }

  // 根據錨點框大小給不同場景建議（取代原本單純的 variance 警告）
  // 小錨點 → 追蹤會移動的元素；大錨點 → 用周圍結構定位特徵少的目標
  const boxArea = box.width * box.height
  const sizeTier: 'small' | 'medium' | 'large' =
    boxArea < 10000 ? 'small' : boxArea > 30000 ? 'large' : 'medium'

  const sizeGuidance = {
    small: {
      icon: '🎯',
      title: '小錨點',
      color: 'bg-blue-50 border-blue-200 text-blue-800',
      titleColor: 'text-blue-700',
      desc: '適合追蹤會「獨立移動」的元素，例如可被拖到不同位置的 icon、可重新排序的選單項目。目標本身就是唯一特徵，找到它就點它。',
    },
    medium: {
      icon: '⚖️',
      title: '中等錨點',
      color: 'bg-gray-50 border-gray-200 text-gray-700',
      titleColor: 'text-gray-700',
      desc: '預設尺寸，適合一般按鈕、文字標籤、圖示等「目標自帶特徵」的情境。',
    },
    large: {
      icon: '🌐',
      title: '大錨點',
      color: 'bg-emerald-50 border-emerald-200 text-emerald-800',
      titleColor: 'text-emerald-700',
      desc: '適合以周圍穩定 UI 結構定位特徵稀少的目標。例如 Excel 空白儲存格 → 納入列號/欄字母；空白對話框區域 → 納入周圍邊框或標題列。',
    },
  }[sizeTier]

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-2" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-2xl flex flex-col"
        style={{ width: '96vw', height: '96vh' }}
        onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-3 border-b border-gray-100">
          <h3 className="font-semibold text-gray-800">✏️ 編輯錨點 — 動作 #{actionIndex + 1}</h3>
          <div className="flex-1" />
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X className="w-4 h-4" /></button>
        </div>

        <div className="flex flex-1 min-h-0 overflow-hidden">
          {/* 左側：Canvas */}
          <div ref={containerRef} className="flex-1 overflow-auto p-5 bg-gray-100">
            <canvas
              ref={canvasRef}
              onMouseDown={onMouseDown}
              onMouseMove={onMouseMove}
              onMouseUp={onMouseUp}
              onMouseLeave={onMouseUp}
              className="border border-gray-300 cursor-move"
              style={{ cursor: dragMode === 'move' ? 'grabbing' : 'default' }}
            />
          </div>

          {/* 右側：預覽 + 控制 */}
          <div className="w-72 border-l border-gray-200 flex flex-col p-4 space-y-3 overflow-y-auto">
            <div>
              <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">錨點預覽</div>
              {preview && (
                <img src={preview} alt="anchor preview"
                  // pixelated：禁用瀏覽器內建 bilinear 平滑，pixel-level 清晰，
                  // 對 240x80 這種小圖放大顯示時避免字邊模糊
                  style={{ imageRendering: 'pixelated' }}
                  className="border border-gray-300 bg-checkered w-full" />
              )}
              <div className="text-xs text-gray-500 mt-1 font-mono">
                {box.width} × {box.height} px
              </div>
            </div>

            <div className={`p-3 border rounded-lg ${sizeGuidance.color}`}>
              <div className={`text-sm font-bold mb-1 ${sizeGuidance.titleColor}`}>
                {sizeGuidance.icon} {sizeGuidance.title}
              </div>
              <div className="text-xs leading-relaxed">{sizeGuidance.desc}</div>
              <div className="text-[11px] text-gray-500 mt-2 pt-2 border-t border-current opacity-60 font-mono">
                面積 {boxArea.toLocaleString()} px² · variance {variance}
              </div>
            </div>

            <div className="p-2 bg-gray-50 rounded-lg text-xs text-gray-600 space-y-1">
              <div>🎯 紅色十字 = 點擊位置 <b className="text-red-600">（可拖曳調整）</b></div>
              <div>🟩 綠框 = 錨點範圍（拖中間移動、拖左上/右下角改大小）</div>
              <div className="text-gray-500 pt-1 border-t border-gray-200">
                座標：({clickPos.x}, {clickPos.y})
              </div>
            </div>
            <div className="p-2 bg-purple-50 border border-purple-200 rounded-lg text-xs text-purple-800 leading-relaxed">
              <strong>🔍 套用後會自動啟用圖像比對模式</strong><br/>
              執行時會用這個錨點在當前畫面找位置，UI 跑掉也能追著目標點。
              點擊位置 = 錨點被找到的位置 + 紅十字相對錨點的偏移。
            </div>

            <div className="flex-1" />

            <button onClick={handleReset}
              className="flex items-center justify-center gap-1.5 px-3 py-2 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50">
              <RotateCcw className="w-3.5 h-3.5" /> 重置（以點擊點為中心 240×80）
            </button>

            <button onClick={handleConfirm}
              className="flex items-center justify-center gap-1.5 px-3 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg text-sm font-medium">
              <Check className="w-4 h-4" /> 確認套用
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
