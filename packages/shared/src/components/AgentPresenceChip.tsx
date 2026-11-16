import { Bot } from 'lucide-react'
import { agentOwnerPrefix, agentSentence, useRecordAgents } from '../lib/agent-presence'
import { useMyUserId } from '../lib/presence-signals'
import { cn } from '../lib/utils'

/**
 * "Claude (for Rob) is updating this record" — beside a record's viewers while an AI agent
 * reads or writes it (rt8 #21). Quiet text, no motion beyond a soft dot while it writes (none
 * with reduced motion); nothing at all in Calm / Off or when no agent is there. Several agents
 * show the first sentence and "+N", every sentence in the tip.
 */
export function AgentPresenceChip({
  collection,
  item,
  className
}: {
  collection: string | null | undefined
  item: string | number | null | undefined
  className?: string
}) {
  const agents = useRecordAgents(collection, item)
  const me = useMyUserId()
  if (agents.length === 0) return null
  const first = agents[0]
  const all = agents.map((a) => agentSentence(a, me)).join('\n')
  const writing = first.mode === 'updating'
  const owner = agentOwnerPrefix(first, me)
  return (
    <span
      data-nvr-agent-presence={first.mode}
      data-tip={`${all}\nAn AI assistant working through Nivaro’s MCP server, as that person.`}
      className={cn(
        'inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full border border-slate-200 bg-white py-0.5 pl-1.5 pr-2 text-[11px] leading-4 text-slate-600 motion-safe:animate-[nvr-fade-in_240ms_ease-out_backwards] dark:border-border dark:bg-card dark:text-slate-300',
        className
      )}
    >
      <span className='relative flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-500 dark:bg-muted dark:text-slate-300'>
        <Bot className='h-3 w-3' aria-hidden />
        {writing && (
          <span
            aria-hidden
            className='absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-nvr-cyan ring-2 ring-white motion-safe:animate-pulse dark:ring-card'
          />
        )}
      </span>
      <span className='hidden truncate sm:inline'>
        <span className='font-medium text-slate-800 dark:text-foreground'>{first.name}</span>
        {agentSentence(first, me).slice(first.name.length)}
      </span>
      {/* Phone: shorter, but still whose agent it is ("Rob Lee’s Desk Claude is updating"). */}
      <span className='truncate sm:hidden'>
        {owner ? `${owner} ` : ''}
        <span className='font-medium text-slate-800 dark:text-foreground'>{first.name}</span>
        {agentSentence(first, me, true).slice(first.name.length)}
      </span>
      {agents.length > 1 && (
        <span className='shrink-0 font-medium tabular-nums text-slate-500 dark:text-slate-400'>
          +{agents.length - 1}
          <span className='sr-only'>
            {' '}
            more:{' '}
            {agents
              .slice(1)
              .map((a) => agentSentence(a, me))
              .join('; ')}
          </span>
        </span>
      )}
    </span>
  )
}
