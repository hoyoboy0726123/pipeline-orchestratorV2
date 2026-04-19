'use client'

import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import type { OutputFormat } from '@/lib/types'
import 'highlight.js/styles/github.css'

interface OutputRendererProps {
  content: string
  format: OutputFormat
}

export function OutputRenderer({ content, format }: OutputRendererProps) {
  if (!content) return null

  // JSON / YAML / CSV → code block
  if (format === 'json' || format === 'yaml' || format === 'csv') {
    const lang = format === 'csv' ? 'text' : format
    return (
      <div className="overflow-x-auto">
        <pre className="bg-gray-50 border border-gray-200 rounded-xl p-4 text-sm font-mono text-gray-800 whitespace-pre-wrap break-words">
          <code className={`language-${lang}`}>{content}</code>
        </pre>
      </div>
    )
  }

  // Markdown / Table → react-markdown
  return (
    <div className="prose prose-sm max-w-none prose-gray
                    prose-headings:font-semibold prose-headings:text-gray-900
                    prose-p:text-gray-700 prose-p:leading-relaxed
                    prose-li:text-gray-700
                    prose-strong:text-gray-900
                    prose-a:text-brand-600 prose-a:no-underline hover:prose-a:underline
                    prose-code:text-brand-700 prose-code:bg-brand-50 prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:text-xs prose-code:font-mono
                    prose-pre:bg-gray-50 prose-pre:border prose-pre:border-gray-200 prose-pre:rounded-xl">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}
