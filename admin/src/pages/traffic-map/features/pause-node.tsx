/**
 * #1127 — pause from the node: a cron job's caller node pauses / resumes the job, a flow's node
 * switches the flow off / on, a partner node switches its external API to mock answers on this
 * instance (and back). Two-click confirm; the existing routes write the activity rows.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router'
import { api } from '@/lib/api'
import { Empty, type InspectorData, Section } from '../Inspector'
import { inspectorPanels } from '../registry/inspectorPanels'
import { register } from '../registry/registry'
import type { Selection } from '../types'
import { ConfirmButton, errorOf, LINK, Note } from './shared'

type MockEntry = { enabled?: boolean; record?: boolean; rules?: unknown[]; fallback?: unknown }

/**
 * The mock_config PATCH that switches mocking on this instance on or off, keeping the rules and
 * every other instance's entry exactly as they were (pure; exported for tests).
 */
export function mockToggle(
  config: Record<string, MockEntry> | null | undefined,
  instance: string,
  enable: boolean
): Record<string, MockEntry> {
  const out: Record<string, MockEntry> = { ...(config ?? {}) }
  const cur = out[instance] ?? {}
  out[instance] = {
    ...cur,
    enabled: enable,
    rules: Array.isArray(cur.rules) ? cur.rules : [],
    // `record` (#604) is refused while mocking; keep it only when switching mocking off.
    ...(enable ? { record: undefined } : {})
  }
  return out
}

function useResult() {
  const [note, setNote] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  return {
    note,
    ok: (text: string) => setNote({ tone: 'ok', text }),
    fail: (e: unknown) => setNote({ tone: 'error', text: errorOf(e) })
  }
}

function CronControl({ jobId }: { jobId: string }) {
  const qc = useQueryClient()
  const r = useResult()
  const q = useQuery({
    queryKey: ['traffic-map', 'cron-list'],
    queryFn: async () =>
      (
        (await api.get('/cron'))?.data as {
          data?: Array<{ id: string; paused?: boolean; expression?: string }>
        }
      )?.data ?? [],
    staleTime: 15_000
  })
  const job = q.data?.find((j) => j.id === jobId)
  const m = useMutation({
    mutationFn: (pause: boolean) =>
      api.post(`/cron/${encodeURIComponent(jobId)}/${pause ? 'pause' : 'resume'}`),
    onSuccess: (_x, pause) => {
      r.ok(pause ? 'Paused. It skips its ticks until resumed.' : 'Resumed.')
      void qc.invalidateQueries({ queryKey: ['traffic-map', 'cron-list'] })
    },
    onError: r.fail
  })
  if (q.isLoading) return <Empty>Reading the job…</Empty>
  if (!job) return <Empty>No scheduled job named {jobId} on this node.</Empty>
  return (
    <div className='grid gap-2 text-[12px]' data-tm-pause-cron={jobId}>
      <p className='text-[var(--tm-fg-2)]'>
        <span className='font-mono text-[11.5px]'>{jobId}</span> ·{' '}
        {job.paused ? 'paused' : 'running on schedule'}
        {job.expression ? (
          <span className='font-mono text-[11px] text-[var(--tm-muted)]'> · {job.expression}</span>
        ) : null}
      </p>
      <div>
        <ConfirmButton
          id='tm-cron-toggle'
          danger={!job.paused}
          label={job.paused ? 'Resume job' : 'Pause job'}
          confirmLabel={job.paused ? 'Resume it?' : 'Pause it?'}
          busy={m.isPending}
          onConfirm={() => m.mutate(!job.paused)}
        />
      </div>
      {r.note && <Note tone={r.note.tone}>{r.note.text}</Note>}
    </div>
  )
}

