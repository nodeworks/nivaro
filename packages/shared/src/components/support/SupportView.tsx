import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useItemEditAuth, useNivaroClient } from '../../context'
import { del, get, patch, post } from '../../lib/commands'
import { type SupportDraft, takeSupportDraft } from '../../lib/error-actions'
import { useLiveRefresh } from '../../lib/live-counts'
import { RelationCombobox } from '../item-edit/RelationCombobox'
import { LiveCount } from '../LiveCount'
import { SimpleSelect } from '../ui/SimpleSelect'
import { RequestList } from './RequestList'
import { SupportAnalytics } from './SupportAnalytics'
import { SupportRequestDialog } from './SupportRequestDialog'
import { TicketDetailSheet } from './TicketDetailSheet'
import type { SupportCategory, SupportSummary } from './types'

type Tab = 'mine' | 'desk' | 'analytics' | 'types'

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
  // An error's "Get help" / "Ask for access" opened this page (?new=1) with a
  // request prepared: open it filled in with what happened and the reference.
  const [draft, setDraft] = useState<SupportDraft | null>(() =>
    typeof window !== 'undefined' && /[?&]new=1\b/.test(window.location.search)
      ? takeSupportDraft()
      : null
  )
  const [raising, setRaising] = useState(!!draft)

  useEffect(() => {
    if (initialTicketId != null) setOpenId(initialTicketId)
  }, [initialTicketId])

  const { data: summary } = useQuery({
    queryKey: ['support-summary'],
    queryFn: () =>
      client.request<{ data: SupportSummary }>(get('/support/summary')).then((r) => r.data)
  })
  const desk = !!summary?.desk
  // Live: new tickets, claims, replies and status moves land for everyone with the desk open.
  // The re-read goes through the permission-checked routes (a poke names nothing), once per
  // quiet window per tab, and a hidden tab reads once when it is shown again.
  useLiveRefresh({
    topic: 'support',
    keys: [['support-tickets'], ['support-summary'], ['support-ticket'], ['support-workload']]
  })
  // A desk worker lands on the desk, everyone else on their own requests.
  const [defaulted, setDefaulted] = useState(false)
  useEffect(() => {
    if (!defaulted && summary) {
      if (summary.desk && !picked.current) setTabState('desk')
      setDefaulted(true)
    }
  }, [summary, defaulted])

  const openTicket = (id: number | null) => {
    setOpenId(id)
    onTicketChange?.(id)
  }

  const tabs: Array<{ key: Tab; label: string; count?: number }> = [
    { key: 'mine', label: 'My requests', count: summary?.mine_open },
    ...(desk ? [{ key: 'desk' as Tab, label: 'Desk', count: summary?.unassigned }] : []),
    ...(desk ? [{ key: 'analytics' as Tab, label: 'Analytics' }] : []),
    ...(isAdmin ? [{ key: 'types' as Tab, label: 'Request types' }] : [])
  ]

  return (
    <div className={className} data-support-view>
      <div className='flex flex-wrap items-center justify-between gap-3'>
        {/* One row that scrolls sideways on a phone: tab names never break onto two lines. */}
        <div
          className='-mx-1 flex min-w-0 max-w-full items-center gap-1 overflow-x-auto px-1 [scrollbar-width:none]'
          role='tablist'
        >
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
                  ? 'inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md bg-nvr-cyan/10 px-3 text-[12.5px] font-medium text-nvr-navy dark:text-nvr-cyan'
                  : 'inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-3 text-[12.5px] text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-white/5'
              }
            >
              {t.label}
              {t.count ? (
                <span className='rounded-full bg-slate-200 px-1.5 text-[10.5px] font-semibold tabular-nums text-slate-700 dark:bg-white/10 dark:text-slate-200'>
                  <LiveCount value={t.count} />
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
      ) : tab === 'analytics' ? (
        <SupportAnalytics />
      ) : (
        <RequestList key={tab} tab={tab} openId={openId} onOpen={(id) => openTicket(id)} />
      )}

      <SupportRequestDialog
        open={raising}
        onOpenChange={(o) => {
          setRaising(o)
          if (!o) setDraft(null)
        }}
        initialTitle={draft?.title}
        initialDescription={draft?.description}
        onCreated={(t) => {
          setTab('mine')
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
