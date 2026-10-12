import { useMutation } from '@tanstack/react-query'
import { Loader2, Sparkles } from 'lucide-react'
import { useEffect } from 'react'
import { useItemEditAuth, useNavigation, useNivaroClient } from '../../context'
import { post } from '../../lib/commands'
import { Button } from '../ui/button'

/** Mirrors the API's ExplainAnswer (services/ai-explain.ts). */
export interface ExplainAnswer {
  kind: string
  title: string
  summary: string
  steps: string[]
  retry_safe: 'yes' | 'no' | 'unknown' | null
  caution: string | null
  links: Array<{ label: string; href: string }>
  contacts: Array<{ role: string; name: string; email?: string | null }>
  generated_at: string
  cached: boolean
  model: string | null
}

/**
 * Admin-only "Explain" for an operations event (issue, slow request, failed run, readiness
 * check, partner/webhook failure, slow page, config, data model). One POST to
 * /ai-explain/:kind with kind-specific params; the answer is a suggestion and says so.
 * Host-agnostic: it reads the ambient Nivaro client, admin flag and navigation context, and
 * renders nothing for a non-admin (the route is admin-only too).
 */
export function ExplainButton({
  kind,
  params,
  label = 'Explain',
  size = 'sm',
  autoRun = false
}: {
  kind: string
  params: Record<string, unknown>
  label?: string
  size?: 'sm' | 'default'
  /** Run once on mount (the button was already clicked to reveal this). */
  autoRun?: boolean
}) {
  const { isAdmin } = useItemEditAuth()
  const client = useNivaroClient()
  const nav = useNavigation()
  const run = useMutation({
    mutationFn: async (fresh: boolean) =>
      (
        await client.request(
          post<{ data: ExplainAnswer }>(`/ai-explain/${kind}`, { ...params, fresh })
        )
      ).data
  })
  // biome-ignore lint/correctness/useExhaustiveDependencies: fire once on mount
  useEffect(() => {
    if (autoRun && isAdmin) run.mutate(false)
  }, [])
  if (!isAdmin) return null
  const a = run.data
  const err = run.error as { response?: { data?: { error?: string } }; message?: string } | null
  const errText = err?.response?.data?.error ?? err?.message
  return (
    <div className='flex flex-col gap-2'>
      <div>
        <Button
          type='button'
          variant='outline'
          size={size}
          disabled={run.isPending}
          onClick={() => run.mutate(!!a)}
        >
          {run.isPending ? (
            <Loader2 className='mr-1.5 h-3.5 w-3.5 animate-spin' />
          ) : (
            <Sparkles className='mr-1.5 h-3.5 w-3.5' />
          )}
          {a ? 'Explain again' : label}
        </Button>
      </div>
      {run.isError && (
        <p className='text-[12px] text-red-600 dark:text-red-400'>
          {errText ?? 'Could not explain this right now'}
        </p>
      )}
      {a && (
        <div className='rounded-lg border border-slate-200 bg-slate-50 p-3 text-[12.5px] leading-relaxed dark:border-border dark:bg-muted/30'>
          <p className='mb-1 text-[11px] font-medium uppercase tracking-wide text-slate-500'>
            AI suggestion, not a verdict
          </p>
          <p className='whitespace-pre-wrap'>{a.summary}</p>
          {a.steps.length > 0 && (
            <ol className='mt-2 list-decimal space-y-0.5 pl-5'>
              {a.steps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
          )}
          {a.retry_safe && (
            <p className='mt-2'>
              Retry safe: <strong>{a.retry_safe}</strong>
            </p>
          )}
          {a.caution && <p className='mt-2 text-amber-700 dark:text-amber-400'>{a.caution}</p>}
          {a.contacts.length > 0 && (
            <p className='mt-2'>
              Contact: {a.contacts.map((c) => `${c.name} (${c.role})`).join(', ')}
            </p>
          )}
          {a.links.length > 0 && (
            <p className='mt-2 flex flex-wrap gap-x-3'>
              {a.links.map((l) => {
                const href = nav.consoleUrl ? nav.consoleUrl(l.href) : l.href
                if (!href) return null
                return (
                  <button
                    key={l.href}
                    type='button'
                    className='text-nvr-cyan hover:underline'
                    onClick={() => nav.navigate(href)}
                  >
                    {l.label}
                  </button>
                )
              })}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

/** An ExplainButton in a bordered card of its own; renders nothing for a non-admin. */
export function ExplainCard(props: Parameters<typeof ExplainButton>[0]) {
  const { isAdmin } = useItemEditAuth()
  if (!isAdmin) return null
  return (
    <div
      data-explain-card={props.kind}
      className='rounded-xl border border-slate-200 bg-white px-6 py-4 dark:border-border dark:bg-card'
    >
      <ExplainButton {...props} />
    </div>
  )
}
