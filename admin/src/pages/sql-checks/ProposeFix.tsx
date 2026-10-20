import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, Loader2, Wand2, XCircle } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import {
  type ApplyOutcome,
  type CompileResult,
  DiffView,
  errorText,
  FIXABLE_CHECKS,
  type FindingDetail,
  type Proposal,
  useTwoClick
} from './shared'

/**
 * Propose / apply a procedure fix for one finding (#2563). The preview (GET) changes nothing; the
 * compile check is a separate POST. Apply sends the preview's hash, so a definition that changed
 * in between is refused, and the server re-checks the procedure and puts the old one back when
 * the result is worse.
 */
export function ProposeFix({ finding }: { finding: FindingDetail }) {
  const qc = useQueryClient()
  const heading = useRef<HTMLHeadingElement>(null)
  const [asked, setAsked] = useState(false)
  // the confirmation belongs to one previewed text: a new preview needs its own
  const [confirmedFor, setConfirmedFor] = useState<string | null>(null)
  const [armed, setArmed] = useTwoClick()
  const [status, setStatus] = useState('')
  const [outcome, setOutcome] = useState<ApplyOutcome | null>(null)
  const [applyError, setApplyError] = useState<string | null>(null)
  const fixable =
    FIXABLE_CHECKS.has(finding.check_key) &&
    (finding.object_type === 'procedure' || finding.object_type === 'import_definition')

  const q = useQuery({
    queryKey: ['sql-checks', 'proposal', finding.id],
    queryFn: () =>
      api
        .get<{ data: Proposal }>(`/sql-checks/findings/${finding.id}/proposal`)
        .then((r) => r.data.data),
    enabled: asked && fixable && finding.status !== 'resolved',
    staleTime: 0,
    gcTime: 0
  })
  const p = q.data
  const hash = p?.proposable ? p.new_definition_hash : null

  // the compile check takes a lock on the procedure, so it is a POST; once per previewed text
  const compile = useQuery({
    queryKey: ['sql-checks', 'proposal-compile', finding.id, hash],
    queryFn: () =>
      api
        .post<{ data: CompileResult }>(`/sql-checks/findings/${finding.id}/proposal/compile`, {
          new_definition_hash: hash
        })
        .then((r) => r.data.data),
    enabled: !!hash && !outcome,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    retry: false
  })

  const confirmed = !!hash && confirmedFor === hash

  // keep keyboard focus in the section when its content changes under it
  const step = outcome
    ? 'outcome'
    : applyError
      ? 'error'
      : p
        ? `preview:${hash}`
        : asked
          ? 'loading'
          : 'idle'
  const lastStep = useRef(step)
  useEffect(() => {
    if (lastStep.current !== step && step !== 'idle' && step !== 'loading') heading.current?.focus()
    lastStep.current = step
  }, [step])

  const apply = useMutation({
    mutationFn: (pr: Proposal) =>
      api
        .post<{ data: ApplyOutcome }>(`/sql-checks/findings/${finding.id}/apply`, {
          new_definition_hash: pr.new_definition_hash,
          confirm_risky: pr.risky ? confirmed : undefined
        })
        .then((r) => r.data.data),
    onSuccess: (r) => {
      setApplyError(null)
      setOutcome(r)
      const msg = r.applied
        ? r.deployed
          ? 'Fix applied and checked'
          : 'Stored body fixed (not deployed)'
        : `Fix put back automatically: ${r.reason ?? 'the re-check was not clean'}`
      setStatus(msg)
      if (r.applied) toast.success(msg)
      else toast.error(msg)
      void qc.invalidateQueries({ queryKey: ['sql-checks'] })
    },
    onError: (err) => {
      const msg = errorText(err, 'Couldn’t apply the fix.')
      setApplyError(msg)
      setStatus(msg)
      toast.error('The fix was not applied')
      void qc.invalidateQueries({ queryKey: ['sql-checks'] })
    }
  })

  if (!fixable || finding.status === 'resolved') return null

  const startOver = () => {
    setOutcome(null)
    setApplyError(null)
    setConfirmedFor(null)
    void q.refetch()
  }

  return (
    <section className='grid gap-2' aria-labelledby={`fix-${finding.id}`}>
      <div className='flex flex-wrap items-center gap-2'>
        <h3
          id={`fix-${finding.id}`}
          ref={heading}
          tabIndex={-1}
          className='m-0 text-[12.5px] font-semibold outline-none'
        >
          Fix it from here
        </h3>
        {!asked && (
          <Button
            size='sm'
            variant='outline'
            className='h-7 px-2.5 text-[12px] [&_svg]:size-3.5'
            onClick={() => setAsked(true)}
          >
            <Wand2 aria-hidden='true' /> Propose fix
          </Button>
        )}
      </div>
      <p className='m-0 sr-only' role='status' aria-live='polite'>
        {status}
      </p>

      {applyError && (
        <div
          role='alert'
          className='grid gap-1.5 rounded-md border border-red-300 bg-red-50 p-3 text-[12.5px] text-red-800 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-200'
        >
          <p className='m-0 flex items-center gap-1.5 font-semibold'>
            <XCircle className='h-3.5 w-3.5' aria-hidden='true' /> The fix was not applied
          </p>
          <p className='m-0'>{applyError}</p>
          <Button size='sm' variant='outline' className='h-7 w-fit text-[12px]' onClick={startOver}>
            Propose again
          </Button>
        </div>
      )}

      {asked && q.isLoading && (
        <div className='grid gap-2' role='status' aria-label='Preparing the proposed fix'>
          <Skeleton className='h-4 w-1/2' />
          <Skeleton className='h-28' />
        </div>
      )}
      {asked && q.isError && (
        <p className='m-0 text-[12.5px] text-red-600 dark:text-red-400'>
          {errorText(q.error, 'Couldn’t prepare a fix.')}
        </p>
      )}

      {p && !p.proposable && (
        <div className='rounded-md border border-slate-200 bg-slate-50 p-3 text-[12.5px] dark:border-border dark:bg-muted/40'>
          <p className='m-0 font-medium'>This one needs a person.</p>
          <p className='m-0 mt-1 text-foreground/80'>{p.manual_reason}</p>
          <p className='m-0 mt-1 text-muted-foreground'>The steps above say what to change.</p>
        </div>
      )}

      {p?.proposable && !outcome && !applyError && (
        <div className='grid gap-2'>
          <p className='m-0 text-[12.5px] text-foreground/90'>
            {p.class === 'xact-abort'
              ? 'Adds SET XACT_ABORT ON as the first statement, so a failed statement rolls the whole transaction back.'
              : 'Treats two empty keys as a match, so a row with an empty key updates its stored row instead of being added again.'}{' '}
            {p.deploys
              ? 'The procedure is changed in the database and checked again at once; if the check finds anything new, the previous version goes back automatically.'
              : 'Only the stored body changes; deploy it from the import definition when you are ready.'}
          </p>

          <p
            className={cn(
              'm-0 flex items-center gap-1.5 text-[12px]',
              compile.isLoading
                ? 'text-muted-foreground'
                : compile.data?.ok
                  ? 'text-emerald-700 dark:text-emerald-400'
                  : 'text-red-600 dark:text-red-400'
            )}
          >
            {compile.isLoading ? (
              <Loader2 className='h-3.5 w-3.5 animate-spin' aria-hidden='true' />
            ) : compile.data?.ok ? (
              <CheckCircle2 className='h-3.5 w-3.5' aria-hidden='true' />
            ) : (
              <XCircle className='h-3.5 w-3.5' aria-hidden='true' />
            )}
            {compile.isLoading
              ? 'Checking that it compiles…'
              : compile.isError
                ? errorText(compile.error, 'Couldn’t check that it compiles.')
                : compile.data?.ok
                  ? compile.data.skipped
                    ? 'Compile check skipped on this database.'
                    : 'Compiles (checked in a transaction that was rolled back).'
                  : `Does not compile: ${compile.data?.error ?? 'unknown error'}`}
          </p>

          {p.notes.length > 0 && (
            <ul className='m-0 grid gap-1 pl-4 text-[12px] text-muted-foreground'>
              {p.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}

          {p.risky && (
            <fieldset className='m-0 min-w-0 grid gap-1.5 rounded-md border border-amber-300 bg-amber-50 p-3 text-[12.5px] text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200'>
              <legend className='float-left m-0 flex w-full items-center gap-1.5 p-0 font-semibold'>
                <AlertTriangle className='h-3.5 w-3.5' aria-hidden='true' /> Check this first
              </legend>
              <ul className='m-0 grid gap-1 pl-4'>
                {p.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
              <label
                htmlFor={`fix-confirm-${finding.id}`}
                className='mt-1 flex items-start gap-2 font-medium'
              >
                <Checkbox
                  id={`fix-confirm-${finding.id}`}
                  className='mt-0.5'
                  checked={confirmed}
                  onCheckedChange={(v) => setConfirmedFor(v === true ? hash : null)}
                />
                {p.class === 'xact-abort'
                  ? 'I’ve checked how this procedure handles errors'
                  : 'I’ve checked the source has one row per key and the copies are dealt with'}
              </label>
            </fieldset>
          )}

          <DiffView hunks={p.diff} label={`Proposed change to ${p.target.label}`} />
          <p className='m-0 text-[11.5px] text-muted-foreground'>{p.note}</p>

          <div className='flex flex-wrap items-center gap-2'>
            <Button
              size='sm'
              className={cn(
                'h-8 text-[12.5px] [&_svg]:size-3.5',
                armed
                  ? 'bg-amber-500 text-white hover:bg-amber-500/90'
                  : 'bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
              )}
              disabled={
                apply.isPending ||
                !compile.data?.ok ||
                !p.new_definition_hash ||
                (p.risky && !confirmed)
              }
              onClick={() => {
                if (!armed) return setArmed(true)
                setArmed(false)
                apply.mutate(p)
              }}
            >
              {apply.isPending && <Loader2 className='animate-spin' aria-hidden='true' />}
              {apply.isPending
                ? 'Applying…'
                : armed
                  ? 'Click again to apply'
                  : p.deploys
                    ? 'Apply fix'
                    : 'Save to stored body'}
            </Button>
            <Button
              size='sm'
              variant='ghost'
              className='h-8 text-[12.5px]'
              disabled={apply.isPending}
              onClick={() => {
                setAsked(false)
                setOutcome(null)
                setConfirmedFor(null)
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {outcome && (
        <div className='grid gap-1.5'>
          <p
            className={cn(
              'm-0 text-[12.5px]',
              outcome.applied
                ? 'text-emerald-700 dark:text-emerald-400'
                : 'text-amber-800 dark:text-amber-300'
            )}
          >
            {outcome.applied
              ? `${outcome.deployed ? 'Applied and checked' : 'Stored body saved'} (fix #${outcome.fix_id}). It can be reverted from the Fixes tab.`
              : `The change was put back automatically: ${outcome.reason ?? 'the re-check was not clean'}. Nothing else changed.`}
          </p>
          {!outcome.applied && (
            <Button
              size='sm'
              variant='outline'
              className='h-7 w-fit text-[12px]'
              onClick={startOver}
            >
              Propose again
            </Button>
          )}
        </div>
      )}
    </section>
  )
}
