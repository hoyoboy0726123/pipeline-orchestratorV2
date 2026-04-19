'use client'

import { useEffect, useRef } from 'react'
import { MessageSquare } from 'lucide-react'
import type { ChatMessage } from '@/lib/types'
import { MessageBubble } from './MessageBubble'

interface ChatWindowProps {
  messages: ChatMessage[]
}

function EmptyState() {
  const suggestions = [
    '爬取 Hacker News 今日熱門文章',
    '搜尋 LangGraph 最新文章並整理摘要',
    '爬取台積電 Yahoo 股價資料',
    '搜尋台北今日天氣預報',
  ]

  return (
    <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
      <div className="w-14 h-14 rounded-2xl bg-brand-50 flex items-center justify-center mb-4">
        <MessageSquare className="w-7 h-7 text-brand-500" />
      </div>
      <h2 className="text-lg font-semibold text-gray-900 mb-1">你好，有什麼可以幫你？</h2>
      <p className="text-sm text-gray-500 mb-6 max-w-sm">
        我可以爬取網頁、搜尋資料、操作瀏覽器、管理社群帳號，甚至下載媒體檔案。
      </p>
      <div className="grid grid-cols-2 gap-2 max-w-md w-full">
        {suggestions.map((s, i) => (
          <button
            key={i}
            className="text-left px-3 py-2.5 rounded-xl border border-gray-200 bg-white
                       text-sm text-gray-600 hover:border-brand-300 hover:text-brand-700
                       hover:bg-brand-50 transition-all duration-150"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  )
}

export function ChatWindow({ messages }: ChatWindowProps) {
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  if (messages.length === 0) {
    return <EmptyState />
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-4 py-6 space-y-6">
        {messages.map(msg => (
          <MessageBubble key={msg.id} message={msg} />
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}
