/**
 * #2152 Blast radius — select an endpoint or a partner and see what would break if it failed: the
 * screens, flows, scheduled jobs and partners that depend on it over the last 7 days, with how many
 * people used them. Worked out on demand (a week of the request log), read-only.
 *
 * #2274 Tell affected people — from the same panel: a prefilled message the admin edits, sent
 * through Broadcasts to the people who used this node or its screens in the last hour (the server
 * works the audience out; two clicks; it writes an activity row). A banner lifts itself in 4 h.
 */
import { useMutation, useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useTrafficMap } from '../../context'
import { callerLabel, fmtCount } from '../../EventTicker'
import { Empty, type InspectorData, Section } from '../../Inspector'
import { inspectorPanels } from '../../registry/inspectorPanels'
import { register } from '../../registry/registry'
import type { Selection } from '../../types'
import { inPage } from '../b1-shared'
import { apiError, TwoClickButton } from '../ops-common'
import { BTN, INPUT, LINK, Note, SafeLink } from '../shared'
import { blastNodeOf } from './shared'

export interface ScreenUse {
  screen: string
  app: string | null
  route: string
  people: number
  calls: number
}
export interface BlastRadius {
  node: string
  days: number
  people: { total: number; top: Array<{ id: string; name: string; calls: number }> }
  screens: ScreenUse[]
  screens_coverage: number | null
  flows: Array<{
    id: string
    name: string
    active: boolean
    why: string
    runs: number
    failed: number
  }>
  jobs: Array<{ id: string; calls: number; runs: number; failed: number }>
  callers: Array<{ id: string; label: string; calls: number }>
  partners: Array<{ id: string; label: string; n: number }>
  collections: Array<{ collection: string; pushes: number; people: number }>
  requests: number
  notes: string[]
  computed_at: string
  prefill: { subject: string; message: string }
}

/** Something on the list depends on the node (pure; exported for tests). */
export function dependents(b: BlastRadius): number {
  return (
    b.screens.length +
    b.flows.length +
    b.jobs.length +
    b.callers.length +
    b.partners.length +
    b.collections.length
  )
}

function Group({
  title,
  count,
  children
}: {
  title: string
  count: number
  children: React.ReactNode
}) {
  if (count === 0) return null
  return (
    <div className='min-w-0'>
      <h4 className='mb-1 text-[11.5px] font-medium text-[var(--tm-fg-2)]'>
        {title} <span className='tabular-nums text-[var(--tm-muted)]'>{count}</span>
      </h4>
      <ul className='grid gap-0.5 text-[12px]'>{children}</ul>
    </div>
  )
}

function Row({ left, right }: { left: React.ReactNode; right: React.ReactNode }) {
  return (
    <li className='flex min-w-0 items-baseline justify-between gap-2'>
      <span className='min-w-0 truncate'>{left}</span>
      <span className='shrink-0 tabular-nums text-[11.5px] text-[var(--tm-fg-2)]'>{right}</span>
    </li>
  )
}

