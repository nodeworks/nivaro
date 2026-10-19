import { useMutation } from '@tanstack/react-query'
import { Loader2, Sparkles } from 'lucide-react'
import { useEffect } from 'react'
import { Link } from 'react-router'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'

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
 * check, partner/webhook failure, config, data model). One POST to /ai-explain/:kind with
 * kind-specific params; the answer is a suggestion and says so.
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
  const { user } = useAuth()
  const run = useMutation({
    mutationFn: async (fresh: boolean) =>
      (await api.post(`/ai-explain/${kind}`, { ...params, fresh })).data.data as ExplainAnswer
  })
  // biome-ignore lint/correctness/useExhaustiveDependencies: fire once on mount
  useEffect(() => {
    if (autoRun && user?.is_admin) run.mutate(false)
  }, [])
  if (!user?.is_admin) return null
  const a = run.data
  const err = (run.error as { response?: { data?: { error?: string } } } | null)?.response?.data
    ?.error
  // A self-starting explanation shows its progress, not a button, until there is something to redo.
  const showButton = !autoRun || !!a || run.isError
  return (
    <div aria-live='polite' className='flex flex-col gap-2'>
      {!showButton && run.isPending && (
        <p
          role='status'
          className='m-0 flex items-center gap-1.5 text-[12px] text-muted-foreground'
        >
          <Loader2 className='h-3.5 w-3.5 animate-spin' aria-hidden='true' />
          Explaining…
        </p>
      )}
      {showButton && (
        <div>
          <Button
            type='button'
            variant='outline'
            size={size}
            disabled={run.isPending}
            onClick={() => run.mutate(!!a)}
          >
            {run.isPending ? (
              <Loader2 className='mr-1.5 h-3.5 w-3.5 animate-spin' aria-hidden='true' />
            ) : (
              <Sparkles className='mr-1.5 h-3.5 w-3.5' aria-hidden='true' />
            )}
            {run.isPending ? 'Explaining…' : a ? 'Explain again' : label}
          </Button>
        </div>
      )}
      {run.isError && (
        <p className='text-[12px] text-red-600 dark:text-red-400'>
          {err ?? 'Could not explain this right now'}
        </p>
      )}
      {a && (
        <div className='rounded-lg border border-slate-200 bg-slate-50 p-3 text-[12.5px] leading-relaxed dark:border-border dark:bg-muted/30'>
          <p className='mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground'>
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
              {a.links.map((l) => (
                <Link key={l.href} to={l.href} className='text-nvr-cyan hover:underline'>
                  {l.label}
                </Link>
              ))}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
