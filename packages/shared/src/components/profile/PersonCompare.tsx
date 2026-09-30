import { useQueryClient } from '@tanstack/react-query'
import { ArrowRight, Copy, GitCompareArrows, Loader2 } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../context'
import { post } from '../../lib/commands'
import { cn } from '../../lib/utils'
import { UserPicker } from './PersonAdminTools'
import { ConfirmButton, EmptyLine, SectionCard } from './primitives'
import { errorText, type PersonProfile, useInvalidatePerson, usePersonProfile } from './types'

// Mirror of services/people-access.ts AccessCopyPlan.
interface ScopeChange {
  dimension: string
  label: string
  mode: 'default' | 'restrict'
  current: Array<{ id: string | number; label: string }>
  proposed: Array<{ id: string | number; label: string }>
}
interface CopyPlan {
  from: { id: string; name: string }
  to: { id: string; name: string }
  role: {
    current: { id: string | null; name: string | null }
    proposed: { id: string | null; name: string | null }
    grants_admin: boolean
  } | null
  scopes: ScopeChange[]
  teams: {
    add: Array<{ id: number; name: string }>
    keeps: Array<{ id: number; name: string }>
  } | null
  empty: boolean
  applied?: boolean
}
interface Impact {
  collection: string
  current: number
  proposed: number
  gained: number
  lost: number
}

const list = (v: string[]) => (v.length ? v.join(', ') : '—')

/**
 * #637 — put someone beside another person: role, scopes, teams and approval
 * seats side by side, differences marked. "Copy access from" makes this
 * person's role and scopes match the other one's and adds the other's teams
 * (never removes a team). The plan is always shown first, with what each
 * scope change does to what they can see; applying rebuilds it server-side.
 */
export function CompareAccessCard({ profile: p }: { profile: PersonProfile }) {
  const [other, setOther] = useState<{ id: string; name: string } | null>(null)
  const { data: o, isLoading } = usePersonProfile(other?.id ?? null)
  const first = p.first_name ?? p.name

  return (
    <SectionCard
      icon={<GitCompareArrows className='h-4 w-4' />}
      title='Compare access'
      hint={other ? undefined : `Put ${first} beside someone else — onboarding a replacement`}
      testId='compare-access'
    >
      <div className='mb-3 flex flex-wrap items-center gap-2 text-[12.5px] text-slate-600 dark:text-slate-300'>
        <span>Compare with</span>
        <UserPicker
          excludeId={p.id}
          value={other}
          label='Search people…'
          onPick={(u) => setOther(u)}
        />
      </div>
      {!other ? (
        <EmptyLine>Pick a person to see where their access differs from {first}'s.</EmptyLine>
      ) : isLoading || !o ? (
        <div className='h-24 animate-pulse rounded bg-slate-100 dark:bg-muted' aria-busy />
      ) : (
        <>
          <CompareTable a={p} b={o} />
          <CopyAccessPanel target={p} source={o} />
        </>
      )}
    </SectionCard>
  )
}

