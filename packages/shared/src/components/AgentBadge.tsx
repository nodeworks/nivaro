import { Bot } from 'lucide-react'
import { cn } from '../lib/utils'

/**
 * The "via Claude" mark beside a change or comment an AI assistant made through Nivaro's MCP
 * server (#3213). The text comes from the server (`via_agent` on comments, revisions and
 * activity rows) — the instance setting decides whether it names the app or reads one fixed
 * label — so every surface says the same thing. Renders nothing without a label.
 */
export function AgentBadge({
  label,
  className
}: {
  label: string | null | undefined
  className?: string
}) {
  if (!label) return null
  return (
    <span
      data-nvr-agent-badge
      data-tip='Made by an AI assistant acting as this person, through Nivaro’s MCP server'
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded bg-slate-100 px-1.5 py-px text-[10.5px] font-medium leading-4 text-slate-600 dark:bg-muted dark:text-slate-300',
        className
      )}
    >
      <Bot className='h-3 w-3' aria-hidden />
      <span className='max-w-[16ch] truncate'>{label}</span>
    </span>
  )
}
