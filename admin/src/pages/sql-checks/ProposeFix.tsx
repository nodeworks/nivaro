import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, Loader2, Wand2, XCircle } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import {
  type ApplyOutcome,
  DiffView,
  errorText,
  FIXABLE_CHECKS,
  type FindingDetail,
  type Proposal,
  useTwoClick
} from './shared'

/**
 * Propose / apply a procedure fix for one finding (#2563). The preview changes nothing; Apply
 * sends the preview's hash, so a definition that changed in between is refused, and the server
 * re-checks the procedure and puts the old one back when the result is worse.
 */
export function ProposeFix({ finding }: { finding: FindingDetail }) {
  const qc = useQueryClient()
  const [asked, setAsked] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  const [armed, setArmed] = useTwoClick()
  const [status, setStatus] = useState('')
  const [outcome, setOutcome] = useState<ApplyOutcome | null>(null)
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

  const apply = useMutation({
    mutationFn: (p: Proposal) =>
      api
        .post<{ data: ApplyOutcome }>(`/sql-checks/findings/${finding.id}/apply`, {
          new_definition_hash: p.new_definition_hash,
          confirm_risky: p.risky ? confirmed : undefined
        })
        .then((r) => r.data.data),
    onSuccess: (r) => {
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
      setStatus(msg)
      toast.error(msg)
      void q.refetch()
    }
  })

  if (!fixable || finding.status === 'resolved') return null
  const p = q.data

  return (
    <section className='grid gap-2' aria-labelledby={`fix-${finding.id}`}>
      <div className='flex flex-wrap items-center gap-2'>
        <h3 id={`fix-${finding.id}`} className='m-0 text-[12.5px] font-semibold'>
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

      {p?.proposable && !outcome?.applied && (
        <div className='grid gap-2'>
          <p className='m-0 text-[12.5px] text-foreground/90'>
            {p.class === 'xact-abort'
              ? 'Adds SET XACT_ABORT ON as the first statement, so a failed statement rolls the whole transaction back.'
              : 'Makes the nullable key comparisons NULL-safe, so a row with an empty key matches its stored row instead of being inserted again.'}{' '}
            {p.deploys
              ? 'The procedure is changed in the database and checked again at once; if the check finds anything new, the previous version goes back automatically.'
              : 'Only the stored body changes; deploy it from the import definition when you are ready.'}
          </p>

          <p
            className={cn(
              'm-0 flex items-center gap-1.5 text-[12px]',
              p.compile?.ok
                ? 'text-emerald-700 dark:text-emerald-400'
                : 'text-red-600 dark:text-red-400'
            )}
          >
            {p.compile?.ok ? (
              <CheckCircle2 className='h-3.5 w-3.5' aria-hidden='true' />
            ) : (
              <XCircle className='h-3.5 w-3.5' aria-hidden='true' />
            )}
            {p.compile?.ok
              ? p.compile.skipped
                ? 'Compile check skipped on this database.'
                : 'Compiles (checked in a transaction that was rolled back).'
              : `Does not compile: ${p.compile?.error ?? 'unknown error'}`}
          </p>

          {p.risky && (
            <div
              role='alert'
              className='grid gap-1.5 rounded-md border border-amber-300 bg-amber-50 p-3 text-[12.5px] text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200'
            >
              <p className='m-0 flex items-center gap-1.5 font-semibold'>
                <AlertTriangle className='h-3.5 w-3.5' aria-hidden='true' /> Check this first
              </p>
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
                  onCheckedChange={(v) => setConfirmed(v === true)}
                />
                I’ve checked the source has one row per key and the copies are dealt with
              </label>
            </div>
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
                !p.compile?.ok ||
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
                setConfirmed(false)
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {outcome && (
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
      )}
    </section>
  )
}
