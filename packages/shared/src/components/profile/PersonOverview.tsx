import { useMutation } from '@tanstack/react-query'
import {
  BriefcaseBusiness,
  CalendarClock,
  Check,
  ClipboardList,
  Loader2,
  Pencil,
  ShieldCheck,
  Undo2,
  UserRound,
  Users,
  X
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { useNavigation, useNivaroClient } from '../../context'
import { patch } from '../../lib/commands'
import { cn, formatDate, formatRelative } from '../../lib/utils'
import { RelationCombobox } from '../item-edit/RelationCombobox'
import {
  EmptyLine,
  Field,
  Meta,
  MetaGrid,
  PersonChip,
  Pill,
  SectionCard,
  usePersonUrl
} from './primitives'
import { errorText, type PersonProfile, useInvalidatePerson } from './types'

const dateLong = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString(undefined, {
        month: 'long',
        day: 'numeric',
        year: 'numeric'
      })
    : null

/** The fields an admin edits in place on the About card. */
type AboutDraft = {
  first_name: string
  last_name: string
  title: string
  department: string
  company: string
  phone: string
  manager_id: string | null
}

export function AboutCard({ profile: p, isAdmin }: { profile: PersonProfile; isAdmin: boolean }) {
  const client = useNivaroClient()
  const invalidate = useInvalidatePerson(p.id)
  const base = useMemo<AboutDraft>(
    () => ({
      first_name: p.first_name ?? '',
      last_name: p.last_name ?? '',
      title: p.title ?? '',
      department: p.department ?? '',
      company: p.company ?? '',
      phone: p.phone ?? '',
      manager_id: p.manager?.id ?? null
    }),
    [p]
  )
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<AboutDraft | null>(null)
  const d = draft ?? base
  const dirty = JSON.stringify(d) !== JSON.stringify(base)
  const save = useMutation({
    mutationFn: () =>
      client.request(
        patch(`/users/${p.id}`, {
          first_name: d.first_name || null,
          last_name: d.last_name || null,
          title: d.title || null,
          department: d.department || null,
          company: d.company || null,
          phone: d.phone || null,
          manager_id: d.manager_id
        })
      ),
    onSuccess: () => {
      setDraft(null)
      setEditing(false)
      invalidate()
      toast.success('Details saved')
    },
    onError: (e) => toast.error(errorText(e, 'Could not save'))
  })

  return (
    <SectionCard
      icon={<UserRound className='h-4 w-4' />}
      title='About'
      hint={isAdmin ? 'Directory fields win on their next sign-in' : undefined}
      testId='about'
      actions={
        isAdmin &&
        (editing ? (
          <span className='flex items-center gap-1.5'>
            <button
              type='button'
              onClick={() => {
                setDraft(null)
                setEditing(false)
              }}
              className='inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11.5px] font-medium text-slate-400 transition-colors hover:text-slate-600 dark:hover:text-slate-200'
            >
              {dirty ? <Undo2 className='h-3 w-3' /> : <X className='h-3 w-3' />}
              {dirty ? 'Discard' : 'Close'}
            </button>
            <button
              type='button'
              disabled={!dirty || save.isPending}
              onClick={() => save.mutate()}
              data-person-about-save
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
        ) : (
          <button
            type='button'
            data-person-about-edit
            onClick={() => setEditing(true)}
            className='inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11.5px] font-medium text-slate-500 transition-colors hover:bg-slate-50 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-muted dark:hover:text-slate-100'
          >
            <Pencil className='h-3 w-3' /> Edit
          </button>
        ))
      }
    >
      {editing ? (
        <div className='grid gap-3 sm:grid-cols-2'>
          <Field
            label='First name'
            value={d.first_name}
            onChange={(v) => setDraft({ ...d, first_name: v })}
          />
          <Field
            label='Last name'
            value={d.last_name}
            onChange={(v) => setDraft({ ...d, last_name: v })}
          />
          <Field label='Title' value={d.title} onChange={(v) => setDraft({ ...d, title: v })} />
          <Field
            label='Department'
            value={d.department}
            onChange={(v) => setDraft({ ...d, department: v })}
          />
          <Field
            label='Company'
            value={d.company}
            onChange={(v) => setDraft({ ...d, company: v })}
          />
          <Field
            label='Phone'
            value={d.phone}
            type='tel'
            onChange={(v) => setDraft({ ...d, phone: v })}
          />
          <div className='sm:col-span-2'>
            <span className='mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400'>
              Reports to
            </span>
            <RelationCombobox
              collection='nivaro_users'
              value={d.manager_id}
              onChange={(v) => setDraft({ ...d, manager_id: v == null ? null : String(v) })}
              placeholder='Pick a manager…'
            />
          </div>
          <Field label='Email' value={p.email} disabled hint='set by sign-in' />
        </div>
      ) : (
        <MetaGrid cols={3}>
          <Meta label='Title'>{p.title ?? '—'}</Meta>
          <Meta label='Department'>{p.department ?? '—'}</Meta>
          <Meta label='Company'>{p.company ?? '—'}</Meta>
          <Meta label='Office'>{p.office_location ?? '—'}</Meta>
          <Meta label='Phone'>
            {p.phone ? (
              <a href={`tel:${p.phone}`} className='hover:underline'>
                {p.phone}
              </a>
            ) : (
              '—'
            )}
          </Meta>
          <Meta label='Reports to'>{p.manager ? <PersonChip person={p.manager} /> : '—'}</Meta>
          {p.timezone && <Meta label='Time zone'>{p.timezone}</Meta>}
          <Meta label='Member since'>{p.created_at ? formatDate(p.created_at) : '—'}</Meta>
          <Meta label='Last active'>
            {p.last_access ? formatRelative(p.last_access) : 'Never signed in'}
          </Meta>
          {isAdmin && p.admin && (
            <>
              <Meta label='Employee id'>
                {p.admin.employee_id ? (
                  <span className='font-mono text-[12px]'>{p.admin.employee_id}</span>
                ) : (
                  '—'
                )}
              </Meta>
              <Meta label='Location'>
                {[p.admin.city, p.admin.state, p.admin.country].filter(Boolean).join(', ') || '—'}
              </Meta>
              <Meta label='Signs in via'>
                {p.admin.external_id ? 'Microsoft sign-in' : 'Not linked to a directory account'}
              </Meta>
            </>
          )}
        </MetaGrid>
      )}
    </SectionCard>
  )
}

/** Read-only availability — what a colleague needs to know before they wait on someone. */
export function AvailabilityCard({ profile: p }: { profile: PersonProfile }) {
  const out = p.is_out_of_office
  const until = dateLong(p.ooo_end)
  const from = dateLong(p.ooo_start)
  const scheduled = !out && p.ooo_start && new Date(p.ooo_start).getTime() > Date.now()
  const first = p.first_name ?? p.name
  return (
    <SectionCard
      icon={<CalendarClock className='h-4 w-4' />}
      title='Availability'
      testId='availability'
    >
      <div
        data-person-availability={out ? 'out' : scheduled ? 'scheduled' : 'available'}
        className={cn(
          'flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md px-3 py-2 text-[12.5px]',
          out
            ? 'bg-amber-50 text-amber-800 dark:bg-amber-500/10 dark:text-amber-300'
            : 'bg-emerald-50 text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300'
        )}
      >
        <span className='font-semibold'>
          {out ? `Out of office${until ? ` until ${until}` : ''}` : 'Available'}
        </span>
        {scheduled && from && (
          <span className='text-[12px] opacity-80'>
            Out from {from}
            {until ? ` to ${until}` : ''}
          </span>
        )}
      </div>

      <dl className='mt-3 space-y-2.5'>
        <div className='flex flex-wrap items-center gap-x-3 gap-y-1'>
          <dt className='w-[104px] shrink-0 text-[11px] font-medium uppercase tracking-wide text-slate-400'>
            Approvals go to
          </dt>
          <dd className='min-w-0'>
            {p.delegate ? (
              <span className='flex flex-wrap items-center gap-2'>
                <PersonChip person={p.delegate} />
                {p.delegate.expires_at && (
                  <span className='text-[11.5px] text-slate-400'>
                    through {dateLong(p.delegate.expires_at)}
                  </span>
                )}
                {!out && <span className='text-[11.5px] text-slate-400'>(only while out)</span>}
              </span>
            ) : out ? (
              <span className='text-[12.5px] text-amber-700 dark:text-amber-300'>
                Nobody — approvals wait for {first}
                {p.manager
                  ? '; try their manager'
                  : p.manager_external?.name
                    ? `; try their manager, ${p.manager_external.name}`
                    : ''}
              </span>
            ) : (
              <span className='text-[12.5px] text-slate-500 dark:text-slate-400'>
                {first} directly
              </span>
            )}
          </dd>
        </div>
        {p.covers_for.length > 0 && (
          <div className='flex flex-wrap items-start gap-x-3 gap-y-1'>
            <dt className='w-[104px] shrink-0 pt-0.5 text-[11px] font-medium uppercase tracking-wide text-slate-400'>
              Covers for
            </dt>
            <dd className='flex min-w-0 flex-wrap gap-x-4 gap-y-1.5' data-person-covers>
              {p.covers_for.map((c) => (
                <PersonChip key={c.id} person={c} />
              ))}
            </dd>
          </div>
        )}
      </dl>
    </SectionCard>
  )
}

export function PeopleCard({ profile: p }: { profile: PersonProfile }) {
  const nav = useNavigation()
  const teamsHref = nav.consoleUrl ? nav.consoleUrl('/user-groups') : '/user-groups'
  const hasChain = p.org_chain.length > 0 || !!p.manager_external
  if (p.direct_reports.length === 0 && p.teams.length === 0 && !hasChain && p.peers.length === 0) {
    return (
      <SectionCard icon={<Users className='h-4 w-4' />} title='People' testId='people'>
        <EmptyLine>No manager on file, no direct reports and not on a team yet.</EmptyLine>
      </SectionCard>
    )
  }
  return (
    <SectionCard icon={<Users className='h-4 w-4' />} title='People' testId='people'>
      {hasChain && (
        <div className='mb-4'>
          <p className='mb-1.5 text-[11px] font-medium uppercase tracking-wide text-slate-400'>
            Reports up through
          </p>
          <OrgChain profile={p} />
        </div>
      )}
      {p.peers.length > 0 && (
        <div className='mb-4'>
          <p className='mb-1.5 text-[11px] font-medium uppercase tracking-wide text-slate-400'>
            Same manager · {p.peers.length}
          </p>
          <ul className='flex flex-wrap items-center gap-x-4 gap-y-1.5' data-person-peers>
            {p.peers.map((r) => (
              <li key={r.id}>
                <PersonChip person={r} />
              </li>
            ))}
          </ul>
        </div>
      )}
      {p.teams.length > 0 && (
        <div>
          <p className='mb-1.5 text-[11px] font-medium uppercase tracking-wide text-slate-400'>
            Teams
          </p>
          <div className='flex flex-wrap gap-1.5' data-person-teams>
            {p.teams.map((t) =>
              teamsHref ? (
                <a
                  key={t.id}
                  href={teamsHref}
                  onClick={(e) => {
                    if (e.metaKey || e.ctrlKey) return
                    e.preventDefault()
                    nav.navigate(teamsHref)
                  }}
                  className='inline-flex items-center gap-1.5 rounded-full border border-slate-200 px-2.5 py-0.5 text-[11.5px] font-medium text-slate-700 transition-colors hover:border-nvr-cyan hover:text-nvr-navy dark:border-border dark:text-slate-200 dark:hover:text-nvr-cyan'
                >
                  {t.name}
                  <span className='text-[10.5px] text-slate-400'>{t.member_count}</span>
                </a>
              ) : (
                <span
                  key={t.id}
                  className='inline-flex items-center gap-1.5 rounded-full border border-slate-200 px-2.5 py-0.5 text-[11.5px] font-medium text-slate-700 dark:border-border dark:text-slate-200'
                >
                  {t.name}
                  <span className='text-[10.5px] text-slate-400'>{t.member_count}</span>
                </span>
              )
            )}
          </div>
        </div>
      )}
      {p.direct_reports.length > 0 && (
        <div className={cn(p.teams.length > 0 && 'mt-4')}>
          <p className='mb-1.5 text-[11px] font-medium uppercase tracking-wide text-slate-400'>
            Direct reports · {p.direct_reports.length}
          </p>
          <ul className='grid gap-x-6 gap-y-2 sm:grid-cols-2' data-person-reports>
            {p.direct_reports.map((r) => (
              <li key={r.id}>
                <PersonChip person={r} meta={r.title ?? r.email ?? undefined} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </SectionCard>
  )
}

/**
 * The chain from this person upward — each link a chip, the person themself
 * as the anchor, an external (directory-only) manager as the last, plain link.
 */
function OrgChain({ profile: p }: { profile: PersonProfile }) {
  return (
    <ol className='flex flex-wrap items-center gap-x-1 gap-y-1.5' data-person-org-chain>
      <li className='inline-flex items-center gap-1.5 rounded-md bg-[#00ceff1a] px-2 py-0.5 text-[12px] font-semibold text-nvr-navy dark:text-nvr-cyan'>
        {p.first_name ?? p.name}
      </li>
      {p.org_chain.map((m) => (
        <li key={m.id} className='inline-flex items-center gap-1'>
          <span className='text-slate-300 dark:text-slate-600' aria-hidden>
            →
          </span>
          <PersonChip person={m} meta={m.title ?? undefined} />
        </li>
      ))}
      {p.org_chain.length === 0 && p.manager_external && (
        <li className='inline-flex items-center gap-1'>
          <span className='text-slate-300 dark:text-slate-600' aria-hidden>
            →
          </span>
          <span className='text-[12.5px] font-medium text-slate-700 dark:text-slate-200'>
            {p.manager_external.name ?? p.manager_external.email}
          </span>
          <span className='text-[11px] text-slate-400'>(not a Nivaro user)</span>
        </li>
      )}
    </ol>
  )
}

/** Where this person's decisions land: approval seats, scopes, open tasks. */
export function ResponsibilitiesCard({
  profile: p,
  isAdmin
}: {
  profile: PersonProfile
  isAdmin: boolean
}) {
  const nav = useNavigation()
  const urlOf = usePersonUrl()
  const tasksHref = nav.consoleUrl ? nav.consoleUrl('/tasks') : '/tasks'
  const nothing = p.seats.length === 0 && p.scopes.length === 0 && p.open_tasks === 0
  return (
    <SectionCard
      icon={<BriefcaseBusiness className='h-4 w-4' />}
      title='Responsibilities'
      hint={
        p.seat_count > 0
          ? `${p.seat_count} owner-group seat${p.seat_count === 1 ? '' : 's'}`
          : undefined
      }
      testId='responsibilities'
    >
      {nothing ? (
        <EmptyLine>No approval seats, scopes or open tasks.</EmptyLine>
      ) : (
        <div className='space-y-4'>
          {p.seats.length > 0 && (
            <div data-person-seats>
              <p className='mb-1.5 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-slate-400'>
                <ShieldCheck className='h-3 w-3' /> Approves
              </p>
              <ul className='space-y-2'>
                {p.seats.map((t) => (
                  <li key={t.template_id} className='text-[12.5px]'>
                    <span className='font-medium text-slate-700 dark:text-slate-200'>
                      {t.template_name}
                    </span>
                    <span className='mt-1 flex flex-wrap gap-1'>
                      {t.states.map((s) => (
                        <Pill
                          key={s.key}
                          tone='neutral'
                          title={`${s.groups} owner group${s.groups === 1 ? '' : 's'}`}
                        >
                          {s.label}
                          {s.groups > 1 && (
                            <span className='font-mono text-[10px] opacity-70'>×{s.groups}</span>
                          )}
                        </Pill>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {p.scopes.length > 0 && (
            <div data-person-scopes>
              <p className='mb-1.5 text-[11px] font-medium uppercase tracking-wide text-slate-400'>
                Works within
              </p>
              <dl className='grid gap-x-6 gap-y-1 sm:grid-cols-2'>
                {p.scopes.map((s) => (
                  <div key={s.dimension} className='flex gap-2 text-[12.5px]'>
                    <dt className='shrink-0 text-slate-400'>{s.label}</dt>
                    <dd className='text-slate-700 dark:text-slate-200'>{s.values.join(', ')}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
          {p.open_tasks > 0 && (
            <div className='flex items-center gap-2 text-[12.5px]' data-person-open-tasks>
              <ClipboardList className='h-3.5 w-3.5 text-slate-400' />
              <span className='text-slate-700 dark:text-slate-200'>
                <b className='tabular-nums'>{p.open_tasks}</b> open task
                {p.open_tasks === 1 ? '' : 's'}
              </span>
              {isAdmin && tasksHref && (
                <a
                  href={tasksHref}
                  onClick={(e) => {
                    if (e.metaKey || e.ctrlKey) return
                    e.preventDefault()
                    nav.navigate(tasksHref)
                  }}
                  className='text-[11.5px] text-nvr-navy underline decoration-dotted underline-offset-2 dark:text-nvr-cyan'
                >
                  open the task list
                </a>
              )}
            </div>
          )}
        </div>
      )}
      {/* usePersonUrl keeps the chip vocabulary in one place; referenced so a
          host with no people page never renders a dead link here either. */}
      {urlOf(p.id) === null && null}
    </SectionCard>
  )
}
