import { type ManagedUser, setMyDelegate } from '@nivaro/sdk'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Check, Loader2, Undo2, UserRound } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNivaroClient } from '../../context'
import { get, patch, post } from '../../lib/commands'
import { cn } from '../../lib/utils'
import { RelationCombobox } from '../item-edit/RelationCombobox'
import { Field, PersonChip, SectionCard, Toggle } from './primitives'

// ── Out of office / delegation ───────────────────────────────────────────────

export function DelegationCard({
  user,
  onSaved,
  forUser,
  coversFor
}: {
  user: ManagedUser & { ooo_start?: string | null; ooo_end?: string | null }
  onSaved: () => void
  /** Set when an admin edits SOMEONE ELSE's delegation — saves go through the
   *  admin routes and the copy names the person instead of "you". */
  forUser?: { id: string; firstName: string }
  /** People currently routing their work to this person. */
  coversFor?: Array<{ id: string; name: string; email?: string | null }>
}) {
  const who = forUser?.firstName ?? null
  const client = useNivaroClient()
  const [ooo, setOoo] = useState(!!user.is_out_of_office)
  const [exposure, setExposure] = useState<{
    owned_open_records: number
    sla_escalations: number
  } | null>(null)
  const [delegate, setDelegate] = useState<string | null>(user.delegate_id ?? null)
  const [expires, setExpires] = useState(
    user.delegate_expires_at ? String(user.delegate_expires_at).slice(0, 10) : ''
  )
  const u = user as ManagedUser & { ooo_start?: string | null; ooo_end?: string | null }
  const [oooStart, setOooStart] = useState(u.ooo_start ? String(u.ooo_start).slice(0, 10) : '')
  const [oooEnd, setOooEnd] = useState(u.ooo_end ? String(u.ooo_end).slice(0, 10) : '')
  const dirty =
    ooo !== !!user.is_out_of_office ||
    (delegate ?? null) !== (user.delegate_id ?? null) ||
    expires !== (user.delegate_expires_at ? String(user.delegate_expires_at).slice(0, 10) : '') ||
    oooStart !== (u.ooo_start ? String(u.ooo_start).slice(0, 10) : '') ||
    oooEnd !== (u.ooo_end ? String(u.ooo_end).slice(0, 10) : '')

  // Pre-OOO exposure: what nothing will cover while you're out. Fetched
  // lazily — only when OOO is being enabled (or scheduled) with no delegate,
  // because owner resolution costs seconds, not milliseconds.
  const goingOooUncovered = (ooo || (!!oooStart && !!oooEnd)) && !delegate
  useEffect(() => {
    if (!goingOooUncovered || forUser) {
      setExposure(null)
      return
    }
    let cancelled = false
    client
      .request<{ data: { owned_open_records: number; sla_escalations: number } }>(
        get('/users/me/ooo-exposure')
      )
      .then((r) => {
        if (!cancelled) setExposure(r.data)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [goingOooUncovered, client, forUser])

  // Delegation preview (#414): what the delegate would inherit, fetched when
  // a delegate is picked while going OOO.
  const { data: delegatePreview } = useQuery<{
    approx_open_approvals: number
    coverage_warnings: string[]
  }>({
    queryKey: ['delegate-preview'],
    queryFn: () =>
      client
        .request<{ data: { approx_open_approvals: number; coverage_warnings: string[] } }>(
          get('/users/me/delegate-preview')
        )
        .then((r) => r.data),
    enabled: !forUser && !!delegate && (ooo || (!!oooStart && !!oooEnd)),
    staleTime: 60_000
  })
  const [saveWarnings, setSaveWarnings] = useState<string[]>([])

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        is_out_of_office: ooo,
        delegate_id: delegate,
        delegate_expires_at: expires ? new Date(`${expires}T23:59:59`).toISOString() : null,
        // Scheduled window — the ooo-schedule cron flips the toggle on
        // entry and clears it (and the window) when it passes.
        ooo_start: oooStart ? new Date(`${oooStart}T00:00:00`).toISOString() : null,
        ooo_end: oooEnd ? new Date(`${oooEnd}T23:59:59`).toISOString() : null
      }
      if (!forUser) return client.request(setMyDelegate(body))
      // Admin path: the delegation route validates the delegate and hands
      // open tasks over; the window rides the plain user PATCH.
      const res = await client.request(
        post(`/delegation/${forUser.id}/delegate`, {
          is_out_of_office: body.is_out_of_office,
          delegate_id: body.delegate_id,
          delegate_expires_at: body.delegate_expires_at
        })
      )
      await client.request(
        patch(`/users/${forUser.id}`, { ooo_start: body.ooo_start, ooo_end: body.ooo_end })
      )
      return res
    },
    onSuccess: (res) => {
      // OOO conflict warnings (#338): the save reports teams this window guts.
      const warnings = (res as { warnings?: string[] })?.warnings ?? []
      setSaveWarnings(warnings)
      onSaved()
    }
  })

  const reset = () => {
    setOoo(!!user.is_out_of_office)
    setDelegate(user.delegate_id ?? null)
    setExpires(user.delegate_expires_at ? String(user.delegate_expires_at).slice(0, 10) : '')
    setOooStart(u.ooo_start ? String(u.ooo_start).slice(0, 10) : '')
    setOooEnd(u.ooo_end ? String(u.ooo_end).slice(0, 10) : '')
  }

  const untilLabel = expires
    ? new Date(`${expires}T12:00:00`).toLocaleDateString(undefined, {
        month: 'long',
        day: 'numeric'
      })
    : null

  return (
    <SectionCard
      icon={<UserRound className='h-4 w-4' />}
      title='Out of office'
      hint={
        who
          ? `Route ${who}'s approvals to a delegate while they are away`
          : 'Route your approvals to a delegate while you are away'
      }
      actions={
        dirty && (
          <span className='flex items-center gap-1.5'>
            <button
              type='button'
              title='Discard changes'
              onClick={reset}
              className='inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11.5px] font-medium text-slate-400 transition-colors hover:text-slate-600 dark:hover:text-slate-200'
            >
              <Undo2 className='h-3 w-3' /> Reset
            </button>
            <button
              type='button'
              disabled={save.isPending}
              onClick={() => save.mutate()}
              className='inline-flex h-7 items-center gap-1 rounded-md bg-nvr-cyan px-2.5 text-[11.5px] font-semibold text-white transition-opacity disabled:opacity-50'
            >
              {save.isPending ? (
                <Loader2 className='h-3 w-3 animate-spin' />
              ) : (
                <Check className='h-3 w-3' />
              )}{' '}
              Save
            </button>
          </span>
        )
      }
    >
      {/* State first: one clear switch line, config below it. */}
      <div className='flex items-center justify-between gap-3'>
        <span className='text-[12.5px] font-medium text-slate-700 dark:text-slate-200'>
          {who ? `${who} is out of office` : "I'm out of office"}
        </span>
        <Toggle
          on={ooo}
          onChange={() => setOoo((v) => !v)}
          label={who ? `${who} is out of office` : "I'm out of office"}
          tone='amber'
        />
      </div>

      {goingOooUncovered &&
        exposure &&
        exposure.owned_open_records + exposure.sla_escalations > 0 && (
          <div className='mt-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300'>
            <span className='font-semibold'>No delegate is set.</span> While you're out,{' '}
            {exposure.owned_open_records > 0 && (
              <>
                <span className='font-semibold'>{exposure.owned_open_records}</span> open record
                {exposure.owned_open_records === 1 ? '' : 's'} you own
              </>
            )}
            {exposure.owned_open_records > 0 && exposure.sla_escalations > 0 && ' and '}
            {exposure.sla_escalations > 0 && (
              <>
                <span className='font-semibold'>{exposure.sla_escalations}</span> SLA escalation
                rule
                {exposure.sla_escalations === 1 ? '' : 's'} that page you
              </>
            )}{' '}
            will have nobody covering them. Pick a delegate below.
          </div>
        )}

      {/* Delegation preview (#414) */}
      {delegate && delegatePreview && (
        <div className='mt-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-[12px] text-slate-600 dark:border-border dark:bg-muted/40 dark:text-slate-300'>
          Your delegate would inherit roughly{' '}
          <b className='tabular-nums'>{delegatePreview.approx_open_approvals}</b> open approval
          {delegatePreview.approx_open_approvals === 1 ? '' : 's'} while you're out.
        </div>
      )}
      {/* OOO conflict warnings (#338) — reported by the save */}
      {saveWarnings.length > 0 && (
        <div className='mt-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300'>
          <p className='font-semibold'>Coverage warning{saveWarnings.length === 1 ? '' : 's'}:</p>
          <ul className='mt-0.5 list-disc pl-4'>
            {saveWarnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      )}
      <div className='mt-3 grid gap-3 border-t border-slate-100 pt-3 dark:border-border/60 sm:grid-cols-2'>
        <div>
          <span className='mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400'>
            Delegate
          </span>
          <RelationCombobox
            collection='nivaro_users'
            value={delegate}
            onChange={(v) => setDelegate(v == null ? null : String(v))}
            placeholder='Pick a delegate…'
          />
        </div>
        {/* Plan it ahead: the toggle flips on/off automatically inside this
            window, so nobody has to remember on the morning they leave. */}
        <Field
          label='Out from'
          hint='schedule ahead'
          type='date'
          value={oooStart}
          onChange={setOooStart}
        />
        <Field
          label='Out until'
          hint='auto-clears after'
          type='date'
          value={oooEnd}
          onChange={setOooEnd}
        />
        {/* h-9 matches the RelationCombobox trigger beside it */}
        <Field
          label='Until'
          hint='optional'
          type='date'
          value={expires}
          onChange={setExpires}
          inputClassName='h-9'
        />
      </div>

      <p
        className={cn(
          'mt-3 text-[11.5px] leading-relaxed',
          ooo && !delegate
            ? 'rounded-md bg-amber-50 px-2.5 py-1.5 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400'
            : 'text-slate-400 dark:text-slate-500'
        )}
      >
        {ooo && !delegate
          ? who
            ? `No delegate picked — approvals will wait for ${who} until they return.`
            : 'No delegate picked — approvals will wait for you until you return.'
          : ooo
            ? `Workflow ownership and approvals route to ${who ? `${who}'s` : 'your'} delegate${untilLabel ? ` through ${untilLabel}` : ` until ${who ? 'this is' : 'you turn this'} off`}.`
            : `When enabled, workflow ownership and approvals resolve to ${who ? `${who}'s` : 'your'} delegate.`}
      </p>
      {coversFor && coversFor.length > 0 && (
        <div className='mt-3 border-t border-slate-100 pt-3 dark:border-border/60'>
          <p className='mb-1.5 text-[11px] font-medium uppercase tracking-wide text-slate-400'>
            Covers for
          </p>
          <div className='flex flex-wrap gap-x-4 gap-y-1.5' data-person-covers>
            {coversFor.map((c) => (
              <PersonChip key={c.id} person={c} />
            ))}
          </div>
        </div>
      )}
    </SectionCard>
  )
}