function TellAffected({ node, data }: { node: string; data: BlastRadius }) {
  const [open, setOpen] = useState(false)
  const [subject, setSubject] = useState(data.prefill.subject)
  const [message, setMessage] = useState(data.prefill.message)
  const [banner, setBanner] = useState(true)
  useEffect(() => {
    setSubject(data.prefill.subject)
    setMessage(data.prefill.message)
  }, [data.prefill.subject, data.prefill.message])
  const screens = data.screens.slice(0, 30).map((s) => s.screen)
  const audience = useQuery({
    queryKey: ['traffic-map', 'affected-people', node, screens.join('|')],
    queryFn: async () =>
      (
        await api.get('/traffic-map/affected-people', {
          params: { node, screens: JSON.stringify(screens) }
        })
      ).data.data as { count: number; sample: string[]; over_limit: boolean; max: number },
    enabled: open,
    staleTime: 30_000
  })
  const send = useMutation({
    mutationFn: async () =>
      (await api.post('/traffic-map/tell-affected', { node, screens, subject, message, banner }))
        .data.data as { recipients: number },
    onSuccess: (d) => {
      toast.success(`Sent to ${d.recipients} ${d.recipients === 1 ? 'person' : 'people'}`)
      setOpen(false)
    },
    onError: (e) => toast.error(apiError(e))
  })
  if (!open)
    return (
      <div className='mt-2'>
        <button type='button' id='tm-tell-open' className={BTN} onClick={() => setOpen(true)}>
          Tell affected people…
        </button>
      </div>
    )
  const a = audience.data
  return (
    <div
      className='mt-2 grid gap-2 rounded-md border border-[var(--tm-line)] bg-[var(--tm-card-2)] p-2.5 text-[12px]'
      data-tm-tell={node}
    >
      <label className='grid gap-1'>
        <span className='text-[11.5px] text-[var(--tm-fg-2)]'>Subject</span>
        <input
          id='tm-tell-subject'
          className={cn(INPUT, 'w-full')}
          value={subject}
          maxLength={200}
          onChange={(e) => setSubject(e.target.value)}
        />
      </label>
      <label className='grid gap-1'>
        <span className='text-[11.5px] text-[var(--tm-fg-2)]'>Message</span>
        <textarea
          id='tm-tell-message'
          className={cn(INPUT, 'h-auto min-h-[84px] w-full resize-y py-1.5 leading-snug')}
          value={message}
          maxLength={2000}
          onChange={(e) => setMessage(e.target.value)}
        />
      </label>
      <label className='flex items-center gap-2 text-[12px] text-[var(--tm-fg-2)]'>
        <input
          type='checkbox'
          id='tm-tell-banner'
          checked={banner}
          onChange={(e) => setBanner(e.target.checked)}
          className='h-3.5 w-3.5 accent-[var(--tm-accent)]'
        />
        Also show it as a banner for 4 hours
      </label>
      <p className='text-[11.5px] text-[var(--tm-fg-2)]' id='tm-tell-audience'>
        {audience.isLoading
          ? 'Working out who used it in the last hour…'
          : audience.isError
            ? 'Could not work out who to tell.'
            : !a?.count
              ? 'Nobody used it or its screens in the last hour.'
              : `${fmtCount(a.count)} ${a.count === 1 ? 'person' : 'people'} used it or its screens in the last hour${a.sample.length ? `: ${a.sample.join(', ')}${a.count > a.sample.length ? '…' : ''}` : ''}. They get it in their inbox.`}
      </p>
      {a?.over_limit ? (
        <Note tone='error'>
          That is more than {fmtCount(a.max)} people — send it from{' '}
          <SafeLink to='/announcements' className={LINK}>
            Broadcasts
          </SafeLink>{' '}
          instead.
        </Note>
      ) : null}
      <div className='flex flex-wrap items-center gap-2'>
        <TwoClickButton
          id='tm-tell-send'
          label={a?.count ? `Send to ${fmtCount(a.count)}` : 'Send'}
          armedLabel='Click again to send now'
          busy={send.isPending}
          disabled={!a?.count || a.over_limit || !message.trim()}
          onConfirm={() => send.mutate()}
        />
        <button type='button' className={BTN} onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  )
}