function CompareTable({ a, b }: { a: PersonProfile; b: PersonProfile }) {
  const dims = [...new Map([...a.scopes, ...b.scopes].map((s) => [s.dimension, s.label]))]
  const scopeOf = (p: PersonProfile, d: string) =>
    [...(p.scopes.find((s) => s.dimension === d)?.values ?? [])].sort()
  const rows: Array<{
    key: string
    label: string
    left: ReactNode
    right: ReactNode
    same: boolean
  }> = [
    {
      key: 'role',
      label: 'Role',
      left: a.role_name ?? '—',
      right: b.role_name ?? '—',
      same: (a.role_id ?? '') === (b.role_id ?? '')
    },
    ...dims.map(([d, label]) => {
      const l = scopeOf(a, d)
      const r = scopeOf(b, d)
      return {
        key: `scope:${d}`,
        label: `${label} (limited to)`,
        left: l.length ? list(l) : 'Everything',
        right: r.length ? list(r) : 'Everything',
        same: l.join('|') === r.join('|')
      }
    }),
    (() => {
      const l = a.teams.map((t) => t.name).sort()
      const r = b.teams.map((t) => t.name).sort()
      return {
        key: 'teams',
        label: 'Teams',
        left: list(l),
        right: list(r),
        same: l.join('|') === r.join('|')
      }
    })(),
    (() => {
      const seats = (p: PersonProfile) =>
        p.seats.map((s) => `${s.template_name} (${s.states.map((x) => x.label).join(', ')})`).sort()
      const l = seats(a)
      const r = seats(b)
      return {
        key: 'seats',
        label: 'Approval seats',
        left: list(l),
        right: list(r),
        same: l.join('|') === r.join('|')
      }
    })()
  ]
  const differing = rows.filter((r) => !r.same).length
  return (
    <div className='overflow-x-auto'>
      <table className='w-full text-[12px]' data-compare-access-table>
        <thead>
          <tr className='text-left text-[10.5px] uppercase tracking-wide text-slate-400'>
            <th className='py-1 pr-3 font-medium'> </th>
            <th className='py-1 pr-3 font-medium'>{a.first_name ?? a.name}</th>
            <th className='py-1 font-medium'>{b.first_name ?? b.name}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.key}
              data-compare-row={r.key}
              data-compare-same={r.same ? 'yes' : 'no'}
              className='border-t border-slate-100 align-top dark:border-border/60'
            >
              <td className='py-1.5 pr-3 font-medium text-slate-500 dark:text-slate-400'>
                {r.label}
              </td>
              <td className={cn('py-1.5 pr-3', !r.same && 'text-amber-800 dark:text-amber-200')}>
                {r.left}
              </td>
              <td className={cn('py-1.5', !r.same && 'text-amber-800 dark:text-amber-200')}>
                {r.right}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className='mt-1.5 text-[11.5px] text-slate-500 dark:text-slate-400' data-compare-summary>
        {differing === 0
          ? 'Same role, scopes, teams and approval seats.'
          : `${differing} difference${differing === 1 ? '' : 's'}. Approval seats are not copied; they come from owner groups.`}
      </p>
    </div>
  )
}

