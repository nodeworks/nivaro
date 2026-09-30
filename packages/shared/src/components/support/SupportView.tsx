import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { LifeBuoy, Plus, Search } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useItemEditAuth, useNivaroClient } from '../../context'
import { del, get, patch, post } from '../../lib/commands'
import { RelationCombobox } from '../item-edit/RelationCombobox'
import { SimpleSelect } from '../ui/SimpleSelect'
import { SupportRequestDialog } from './SupportRequestDialog'
import { StatusPill, TicketDetailSheet } from './TicketDetailSheet'
import type { SupportCategory, SupportSummary, SupportTicket } from './types'

type Tab = 'mine' | 'desk' | 'types'
type DeskFilter = 'unassigned' | 'me' | 'open' | 'closed'

function ago(iso: string | null | undefined): string {
  if (!iso) return ''
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
  if (m < 60) return `${Math.max(m, 1)}m ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

/**
 * The support page (#999). Everyone sees My requests (raise one, follow it).
 * Administrators — and members of a team a type routes to — also get the Desk
 * (pick up, reply, close) and, for administrators, the list of request types.
 *
 * `initialTicketId` opens a ticket on arrival (/support?ticket=12, the link in
 * every support notification); `onTicketChange` lets the host keep the URL in
 * step.
 */
export function SupportView({
  initialTicketId,
  onTicketChange,
  className
}: {
  initialTicketId?: number | null
  onTicketChange?: (id: number | null) => void
  className?: string
}) {
  const client = useNivaroClient()
  const auth = useItemEditAuth()
  const isAdmin = !!auth?.isAdmin
  const [tab, setTabState] = useState<Tab>('mine')
  // Once the person picks a tab, the desk default never overrides it.
  const picked = useRef(false)
  const setTab = (t: Tab) => {
    picked.current = true
    setTabState(t)
  }
  const [openId, setOpenId] = useState<number | null>(initialTicketId ?? null)
  const [raising, setRaising] = useState(false)
  const [mineStatus, setMineStatus] = useState<'open' | 'closed'>('open')
  const [deskFilter, setDeskFilter] = useState<DeskFilter>('unassigned')
  const [search, setSearch] = useState('')

  useEffect(() => {
    if (initialTicketId != null) setOpenId(initialTicketId)
  }, [initialTicketId])

  const { data: summary } = useQuery({
    queryKey: ['support-summary'],
    queryFn: () =>
      client.request<{ data: SupportSummary }>(get('/support/summary')).then((r) => r.data)
  })
  const desk = !!summary?.desk
  // A desk worker lands on the desk, everyone else on their own requests.
  const [defaulted, setDefaulted] = useState(false)
  useEffect(() => {
    if (!defaulted && summary) {
      if (summary.desk && !picked.current) setTabState('desk')
      setDefaulted(true)
    }
  }, [summary, defaulted])

  const params: Record<string, string> =
    tab === 'desk'
      ? {
          scope: 'desk',
          status: deskFilter === 'closed' ? 'closed' : 'open',
          ...(deskFilter === 'unassigned' ? { assignee: 'unassigned' } : {}),
          ...(deskFilter === 'me' ? { assignee: 'me' } : {})
        }
      : { scope: 'mine', status: mineStatus }
  if (search.trim()) params.q = search.trim()
  const { data: list, isLoading } = useQuery({
    queryKey: ['support-tickets', params],
    queryFn: () =>
      client.request<{ data: SupportTicket[]; total: number }>(get('/support/tickets', params)),
    enabled: tab !== 'types'
  })

  const openTicket = (id: number | null) => {
    setOpenId(id)
    onTicketChange?.(id)
  }

  const tabs: Array<{ key: Tab; label: string; count?: number }> = [
    { key: 'mine', label: 'My requests', count: summary?.mine_open },
    ...(desk ? [{ key: 'desk' as Tab, label: 'Desk', count: summary?.unassigned }] : []),
    ...(isAdmin ? [{ key: 'types' as Tab, label: 'Request types' }] : [])
  ]

  return (
    <div className={className} data-support-view>
      <div className='flex flex-wrap items-center justify-between gap-3'>
        <div className='flex items-center gap-1' role='tablist'>
          {tabs.map((t) => (
            <button
              key={t.key}
              type='button'
              role='tab'
              aria-selected={tab === t.key}
              data-support-tab={t.key}
              onClick={() => setTab(t.key)}
              className={
                tab === t.key
                  ? 'inline-flex h-8 items-center gap-1.5 rounded-md bg-nvr-cyan/10 px-3 text-[12.5px] font-medium text-nvr-navy dark:text-nvr-cyan'
                  : 'inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[12.5px] text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-white/5'
              }
            >
              {t.label}
              {t.count ? (
                <span className='rounded-full bg-slate-200 px-1.5 text-[10.5px] font-semibold tabular-nums text-slate-700 dark:bg-white/10 dark:text-slate-200'>
                  {t.count}
                </span>
              ) : null}
            </button>
          ))}
        </div>
        <button
          type='button'
          data-support-new
          onClick={() => setRaising(true)}
          className='inline-flex h-8 items-center gap-1.5 rounded-md border border-nvr-cyan/60 bg-nvr-cyan/10 px-3 text-[12.5px] font-medium text-nvr-navy hover:bg-nvr-cyan/15 dark:text-nvr-cyan'
        >
          <Plus className='h-3.5 w-3.5' /> Get help
        </button>
      </div>

      {tab === 'types' ? (
        <SupportTypesEditor />
      ) : (
        <>
          <div className='mt-4 flex flex-wrap items-center gap-2'>
            {(tab === 'desk'
              ? ([
                  ['unassigned', 'Not picked up'],
                  ['me', 'Mine'],
                  ['open', 'All open'],
                  ['closed', 'Closed']
                ] as Array<[DeskFilter, string]>)
              : ([
                  ['open', 'Open'],
                  ['closed', 'Closed']
                ] as Array<['open' | 'closed', string]>)
            ).map(([k, label]) => {
              const active = tab === 'desk' ? deskFilter === k : mineStatus === k
              return (
                <button
                  key={k}
                  type='button'
                  data-support-filter={k}
                  aria-pressed={active}
                  onClick={() =>
                    tab === 'desk'
                      ? setDeskFilter(k as DeskFilter)
                      : setMineStatus(k as 'open' | 'closed')
                  }
                  className={
                    active
                      ? 'h-7 rounded-full border border-nvr-cyan/60 bg-nvr-cyan/10 px-2.5 text-[12px] font-medium text-nvr-navy dark:text-nvr-cyan'
                      : 'h-7 rounded-full border border-slate-200 px-2.5 text-[12px] text-slate-600 hover:border-slate-300 dark:border-border dark:text-slate-300'
                  }
                >
                  {label}
                </button>
              )
            })}
            <label className='ml-auto flex h-8 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2 dark:border-border dark:bg-background'>
              <Search className='h-3.5 w-3.5 text-slate-400' />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder='Search requests'
                aria-label='Search requests'
                className='w-48 bg-transparent text-[12.5px] text-slate-900 outline-none dark:text-slate-100'
              />
            </label>
          </div>

          <div className='mt-3 overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
            {isLoading ? (
              <div className='space-y-2 p-4'>
                {[0, 1, 2].map((i) => (
                  <div
                    key={i}
                    className='h-10 animate-pulse rounded bg-[hsl(var(--nvr-skeleton))]'
                  />
                ))}
              </div>
            ) : !list?.data.length ? (
              <div className='flex flex-col items-center gap-2 px-6 py-12 text-center'>
                <LifeBuoy className='h-6 w-6 text-slate-300' />
                <p className='text-[13px] font-medium text-slate-700 dark:text-slate-200'>
                  {tab === 'desk'
                    ? deskFilter === 'unassigned'
                      ? 'Every request has been picked up.'
                      : 'Nothing here.'
                    : mineStatus === 'open'
                      ? 'You have no open requests.'
                      : 'No closed requests yet.'}
                </p>
                {tab === 'mine' && (
                  <p className='max-w-sm text-[12px] text-slate-500 dark:text-muted-foreground'>
                    Use Get help for anything general, or Request a change from a record's ⋯ menu to
                    ask for a change to that record.
                  </p>
                )}
              </div>
            ) : (
              <ul className='divide-y divide-slate-100 dark:divide-border/60' data-support-list>
                {list.data.map((t) => (
                  <li key={t.id}>
                    <button
                      type='button'
                      data-support-row={t.id}
                      onClick={() => openTicket(t.id)}
                      className='grid w-full grid-cols-[1fr_auto] items-start gap-3 px-4 py-2.5 text-left hover:bg-slate-50 dark:hover:bg-white/5'
                    >
                      <span className='min-w-0'>
                        <span className='flex items-center gap-2'>
                          <span className='font-mono text-[11px] text-slate-400'>#{t.id}</span>
                          <span className='truncate text-[13px] font-medium text-slate-900 dark:text-slate-100'>
                            {t.title}
                          </span>
                          {t.priority === 'urgent' && (
                            <span className='rounded bg-red-500/10 px-1 py-px text-[9.5px] font-semibold uppercase tracking-wide text-red-600 dark:text-red-400'>
                              urgent
                            </span>
                          )}
                        </span>
                        <span className='mt-0.5 block truncate text-[11.5px] text-slate-500 dark:text-muted-foreground'>
                          {[
                            t.record_label ?? 'General Support',
                            t.category_name,
                            tab === 'desk' ? t.requester_name : null,
                            t.assignee_name ? `with ${t.assignee_name}` : null,
                            t.replies ? `${t.replies} repl${t.replies === 1 ? 'y' : 'ies'}` : null
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      </span>
                      <span className='flex flex-col items-end gap-1'>
                        <StatusPill status={t.status} label={t.status_label} />
                        <span className='text-[11px] text-slate-400'>
                          {ago(t.updated_at ?? t.created_at)}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {list && list.total > list.data.length && (
            <p className='mt-2 text-[11.5px] text-slate-500 dark:text-muted-foreground'>
              Showing {list.data.length} of {list.total}. Search to narrow the list.
            </p>
          )}
        </>
      )}

      <SupportRequestDialog
        open={raising}
        onOpenChange={setRaising}
        onCreated={(t) => {
          setTab('mine')
          setMineStatus('open')
          openTicket(t.id)
        }}
      />
      <TicketDetailSheet ticketId={openId} onOpenChange={(o) => !o && openTicket(null)} />
    </div>
  )
}

/** Administrators: the request types people choose from. */
function SupportTypesEditor() {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const { data: cats = [] } = useQuery({
    queryKey: ['support-categories', 'all'],
    queryFn: () =>
      client
        .request<{ data: SupportCategory[] }>(get('/support/categories', { all: '1' }))
        .then((r) => r.data ?? [])
  })
  const { data: teams = [] } = useQuery({
    queryKey: ['support-teams'],
    queryFn: () =>
      client
        .request<{ data: Array<{ id: number; name: string }> }>(get('/user-groups'))
        .then((r) => r.data ?? [])
        .catch(() => [])
  })
  const refresh = () => void qc.invalidateQueries({ queryKey: ['support-categories'] })
  const save = useMutation({
    mutationFn: ({ id, body }: { id: number; body: Record<string, unknown> }) =>
      client.request(patch(`/support/categories/${id}`, body)),
    onSuccess: refresh
  })
  const add = useMutation({
    mutationFn: () => client.request(post('/support/categories', { name: name.trim() })),
    onSuccess: () => {
      setName('')
      refresh()
    }
  })
  const remove = useMutation({
    mutationFn: (id: number) => client.request(del(`/support/categories/${id}`)),
    onSuccess: refresh
  })

  return (
    <div className='mt-4 space-y-3' data-support-types-editor>
      <p className='max-w-2xl text-[12.5px] text-slate-500 dark:text-muted-foreground'>
        The kinds of request people pick from. A type tied to a collection is offered on those
        records only; without one it is offered everywhere, including General Support. With no team
        a request goes to every administrator; a default assignee skips the desk entirely.
      </p>
      <div className='overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
        <table className='w-full text-[12.5px]'>
          <thead className='bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-500 dark:bg-white/5 dark:text-muted-foreground'>
            <tr>
              <th className='px-3 py-2 font-medium'>Type</th>
              <th className='px-3 py-2 font-medium'>For records in</th>
              <th className='px-3 py-2 font-medium'>Team</th>
              <th className='px-3 py-2 font-medium'>Default assignee</th>
              <th className='px-3 py-2 font-medium'>Active</th>
              <th className='px-3 py-2' />
            </tr>
          </thead>
          <tbody className='divide-y divide-slate-100 dark:divide-border/60'>
            {cats.map((c) => (
              <tr key={c.id} data-support-type-row={c.id}>
                <td className='px-3 py-2'>
                  <input
                    defaultValue={c.name}
                    onBlur={(e) =>
                      e.target.value.trim() &&
                      e.target.value !== c.name &&
                      save.mutate({ id: c.id, body: { name: e.target.value } })
                    }
                    aria-label='Type name'
                    className='w-full bg-transparent font-medium text-slate-900 outline-none focus:underline dark:text-slate-100'
                  />
                </td>
                <td className='px-3 py-2'>
                  <input
                    defaultValue={c.collection ?? ''}
                    placeholder='Anywhere'
                    onBlur={(e) =>
                      (e.target.value || null) !== c.collection &&
                      save.mutate({ id: c.id, body: { collection: e.target.value || null } })
                    }
                    aria-label='Collection'
                    className='w-full bg-transparent font-mono text-[12px] text-slate-700 outline-none dark:text-slate-300'
                  />
                </td>
                <td className='px-3 py-2'>
                  <SimpleSelect
                    value={c.team_id != null ? String(c.team_id) : ''}
                    onChange={(v) =>
                      save.mutate({ id: c.id, body: { team_id: v ? Number(v) : null } })
                    }
                    options={[
                      { value: '', label: 'Administrators' },
                      ...teams.map((t) => ({ value: String(t.id), label: t.name }))
                    ]}
                    ariaLabel='Team'
                  />
                </td>
                <td className='px-3 py-2'>
                  <RelationCombobox
                    collection='nivaro_users'
                    value={c.default_assignee}
                    onChange={(v) =>
                      save.mutate({ id: c.id, body: { default_assignee: v ? String(v) : null } })
                    }
                    placeholder='Nobody'
                  />
                </td>
                <td className='px-3 py-2'>
                  <input
                    type='checkbox'
                    checked={c.is_active}
                    onChange={(e) =>
                      save.mutate({ id: c.id, body: { is_active: e.target.checked } })
                    }
                    aria-label='Active'
                  />
                </td>
                <td className='px-3 py-2 text-right'>
                  <button
                    type='button'
                    onClick={() => remove.mutate(c.id)}
                    className='text-[11.5px] text-slate-400 hover:text-red-600'
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <form
        className='flex items-center gap-2'
        onSubmit={(e) => {
          e.preventDefault()
          if (name.trim()) add.mutate()
        }}
      >
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder='New type, e.g. Vendor change'
          aria-label='New type name'
          className='h-8 w-72 rounded-md border border-slate-200 bg-white px-3 text-[12.5px] outline-none focus:border-nvr-cyan dark:border-border dark:bg-background dark:text-slate-100'
        />
        <button
          type='submit'
          disabled={!name.trim() || add.isPending}
          className='h-8 rounded-md border border-nvr-cyan/60 bg-nvr-cyan/10 px-3 text-[12.5px] font-medium text-nvr-navy disabled:opacity-50 dark:text-nvr-cyan'
        >
          Add type
        </button>
      </form>
    </div>
  )
}
