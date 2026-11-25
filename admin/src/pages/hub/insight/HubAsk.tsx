import { ErrorNotice } from '@nivaro/shared'
import { useMutation } from '@tanstack/react-query'
import { ArrowUp, Eraser, Sparkles } from 'lucide-react'
import { type KeyboardEvent, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { ghostButton } from '../hub-parts'
import { type AskAnswer, askHub } from './insight-api'
import { hubLinkPath, SafeAnswer } from './SafeAnswer'

/**
 * Ask the Hub (Apps hub tab): questions about the apps this Hub looks after, answered by AI from
 * read-only Hub tools that see exactly what the person sees on the other tabs (admins every app,
 * owners their own). It never changes anything; answers name the records they used. The
 * conversation lives in this tab only (nothing is stored).
 */

type Turn =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; answer: AskAnswer }

const STARTERS = [
  'Which environments are unhealthy right now, and why?',
  'What was deployed to production this week?',
  'Which apps depend on the same database server?',
  'How many people used each app last week?'
]

const TOOL_LABEL: Record<string, string> = {
  hub_list_apps: 'apps',
  hub_read_app: 'an app',
  hub_app_status: 'status',
  hub_fleet_status: 'the fleet',
  hub_deploy_history: 'deploys',
  hub_plan_promote: 'a promote plan',
  hub_list_shared: 'shared deployments',
  hub_plan_move: 'a move plan',
  hub_plan_upgrade: 'an upgrade plan',
  hub_health: 'health',
  hub_usage: 'usage',
  hub_dependencies: 'dependencies',
  hub_impact: 'impact'
}

/** The newest 20 turns, starting on a question (the server keeps the same window). */
function windowOf(turns: Turn[]): Turn[] {
  const out = turns.slice(-20)
  while (out.length && out[0].role !== 'user') out.shift()
  return out
}

