import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Brain, Check, X } from 'lucide-react'
import { useState } from 'react'
import { useNavigation, useOptionalNivaroClient } from '../../context'
import { get, post } from '../../lib/commands'
import { cn } from '../../lib/utils'

/**
 * "Remember this?" under an Ask AI answer (#1845). The model may offer a
 * standing note it inferred ("By my zone I mean Zone 3"); the answer carries
 * it as `memory_suggestions` — only to the person who asked (a shared reader
 * never receives it). Nothing is saved until the Remember click, which POSTs
 * /ai/memory: the person's own notes, the same caps as Profile → Ask AI
 * memory. "Not now" only hides the offer here. Renders nothing without
 * suggestions or a NivaroProvider.
 */

export interface AiMemorySuggestion {
  text: string
}

type RowState = 'idle' | 'saving' | 'saved' | 'dismissed'

export function AiMemorySuggestions({
  suggestions,
  className
}: {
  suggestions?: AiMemorySuggestion[] | null
  className?: string
}) {
  const client = useOptionalNivaroClient()
  const qc = useQueryClient()
  const [state, setState] = useState<Record<string, RowState>>({})
  const [error, setError] = useState<{ text: string; full: boolean } | null>(null)
  const nav = useNavigation()
  const list = (suggestions ?? []).filter((s) => s && typeof s.text === 'string' && s.text)
  // Same key and shape as Profile's AiMemoryCard: an offer already in the
  // person's memory (accepted earlier, or added since) shows as remembered.
  const { data: prefs } = useQuery({
    queryKey: ['nvr-profile-prefs'],
    queryFn: () =>
      client!
        .request<{ data: { preferences?: Record<string, unknown> | null } }>(get('/users/me'))
        .then((r) => (r.data?.preferences ?? {}) as Record<string, unknown>),
    enabled: !!client && list.length > 0
  })
  if (!client || list.length === 0) return null
  const known = new Set(
    (Array.isArray(prefs?.ai_memory) ? (prefs.ai_memory as Array<{ text?: unknown }>) : [])
      .map((n) => (typeof n?.text === 'string' ? n.text.toLowerCase() : ''))
      .filter(Boolean)
  )

  const remember = async (text: string) => {
    setError(null)
    setState((s) => ({ ...s, [text]: 'saving' }))
    try {
      await client.request(post('/ai/memory', { text }))
      setState((s) => ({ ...s, [text]: 'saved' }))
      void qc.invalidateQueries({ queryKey: ['nvr-profile-prefs'] })
    } catch (err) {
      setState((s) => ({ ...s, [text]: 'idle' }))
      const data = (err as { response?: { data?: { error?: string; code?: string } } })?.response
        ?.data
      setError({
        text: data?.error ?? (err instanceof Error ? err.message : 'Could not remember that'),
        // A full memory refuses — nothing is dropped; the person picks on Profile.
        full: data?.code === 'AI_MEMORY_FULL'
      })
    }
  }

  const rows = list.filter((s) => state[s.text] !== 'dismissed')
  if (rows.length === 0) return null
  return (
    <div className={cn('mt-2 space-y-1', className)} data-ai-memory-suggestions>
      {rows.map((s) => {
        const st = state[s.text] ?? 'idle'
        const saved = st === 'saved' || known.has(s.text.toLowerCase())
        return (
          <div
            key={s.text}
            className='flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-[12px] dark:border-border dark:bg-muted/40'
            data-ai-memory-suggestion={saved ? 'saved' : 'offered'}
          >
            <Brain className='h-3.5 w-3.5 shrink-0 text-nvr-cyan' />
            {saved ? (
              <span className='min-w-0 flex-1 text-slate-600 dark:text-slate-300'>
                <Check className='mr-1 inline h-3 w-3 text-emerald-600 dark:text-emerald-400' />
                Remembered: “{s.text}” — see Profile → Ask AI memory.
              </span>
            ) : (
              <>
                <span className='min-w-0 flex-1 text-slate-700 dark:text-slate-200'>
                  <span className='font-medium'>Remember this?</span>{' '}
                  <span className='text-slate-600 dark:text-slate-300'>“{s.text}”</span>
                  <span className='block text-[11px] text-slate-500 dark:text-slate-400'>
                    This note is added to every future question you ask.
                  </span>
                </span>
                <span className='flex items-center gap-1'>
                  <button
                    type='button'
                    disabled={st === 'saving'}
                    onClick={() => void remember(s.text)}
                    className='inline-flex h-6 items-center rounded-md bg-nvr-cyan px-2 text-[11.5px] font-medium text-white disabled:opacity-50'
                    data-ai-memory-accept
                  >
                    {st === 'saving' ? 'Saving…' : 'Remember'}
                  </button>
                  <button
                    type='button'
                    onClick={() => setState((x) => ({ ...x, [s.text]: 'dismissed' }))}
                    className='inline-flex h-6 w-6 items-center justify-center rounded-md text-slate-400 hover:bg-muted hover:text-slate-700 dark:hover:text-slate-200'
                    aria-label='Not now'
                    data-ai-memory-dismiss
                  >
                    <X className='h-3.5 w-3.5' />
                  </button>
                </span>
              </>
            )}
          </div>
        )
      })}
      {error && (
        <p className='text-[11.5px] text-red-600' data-ai-memory-error>
          {error.text}
          {error.full && (
            <>
              {' '}
              <button
                type='button'
                className='underline underline-offset-2'
                onClick={() => nav.navigate('/profile#ai-memory')}
                data-ai-memory-open-profile
              >
                Open Ask AI memory
              </button>
            </>
          )}
        </p>
      )}
    </div>
  )
}