function BlastRadiusPanel({ sel }: { sel: Selection; d: InspectorData }) {
  const node = blastNodeOf(sel)
  const { catalog, setSelection } = useTrafficMap()
  // Asked per node: another node starts closed again (the read covers a week of the request log).
  const [askedFor, setAskedFor] = useState<string | null>(null)
  const asked = askedFor !== null && askedFor === node
  const q = useQuery({
    queryKey: ['traffic-map', 'blast-radius', node],
    queryFn: async () =>
      (await api.get('/traffic-map/blast-radius', { params: { node } })).data.data as BlastRadius,
    enabled: !!node && asked,
    staleTime: 5 * 60_000
  })
  if (!node) return null
  const b = q.data
  return (
    <Section title='Blast radius'>
      {!asked ? (
        <div className='grid gap-1.5 text-[12px]'>
          <p className='text-[11.5px] text-[var(--tm-muted)]'>
            What would break if this failed: the screens, flows, scheduled jobs and partners that
            used it over the last 7 days, and how many people.
          </p>
          <div>
            <button
              type='button'
              id='tm-blast-open'
              className={BTN}
              onClick={() => setAskedFor(node)}
            >
              Show what depends on this
            </button>
          </div>
        </div>
      ) : q.isLoading ? (
        <Empty>Loading…</Empty>
      ) : q.isError || !b ? (
        <Note tone='error'>{apiError(q.error)}</Note>
      ) : (
        <div className='grid gap-2.5' data-tm-blast={node}>
          <p className='text-[12px] text-[var(--tm-fg)]'>
            <span className='font-semibold tabular-nums'>{fmtCount(b.people.total)}</span>{' '}
            {b.people.total === 1 ? 'person' : 'people'}
            {sel.kind === 'down' ? ' use the records pushed here' : ' used it'} ·{' '}
            <span className='tabular-nums'>{fmtCount(b.requests)}</span>{' '}
            {sel.kind === 'down' ? 'calls' : 'requests'} in {b.days} days
            {b.people.top.length ? (
              <span className='block truncate text-[11.5px] text-[var(--tm-fg-2)]'>
                Most:{' '}
                {b.people.top
                  .slice(0, 4)
                  .map((p) => p.name)
                  .join(', ')}
              </span>
            ) : null}
          </p>
          {dependents(b) === 0 ? (
            <Empty>Nothing else was seen depending on it in {b.days} days.</Empty>
          ) : null}
          <Group title='Screens' count={b.screens.length}>
            {b.screens.slice(0, 8).map((s) => (
              <Row
                key={s.screen}
                left={<span className='font-mono text-[11.5px]'>{s.screen}</span>}
                right={`${fmtCount(s.people)} ${s.people === 1 ? 'person' : 'people'}`}
              />
            ))}
          </Group>
          {b.screens.length && b.screens_coverage != null ? (
            <p className='-mt-1.5 text-[11px] text-[var(--tm-muted)]'>
              Matched by the page each person had open ({Math.round(b.screens_coverage * 100)}% of
              calls).
            </p>
          ) : null}
          <Group title='Flows' count={b.flows.length}>
            {b.flows.slice(0, 8).map((f) => (
              <Row
                key={f.id}
                left={
                  <>
                    <SafeLink to={`/flows/${f.id}`} className={LINK}>
                      {f.name}
                    </SafeLink>{' '}
                    <span className='text-[11px] text-[var(--tm-muted)]'>
                      {f.why}
                      {f.active ? '' : ' · off'}
                    </span>
                  </>
                }
                right={`${fmtCount(f.runs)} runs${f.failed ? ` · ${f.failed} failed` : ''}`}
              />
            ))}
          </Group>
          <Group title='Scheduled jobs' count={b.jobs.length}>
            {b.jobs.slice(0, 8).map((j) => (
              <Row
                key={j.id}
                left={
                  <button
                    type='button'
                    className={LINK}
                    onClick={() => setSelection({ kind: 'caller', id: `cron:${j.id}` })}
                  >
                    {j.id}
                  </button>
                }
                right={`${fmtCount(j.runs)} runs${j.failed ? ` · ${j.failed} failed` : ''}`}
              />
            ))}
          </Group>
          <Group title='Partners calling it' count={b.callers.length}>
            {b.callers.slice(0, 8).map((c) => (
              <Row
                key={c.id}
                left={
                  <button
                    type='button'
                    className={LINK}
                    onClick={() => setSelection({ kind: 'caller', id: c.id })}
                  >
                    {callerLabel(catalog, c.id) || c.label}
                  </button>
                }
                right={`${fmtCount(c.calls)} calls`}
              />
            ))}
          </Group>
          <Group
            title={sel.kind === 'down' ? 'Who calls it' : 'Partners its records go to'}
            count={b.partners.length}
          >
            {b.partners.slice(0, 8).map((p) => (
              <Row
                key={p.id}
                left={
                  /^ext:\d+$/.test(p.id) ? (
                    <button
                      type='button'
                      className={LINK}
                      onClick={() => setSelection({ kind: 'down', id: p.id })}
                    >
                      {p.label}
                    </button>
                  ) : (
                    p.label
                  )
                }
                right={fmtCount(p.n)}
              />
            ))}
          </Group>
          <Group title='Records pushed here' count={b.collections.length}>
            {b.collections.map((c) => (
              <Row
                key={c.collection}
                left={
                  <button
                    type='button'
                    className={LINK}
                    onClick={() => setSelection({ kind: 'entity', id: `items/${c.collection}` })}
                  >
                    {c.collection}
                  </button>
                }
                right={`${fmtCount(c.pushes)} pushes · ${fmtCount(c.people)} people`}
              />
            ))}
          </Group>
          {b.notes.length ? (
            <ul className='grid gap-0.5 text-[11px] text-[var(--tm-muted)]'>
              {b.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          ) : null}
          <TellAffected node={node} data={b} />
        </div>
      )}
    </Section>
  )
}

register(inspectorPanels, {
  id: 'blast-radius',
  order: 18,
  applies: (sel) => blastNodeOf(sel) !== null,
  Component: inPage(BlastRadiusPanel)
})