export default function HubAsk() {
  const [turns, setTurns] = useState<Turn[]>([])
  const [draft, setDraft] = useState('')
  const end = useRef<HTMLDivElement>(null)
  const box = useRef<HTMLTextAreaElement>(null)
  const ask = useMutation({
    mutationFn: (history: Turn[]) =>
      askHub(history.map((t) => ({ role: t.role, content: t.content }))),
    onSuccess: (answer) =>
      setTurns((t) => [...t, { role: 'assistant', content: answer.answer, answer }])
  })

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on each new turn or wait
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end', behavior: 'smooth' })
  }, [turns.length, ask.isPending])

  const send = (text: string) => {
    const q = text.trim()
    if (!q || ask.isPending || q.length > 4000) return
    const next: Turn[] = [...turns, { role: 'user', content: q }]
    setTurns(next)
    setDraft('')
    ask.mutate(windowOf(next))
  }
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      send(draft)
    }
  }

  return (
    <div className='flex flex-1 min-h-0 flex-col bg-slate-50 dark:bg-background'>
      <div className='shrink-0 border-b border-slate-200 bg-white px-4 py-3 dark:border-border dark:bg-card'>
        <div className='flex flex-wrap items-center gap-x-3 gap-y-1'>
          <p className='m-0 text-[13px] font-medium text-slate-900 dark:text-foreground'>
            Ask the Hub
          </p>
          <p className='m-0 text-[12px] text-slate-500 dark:text-muted-foreground'>
            Reads only — it sees what you see here and cannot change anything.
          </p>
          <div className='ml-auto flex items-center gap-1'>
            <Link
              to='/docs?section=hub-insight'
              className='px-2 text-[12px] text-slate-500 hover:underline dark:text-muted-foreground'
            >
              How this works
            </Link>
            {turns.length > 0 && (
              <button
                type='button'
                className={ghostButton}
                disabled={ask.isPending}
                onClick={() => {
                  setTurns([])
                  ask.reset()
                  box.current?.focus()
                }}
              >
                <Eraser className='h-3.5 w-3.5' aria-hidden />
                New conversation
              </button>
            )}
          </div>
        </div>
      </div>

      <div className='flex-1 overflow-y-auto px-4 py-4' aria-live='polite'>
        {turns.length === 0 ? (
          <div className='rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
            <p className='m-0 flex items-center gap-2 text-[13px] font-medium text-slate-900 dark:text-foreground'>
              <Sparkles className='h-4 w-4 text-slate-400' aria-hidden />
              Ask about versions, deploys, health, uptime, usage or dependencies
            </p>
            <div className='mt-3 flex flex-wrap gap-2'>
              {STARTERS.map((s) => (
                <button
                  key={s}
                  type='button'
                  onClick={() => send(s)}
                  className='rounded-full border border-slate-200 px-3 py-1.5 text-left text-[12px] text-slate-700 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:border-border dark:text-slate-200'
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <ol className='m-0 list-none space-y-3 p-0'>
            {turns.map((t, i) =>
              t.role === 'user' ? (
                // biome-ignore lint/suspicious/noArrayIndexKey: turns are append-only
                <li key={i} className='flex justify-end'>
                  <p className='m-0 max-w-[85%] whitespace-pre-wrap rounded-lg bg-[#0f172a] px-3 py-2 text-[13px] text-white dark:bg-[#334155]'>
                    {t.content}
                  </p>
                </li>
              ) : (
                // biome-ignore lint/suspicious/noArrayIndexKey: turns are append-only
                <li key={i}>
                  <div className='max-w-[92%] rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-slate-800 dark:border-border dark:bg-card dark:text-slate-100'>
                    <SafeAnswer text={t.content || 'No answer came back.'} />
                    {t.answer.partial && (
                      <p className='m-0 mt-2 text-[12px] text-amber-800 dark:text-amber-300'>
                        This answer stopped early. Narrow the question to one app or environment.
                      </p>
                    )}
                    {t.answer.citations.length > 0 && (
                      <div className='mt-2.5 border-t border-slate-100 pt-2 dark:border-border'>
                        <p className='m-0 text-[11px] font-medium text-slate-500 dark:text-muted-foreground'>
                          Sources
                        </p>
                        <ul className='m-0 mt-1 flex list-none flex-wrap gap-1.5 p-0'>
                          {t.answer.citations
                            .map((c) => ({ ...c, path: hubLinkPath(c.path) ?? '' }))
                            .filter((c) => c.path)
                            .slice(0, 12)
                            .map((c) => (
                              <li key={c.path}>
                                <Link
                                  to={c.path}
                                  className='inline-block rounded-md border border-slate-200 px-2 py-0.5 text-[12px] text-slate-700 hover:bg-muted dark:border-border dark:text-slate-200'
                                >
                                  {c.label}
                                </Link>
                              </li>
                            ))}
                        </ul>
                      </div>
                    )}
                    {t.answer.tools.length > 0 && (
                      <p className='m-0 mt-2 text-[11px] text-slate-500 dark:text-muted-foreground'>
                        Looked at {t.answer.tools.map((x) => TOOL_LABEL[x] ?? x).join(', ')}
                      </p>
                    )}
                  </div>
                </li>
              )
            )}
            {ask.isPending && (
              <li>
                <div className='inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-[12px] text-slate-500 dark:border-border dark:bg-card dark:text-muted-foreground'>
                  <span
                    className='h-1.5 w-1.5 animate-pulse rounded-full bg-slate-400'
                    aria-hidden
                  />
                  Looking it up…
                </div>
              </li>
            )}
          </ol>
        )}
        {ask.isError && (
          <div className='mt-3'>
            <ErrorNotice
              error={ask.error}
              onRetry={() => {
                const history = turns
                if (history.length && history[history.length - 1].role === 'user')
                  ask.mutate(windowOf(history))
              }}
            />
          </div>
        )}
        <div ref={end} />
      </div>

      <form
        className='shrink-0 border-t border-slate-200 bg-white py-3 pr-16 pl-4 dark:border-border dark:bg-card'
        onSubmit={(e) => {
          e.preventDefault()
          send(draft)
        }}
      >
        <div className='flex items-end gap-2'>
          <textarea
            ref={box}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKey}
            rows={1}
            maxLength={4000}
            placeholder='Ask a question about your apps'
            aria-label='Your question'
            className={cn(
              'max-h-40 min-h-[36px] flex-1 resize-none rounded-md border border-slate-300 bg-white px-3 py-2 text-[13px] text-slate-900 placeholder:text-slate-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50',
              'dark:border-border dark:bg-background dark:text-foreground dark:placeholder:text-muted-foreground'
            )}
          />
          <Button
            type='submit'
            size='sm'
            className='h-9 bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
            disabled={!draft.trim() || ask.isPending}
            aria-label='Ask'
          >
            <ArrowUp className='h-4 w-4' aria-hidden />
          </Button>
        </div>
        <p className='m-0 mt-1.5 text-[11px] text-slate-500 dark:text-muted-foreground'>
          Enter to ask, Shift+Enter for a new line. Answers use AI and can be wrong — check the
          sources.
        </p>
      </form>
    </div>
  )
}