function CopyAccessPanel({ target, source }: { target: PersonProfile; source: PersonProfile }) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const invalidate = useInvalidatePerson(target.id)
  const [include, setInclude] = useState({ role: true, scopes: true, teams: true })
  const [plan, setPlan] = useState<CopyPlan | null>(null)
  const [impacts, setImpacts] = useState<Record<string, Impact | null>>({})
  const [busy, setBusy] = useState<'preview' | 'apply' | null>(null)
  const firstT = target.first_name ?? target.name
  const firstS = source.first_name ?? source.name

  async function preview() {
    setBusy('preview')
    setPlan(null)
    setImpacts({})
    try {
      const r = await client.request<{ data: CopyPlan }>(
        post(`/users/${target.id}/copy-access`, { from: source.id, include, dry_run: true })
      )
      setPlan(r.data)
      // What each restrict change does to what they can see — the same
      // preview the Scopes card shows before a save.
      const next: Record<string, Impact | null> = {}
      await Promise.all(
        r.data.scopes
          .filter((c) => c.mode === 'restrict')
          .map(async (c) => {
            next[c.dimension] = await client
              .request<{ data: { impact: Impact[] } }>(
                post(`/user-scopes/${target.id}/impact`, {
                  dimension: c.dimension,
                  values: c.proposed.map((v) => v.id)
                })
              )
              .then((x) => x.data.impact[0] ?? null)
              .catch(() => null)
          })
      )
      setImpacts(next)
    } catch (err) {
      toast.error(errorText(err, 'Could not build the plan'))
    } finally {
      setBusy(null)
    }
  }

  async function apply() {
    setBusy('apply')
    try {
      await client.request(
        post(`/users/${target.id}/copy-access`, { from: source.id, include, dry_run: false })
      )
      toast.success(`${firstT} now has ${firstS}'s access`)
      setPlan(null)
      invalidate()
      void qc.invalidateQueries({ queryKey: ['nvr-user-scopes', target.id] })
    } catch (err) {
      toast.error(errorText(err, 'Could not copy access'))
    } finally {
      setBusy(null)
    }
  }

  const box = (key: keyof typeof include, label: string) => (
    <label className='inline-flex items-center gap-1.5 text-[12px] text-slate-600 dark:text-slate-300'>
      <input
        type='checkbox'
        data-copy-access-include={key}
        checked={include[key]}
        onChange={(e) => {
          setInclude((v) => ({ ...v, [key]: e.target.checked }))
          setPlan(null)
        }}
      />
      {label}
    </label>
  )

  return (
    <div className='mt-4 border-t border-slate-100 pt-3 dark:border-border/60' data-copy-access>
      <p className='text-[12.5px] font-semibold text-slate-800 dark:text-slate-100'>
        Copy access from {firstS}
      </p>
      <div className='mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5'>
        {box('role', 'Role')}
        {box('scopes', 'Scopes')}
        {box('teams', 'Teams (adds only)')}
        <button
          type='button'
          data-copy-access-preview
          disabled={busy != null || (!include.role && !include.scopes && !include.teams)}
          onClick={preview}
          className='inline-flex h-7 items-center gap-1 rounded-md border border-slate-200 px-2.5 text-[12px] font-medium text-slate-700 hover:bg-muted disabled:opacity-50 dark:border-border dark:text-slate-200'
        >
          {busy === 'preview' ? (
            <Loader2 className='h-3.5 w-3.5 animate-spin' />
          ) : (
            <Copy className='h-3.5 w-3.5' />
          )}
          Preview
        </button>
      </div>

      {plan &&
        (plan.empty ? (
          <p
            className='mt-3 text-[12px] text-slate-500 dark:text-slate-400'
            data-copy-access-plan='empty'
          >
            Nothing to change: {firstT} already matches {firstS} on what you picked.
          </p>
        ) : (
          <div className='mt-3 space-y-2' data-copy-access-plan>
            <ul className='space-y-1.5 text-[12px]'>
              {plan.role && (
                <li data-copy-access-change='role' className='flex flex-wrap items-center gap-1.5'>
                  <span className='font-medium text-slate-500'>Role</span>
                  <span>{plan.role.current.name ?? '—'}</span>
                  <ArrowRight className='h-3 w-3 text-slate-400' />
                  <span className='font-medium'>{plan.role.proposed.name ?? '—'}</span>
                  {plan.role.grants_admin && (
                    <span className='rounded bg-red-50 px-1.5 text-[11px] font-semibold text-red-700 dark:bg-red-500/10 dark:text-red-300'>
                      grants admin access
                    </span>
                  )}
                </li>
              )}
              {plan.scopes.map((c) => {
                const imp = impacts[c.dimension]
                return (
                  <li
                    key={`${c.dimension}:${c.mode}`}
                    data-copy-access-change={`scope:${c.dimension}:${c.mode}`}
                  >
                    <span className='flex flex-wrap items-center gap-1.5'>
                      <span className='font-medium text-slate-500'>
                        {c.label} {c.mode === 'restrict' ? 'limit' : 'default filter'}
                      </span>
                      <span>
                        {c.current.length ? c.current.map((v) => v.label).join(', ') : 'none'}
                      </span>
                      <ArrowRight className='h-3 w-3 text-slate-400' />
                      <span className='font-medium'>
                        {c.proposed.length ? c.proposed.map((v) => v.label).join(', ') : 'none'}
                      </span>
                    </span>
                    {imp && (
                      <span
                        className='block text-[11.5px] text-slate-500 dark:text-slate-400'
                        data-copy-access-impact
                      >
                        {imp.collection}: {imp.current.toLocaleString()} →{' '}
                        {imp.proposed.toLocaleString()} visible
                        {imp.gained ? ` · +${imp.gained.toLocaleString()}` : ''}
                        {imp.lost ? ` · −${imp.lost.toLocaleString()}` : ''}
                      </span>
                    )}
                  </li>
                )
              })}
              {plan.teams && plan.teams.add.length > 0 && (
                <li data-copy-access-change='teams'>
                  <span className='font-medium text-slate-500'>Join teams</span>{' '}
                  {plan.teams.add.map((t) => t.name).join(', ')}
                  {plan.teams.keeps.length > 0 && (
                    <span className='block text-[11.5px] text-slate-500 dark:text-slate-400'>
                      Stays in {plan.teams.keeps.map((t) => t.name).join(', ')}
                    </span>
                  )}
                </li>
              )}
            </ul>
            <ConfirmButton
              onConfirm={apply}
              disabled={busy != null}
              confirmLabel={`Yes, change ${firstT}'s access`}
              className='inline-flex h-8 items-center gap-1.5 rounded-md bg-nvr-cyan px-3 text-[12px] font-semibold text-white hover:opacity-90 disabled:opacity-60'
              armedClassName='!bg-amber-600'
            >
              {busy === 'apply' ? <Loader2 className='h-3.5 w-3.5 animate-spin' /> : null}
              Apply to {firstT}
            </ConfirmButton>
          </div>
        ))}
    </div>
  )
}