function FlowControl({ flowId }: { flowId: string }) {
  const qc = useQueryClient()
  const r = useResult()
  const key = ['traffic-map', 'flow', flowId]
  const q = useQuery({
    queryKey: key,
    queryFn: async () =>
      (
        (await api.get(`/flows/${encodeURIComponent(flowId)}`))?.data as {
          data?: { name?: string; status?: string }
        }
      )?.data ?? null
  })
  const m = useMutation({
    mutationFn: (status: 'active' | 'inactive') =>
      api.patch(`/flows/${encodeURIComponent(flowId)}`, { status }),
    onSuccess: (_x, status) => {
      r.ok(status === 'inactive' ? 'Flow switched off.' : 'Flow switched on.')
      void qc.invalidateQueries({ queryKey: key })
    },
    onError: r.fail
  })
  if (q.isLoading) return <Empty>Reading the flow…</Empty>
  if (!q.data) return <Empty>This flow no longer exists.</Empty>
  const active = q.data.status === 'active'
  return (
    <div className='grid gap-2 text-[12px]' data-tm-pause-flow={flowId}>
      <p className='text-[var(--tm-fg-2)]'>
        <Link to={`/flows/${flowId}`} className={LINK}>
          {q.data.name ?? flowId}
        </Link>{' '}
        · {active ? 'active' : 'off'}
      </p>
      <div>
        <ConfirmButton
          id='tm-flow-toggle'
          danger={active}
          label={active ? 'Switch flow off' : 'Switch flow on'}
          confirmLabel={active ? 'Switch it off?' : 'Switch it on?'}
          busy={m.isPending}
          onConfirm={() => m.mutate(active ? 'inactive' : 'active')}
        />
      </div>
      {r.note && <Note tone={r.note.tone}>{r.note.text}</Note>}
    </div>
  )
}

interface ExternalApiRead {
  name: string
  mock_config: Record<string, MockEntry> | null
  mock_active: boolean
  current_instance: string
}

function MockControl({ apiId }: { apiId: number }) {
  const qc = useQueryClient()
  const r = useResult()
  const key = ['traffic-map', 'external-api', apiId]
  const q = useQuery({
    queryKey: key,
    queryFn: async () =>
      ((await api.get(`/external-apis/${apiId}`))?.data as { data?: ExternalApiRead })?.data ?? null
  })
  const m = useMutation({
    mutationFn: (enable: boolean) =>
      api.patch(`/external-apis/${apiId}`, {
        mock_config: mockToggle(q.data?.mock_config, q.data?.current_instance ?? 'default', enable)
      }),
    onSuccess: (_x, enable) => {
      r.ok(
        enable
          ? 'Mocked on this instance: calls get the mock answers, nothing reaches the partner.'
          : 'Live again on this instance.'
      )
      void qc.invalidateQueries({ queryKey: key })
    },
    onError: r.fail
  })
  if (q.isLoading) return <Empty>Reading the external API…</Empty>
  if (!q.data) return <Empty>This external API could not be read.</Empty>
  const mocked = q.data.mock_active
  const rules = q.data.mock_config?.[q.data.current_instance]?.rules?.length ?? 0
  return (
    <div className='grid gap-2 text-[12px]' data-tm-pause-api={apiId}>
      <p className='text-[var(--tm-fg-2)]'>
        {q.data.name} on <span className='font-mono text-[11.5px]'>{q.data.current_instance}</span>{' '}
        · {mocked ? <span className='text-[var(--tm-error-ink)]'>mocked</span> : 'live'}
        {mocked || rules ? ` · ${rules} mock rule${rules === 1 ? '' : 's'}` : ''}
      </p>
      <div>
        <ConfirmButton
          id='tm-mock-toggle'
          danger={!mocked}
          label={mocked ? 'Go live again' : 'Switch to mock'}
          confirmLabel={mocked ? 'Send real calls again?' : 'Stop calling the partner?'}
          busy={m.isPending}
          onConfirm={() => m.mutate(!mocked)}
        />
      </div>
      {r.note && <Note tone={r.note.tone}>{r.note.text}</Note>}
    </div>
  )
}

function PauseNode({ sel }: { sel: Selection; d: InspectorData }) {
  const cron = sel.kind === 'caller' ? sel.id.match(/^cron:(.+)$/) : null
  const flow = sel.kind === 'caller' ? sel.id.match(/^flow:([A-Za-z0-9-]{1,64})$/) : null
  const ext = sel.kind === 'down' ? sel.id.match(/^ext:(\d{1,9})$/) : null
  return (
    <Section title={ext ? 'Mock this partner' : cron ? 'Pause this job' : 'Pause this flow'}>
      {cron ? (
        <CronControl jobId={cron[1]} />
      ) : flow ? (
        <FlowControl flowId={flow[1]} />
      ) : ext ? (
        <MockControl apiId={Number(ext[1])} />
      ) : null}
    </Section>
  )
}

register(inspectorPanels, {
  id: 'pause-node',
  order: 25,
  applies: (sel) =>
    (sel.kind === 'caller' && /^(cron:.+|flow:[A-Za-z0-9-]{1,64})$/.test(sel.id)) ||
    (sel.kind === 'down' && /^ext:\d{1,9}$/.test(sel.id)),
  Component: PauseNode
})
