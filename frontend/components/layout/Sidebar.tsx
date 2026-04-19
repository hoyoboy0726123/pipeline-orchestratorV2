'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import {
  MessageSquare, CalendarClock, FolderOpen, Zap, GitBranch, Settings,
  ChevronDown, ChevronRight, Circle, AlertCircle, CheckCircle2,
  Info
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { getOpenCLISites, getOpenCLIStatus } from '@/lib/api'
import { useChatStore } from '@/lib/store'
import type { OpenCLICategory, OpenCLIStatus } from '@/lib/types'

const nav = [
  { href: '/chat',     label: '對話',       icon: MessageSquare },
  { href: '/pipeline', label: 'Pipeline',   icon: GitBranch },
  { href: '/tasks',    label: '定時任務',   icon: CalendarClock },
  { href: '/files',    label: '輸出檔案',   icon: FolderOpen },
  { href: '/settings', label: '設定',       icon: Settings },
]

export function Sidebar() {
  const pathname = usePathname()
  const router = useRouter()
  const { setPending } = useChatStore()

  const [sites, setSites] = useState<OpenCLICategory[]>([])
  const [status, setStatus] = useState<OpenCLIStatus | null>(null)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [showSetup, setShowSetup] = useState(false)
  const [opencliOpen, setOpencliOpen] = useState(true)

  useEffect(() => {
    getOpenCLISites().then(setSites).catch(() => {})
    const poll = () => getOpenCLIStatus().then(setStatus).catch(() => {})
    poll()
    const interval = setInterval(poll, 5000)
    return () => clearInterval(interval)
  }, [])

  const handleSiteClick = (siteId: string, siteName: string, command: string) => {
    const task = `使用 OpenCLI 執行：${siteId} ${command.split(' ').slice(1).join(' ')} — 抓取 ${siteName} 最新資料`
    setPending(task, 'opencli')
    router.push('/chat')
  }

  const daemonOk = status?.daemon ?? false

  return (
    <aside className="w-64 border-r border-gray-200 flex flex-col bg-white shrink-0 overflow-hidden">
      {/* Logo */}
      <div className="h-14 flex items-center gap-2.5 px-5 border-b border-gray-200 shrink-0">
        <div className="w-7 h-7 rounded-lg bg-brand-600 flex items-center justify-center">
          <Zap className="w-4 h-4 text-white" strokeWidth={2.5} />
        </div>
        <span className="font-semibold text-gray-900 tracking-tight">LangGraph Agent</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Nav */}
        <nav className="p-3 space-y-0.5">
          {nav.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className={cn(
                'flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all duration-150',
                pathname.startsWith(href)
                  ? 'bg-brand-50 text-brand-700'
                  : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100'
              )}
            >
              <Icon className="w-4 h-4 shrink-0" />
              {label}
            </Link>
          ))}
        </nav>

        <div className="mx-3 border-t border-gray-100" />

        {/* OpenCLI Section */}
        <div className="p-3">
          {/* Section header */}
          <button
            onClick={() => setOpencliOpen(v => !v)}
            className="w-full flex items-center justify-between px-2 py-1.5 rounded-lg hover:bg-gray-50 transition-colors group"
          >
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">OpenCLI 網站</span>
              {/* Status dot */}
              {status === null ? (
                <Circle className="w-2 h-2 text-gray-300 fill-gray-300" />
              ) : daemonOk ? (
                <CheckCircle2 className="w-3 h-3 text-green-500" />
              ) : (
                <AlertCircle className="w-3 h-3 text-amber-500" />
              )}
            </div>
            {opencliOpen
              ? <ChevronDown className="w-3.5 h-3.5 text-gray-400" />
              : <ChevronRight className="w-3.5 h-3.5 text-gray-400" />
            }
          </button>

          {opencliOpen && (
            <div className="mt-1">
              {/* Status bar */}
              <div className={cn(
                'mx-1 mb-2 px-3 py-2 rounded-lg text-xs flex items-start gap-2',
                daemonOk
                  ? 'bg-green-50 text-green-700'
                  : 'bg-amber-50 text-amber-700'
              )}>
                {daemonOk ? (
                  <span>● 已連線 — 可使用下方網站</span>
                ) : (
                  <div className="space-y-1">
                    <div>● 未連線</div>
                    <button
                      onClick={() => setShowSetup(v => !v)}
                      className="underline underline-offset-2 flex items-center gap-1"
                    >
                      <Info className="w-3 h-3" />
                      查看設定步驟
                    </button>
                  </div>
                )}
              </div>

              {/* Setup guide */}
              {showSetup && (
                <div className="mx-1 mb-2 p-3 bg-gray-50 rounded-lg text-xs text-gray-600 space-y-2">
                  <p className="font-semibold text-gray-700">前置設定步驟</p>
                  <ol className="space-y-1.5 list-decimal list-inside">
                    <li>安裝 Chrome 擴充套件<br/>
                      <span className="text-gray-500">下載 OpenCLI Browser Bridge</span>
                    </li>
                    <li>在終端執行：
                      <code className="block mt-1 bg-gray-100 px-2 py-1 rounded font-mono text-[10px] break-all">
                        opencli setup
                      </code>
                    </li>
                    <li>CDP 功能（navigate/截圖）需要：
                      <code className="block mt-1 bg-gray-100 px-2 py-1 rounded font-mono text-[10px] break-all">
                        &quot;/Applications/Google Chrome.app/Contents/MacOS/Google Chrome&quot; --remote-debugging-port=9222 --profile-directory=Default &
                      </code>
                    </li>
                  </ol>
                </div>
              )}

              {/* Site categories */}
              {sites.map((cat) => (
                <div key={cat.category} className="mb-1">
                  <button
                    onClick={() => setExpanded(v => ({ ...v, [cat.category]: !v[cat.category] }))}
                    className="w-full flex items-center justify-between px-2 py-1 rounded hover:bg-gray-50 transition-colors"
                  >
                    <span className="text-xs text-gray-400 font-medium">{cat.category}</span>
                    {expanded[cat.category]
                      ? <ChevronDown className="w-3 h-3 text-gray-300" />
                      : <ChevronRight className="w-3 h-3 text-gray-300" />
                    }
                  </button>

                  {expanded[cat.category] && (
                    <div className="ml-1 space-y-0.5">
                      {cat.sites.map((site) => (
                        <button
                          key={site.id}
                          onClick={() => handleSiteClick(site.id, site.name, site.command)}
                          disabled={!daemonOk}
                          className={cn(
                            'w-full flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm transition-all',
                            daemonOk
                              ? 'text-gray-700 hover:bg-brand-50 hover:text-brand-700 cursor-pointer'
                              : 'text-gray-400 cursor-not-allowed opacity-60'
                          )}
                        >
                          <span className="text-base leading-none">{site.icon}</span>
                          <span className="text-xs">{site.name}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="p-4 border-t border-gray-200 shrink-0">
        <p className="text-xs text-gray-400 text-center">Powered by Groq + LangGraph</p>
      </div>
    </aside>
  )
}
