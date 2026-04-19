import type { Metadata } from 'next'
import './globals.css'
import { Toaster } from 'sonner'

export const metadata: Metadata = {
  title: 'Pipeline Orchestrator',
  description: 'Visual Pipeline Orchestration Tool',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-TW">
      <body>
        <div className="h-screen overflow-hidden bg-white flex flex-col">
          <main className="flex-1 overflow-hidden flex flex-col min-w-0">
            {children}
          </main>
        </div>
        <Toaster position="top-right" richColors />
      </body>
    </html>
  )
}
