'use client'

import { Bot, User } from 'lucide-react'
import type { ChatMessage } from '@/lib/types'
import { OutputRenderer } from '@/components/output/OutputRenderer'
import { StepTrace } from './StepTrace'
import { cn } from '@/lib/utils'

interface MessageBubbleProps {
  message: ChatMessage
}

function TypingIndicator() {
  return (
    <div className="flex gap-1 items-center py-1 px-1">
      <div className="typing-dot" />
      <div className="typing-dot" />
      <div className="typing-dot" />
    </div>
  )
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === 'user'

  return (
    <div className={cn(
      'flex gap-3 animate-slide-up',
      isUser ? 'justify-end' : 'justify-start'
    )}>
      {/* Avatar */}
      {!isUser && (
        <div className="w-8 h-8 rounded-full bg-brand-100 flex items-center justify-center shrink-0 mt-0.5">
          <Bot className="w-4 h-4 text-brand-600" />
        </div>
      )}

      {/* Content */}
      <div className={cn(
        'max-w-[80%] min-w-0',
        isUser ? 'items-end' : 'items-start',
        'flex flex-col gap-1'
      )}>
        <div className={cn(
          'rounded-2xl px-4 py-3',
          isUser
            ? 'bg-brand-600 text-white rounded-tr-sm'
            : 'bg-gray-50 border border-gray-200 rounded-tl-sm'
        )}>
          {message.status === 'streaming' && !message.content ? (
            <TypingIndicator />
          ) : isUser ? (
            <p className="text-sm leading-relaxed whitespace-pre-wrap">{message.content}</p>
          ) : (
            <OutputRenderer content={message.content} format={message.format} />
          )}
        </div>

        {/* Step trace for assistant messages */}
        {!isUser && message.steps.length > 0 && (
          <StepTrace steps={message.steps} />
        )}

        {/* Timestamp */}
        <span className="text-xs text-gray-400 px-1">
          {message.timestamp.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })}
        </span>
      </div>

      {/* User avatar */}
      {isUser && (
        <div className="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center shrink-0 mt-0.5">
          <User className="w-4 h-4 text-gray-600" />
        </div>
      )}
    </div>
  )
}
