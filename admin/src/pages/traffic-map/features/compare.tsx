import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { SimpleSelect } from '@/components/ui/simple-select'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useTrafficMap } from '../context'
import { entityLabel, fmtCount, fmtMs, fmtRate } from '../EventTicker'
import { pagePanels } from '../registry/pagePanels'
import { register } from '../registry/registry'
import type { Lane } from '../types'
import {
  pairProblem,
  toLocalInput,
  WINDOW_PRESETS,
  type WindowPair,
  type WindowPresetId,
  windowPreset
} from './compare-presets'
import { useFrozenSnapshotId } from './snapshots'

/**
 * Compare (#1160, #1131): two past windows from the request log, or this deployment against
 * another registered API (Environments registry; fetched server-side with that API's token).
 */
interface WindowDiffRow {
  key: string
  lane: Lane
  entity: string
  a: { req: number; error: number; p95: number }
  b: { req: number; error: number; p95: number }
  a_rpm: number
  b_rpm: number
  delta_rpm: number
  delta_pct: number | null
  only: 'a' | 'b' | null
}
interface WindowSide {
  from: string
  to: string
  rows: number
  truncated: boolean
  totals: { req: number; read: number; write: number; error: number; p95: number }
  callers: Array<{ key: string; req: number; error: number; label: string }>
}
interface InstanceRow {
  key: string
  label: string
  here: { req: number; error: number; p95: number }
  there: { req: number; error: number; p95: number }
  only: 'here' | 'there' | null
}
interface Component {
  id: number
  name: string
  environment: string | null
  base_url: string
  has_token: boolean
}

const BTN =
  'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-[3px] text-[12px] font-medium leading-tight transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--tm-card)] disabled:cursor-not-allowed disabled:opacity-60'
const BTN_ON =
  'border-[color-mix(in_srgb,var(--tm-accent)_55%,var(--tm-line))] bg-[var(--tm-accent-soft)] text-[var(--tm-accent-ink)]'
const TH = 'whitespace-nowrap px-2.5 py-1.5 text-[11.5px] font-medium text-[var(--tm-muted)]'
const TD = 'px-2.5 py-1.5'
const INPUT =
  'h-7 rounded-md border border-[var(--tm-line)] bg-[var(--tm-card)] px-2 text-[12px] text-[var(--tm-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan [color-scheme:light] dark:[color-scheme:dark]'

function errorText(e: unknown): string {
  const r = e as { response?: { data?: { error?: string } }; message?: string }
  return r?.response?.data?.error ?? r?.message ?? 'Unknown error'
}
function fmtWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}
function Delta({ value, pct }: { value: number; pct?: number | null }) {
  if (!Number.isFinite(value) || value === 0)
    return <span className='text-[var(--tm-muted)]'>no change</span>
  const up = value > 0
  return (
    <span className={up ? 'font-medium text-[var(--tm-fg)]' : 'text-[var(--tm-fg-2)]'}>
      {up ? '+' : '−'}
      {fmtRate(Math.abs(value))}
      {pct == null
        ? ''
        : Math.abs(pct) >= 1000
          ? ` (${up ? 'over 10×' : 'under a tenth'})` // a near-zero base makes the percentage noise
          : ` (${up ? '+' : '−'}${Math.abs(pct)}%)`}
    </span>
  )
}
function Only({ children }: { children: string }) {
  return (
    <span className='ml-1.5 rounded border border-[var(--tm-line)] px-1 py-px text-[10.5px] text-[var(--tm-fg-2)]'>
      {children}
    </span>
  )
}

function WindowsCompare() {
  const { catalog, setSelection, model } = useTrafficMap()
  const [preset, setPreset] = useState<WindowPresetId | 'custom'>('hour-vs-previous')
  const [custom, setCustom] = useState<WindowPair>(() => windowPreset('hour-vs-previous'))
  const [asked, setAsked] = useState<WindowPair | null>(null)
  const pair: WindowPair = preset === 'custom' ? custom : windowPreset(preset)
  const problem = pairProblem(pair)
  const q = useQuery({
    queryKey: [
      'traffic-map',
      'compare-windows',
      asked?.a.from.toISOString(),
      asked?.a.to.toISOString(),
      asked?.b.from.toISOString(),
      asked?.b.to.toISOString()
    ],
    queryFn: async () => {
      const p = asked as WindowPair
      const params = new URLSearchParams({
        a_from: p.a.from.toISOString(),
        a_to: p.a.to.toISOString(),
        b_from: p.b.from.toISOString(),
        b_to: p.b.to.toISOString()
      })
      const res = await api.get(`/traffic-map/compare/windows?${params}`)
      return res.data.data as { a: WindowSide; b: WindowSide; rows: WindowDiffRow[] }
    },
    enabled: !!asked,
    staleTime: 60_000
  })
  const setSide = (side: 'a' | 'b', end: 'from' | 'to', v: string) =>
    setCustom((c) => ({
      ...c,
      [side]: { ...c[side], [end]: new Date(v), label: side === 'a' ? 'A' : 'B' }
    }))
  const d = q.data
  return (
    <div>
      <div className='flex flex-wrap items-end gap-2 px-3.5 py-2.5'>
        <div className='flex flex-col gap-1'>
          <label
            htmlFor='tm-cmp-preset'
            className='text-[11.5px] font-medium text-[var(--tm-muted)]'
          >
            Windows
          </label>
          <SimpleSelect
            value={preset}
            onChange={(v) => {
              if (v === 'custom') setCustom(pair)
              setPreset(v as WindowPresetId | 'custom')
            }}
            options={[
              ...WINDOW_PRESETS.map((p) => ({ value: p.id, label: p.label })),
              { value: 'custom', label: 'Pick two windows…' }
            ]}
            triggerProps={{ id: 'tm-cmp-preset' }}
            className='h-7 min-w-[240px] border-[var(--tm-line)] bg-[var(--tm-card)] px-2.5 text-[12px] text-[var(--tm-fg-2)]'
          />
        </div>
        {preset === 'custom' &&
          (['a', 'b'] as const).map((side) => (
            <fieldset
              key={side}
              className='flex items-end gap-1'
              aria-label={`Window ${side.toUpperCase()}`}
            >
              <span className='pb-1.5 text-[12px] font-medium text-[var(--tm-fg-2)]'>
                {side.toUpperCase()}
              </span>
              <input
                type='datetime-local'
                aria-label={`Window ${side.toUpperCase()} start`}
                className={INPUT}
                value={toLocalInput(custom[side].from)}
                onChange={(e) => setSide(side, 'from', e.target.value)}
              />
              <span className='pb-1.5 text-[12px] text-[var(--tm-muted)]'>to</span>
              <input
                type='datetime-local'
                aria-label={`Window ${side.toUpperCase()} end`}
                className={INPUT}
                value={toLocalInput(custom[side].to)}
                onChange={(e) => setSide(side, 'to', e.target.value)}
              />
            </fieldset>
          ))}
        <button
          type='button'
          id='tm-cmp-run'
          className={cn(BTN, BTN_ON)}
          disabled={!!problem || q.isFetching}
          onClick={() => setAsked({ a: { ...pair.a }, b: { ...pair.b } })}
        >
          {q.isFetching ? 'Reading the log…' : 'Compare'}
        </button>
      </div>
      {problem && preset === 'custom' && (
        <p className='px-3.5 pb-2 text-[12px] text-[var(--tm-error-ink)]'>{problem}</p>
      )}
      {q.isError && (
        <p className='px-3.5 pb-2 text-[12px] text-[var(--tm-error-ink)]' role='alert'>
          {errorText(q.error)}
        </p>
      )}
      {!asked && (
        <p className='px-3.5 pb-3 text-[12px] text-[var(--tm-muted)]'>
          Reads the request log (kept 14 days) for both windows and lines the entities up, per
          minute so windows of different lengths compare fairly.
        </p>
      )}
      {d && (
        <div data-tm-compare-windows=''>
          <div className='grid grid-cols-2 gap-px border-y border-[var(--tm-line-2)] bg-[var(--tm-line-2)] text-[12px]'>
            {(['a', 'b'] as const).map((side) => {
              const s = d[side]
              const mins = Math.max(
                1,
                (new Date(s.to).getTime() - new Date(s.from).getTime()) / 60_000
              )
              return (
                <div key={side} className='bg-[var(--tm-card)] px-3.5 py-2'>
                  <p className='font-medium'>
                    {side.toUpperCase()} · {fmtWhen(s.from)} – {fmtWhen(s.to)}
                  </p>
                  <p className='mt-0.5 text-[var(--tm-fg-2)] tabular-nums'>
                    {fmtCount(s.totals.req)} requests ({fmtRate(s.totals.req / mins)}/min) ·{' '}
                    {fmtCount(s.totals.error)} errors · p95 {fmtMs(s.totals.p95)}
                  </p>
                  {s.callers.length > 0 && (
                    <p className='mt-0.5 truncate text-[var(--tm-muted)]'>
                      Top:{' '}
                      {s.callers
                        .slice(0, 3)
                        .map((c) => `${c.label} (${fmtCount(c.req)})`)
                        .join(', ')}
                    </p>
                  )}
                  {s.truncated && (
                    <p className='mt-0.5 text-[var(--tm-update)]'>
                      Busy window — only the newest {fmtCount(s.rows)} requests were read.
                    </p>
                  )}
                </div>
              )
            })}
          </div>
          {d.rows.length === 0 ? (
            <p className='px-3.5 py-3 text-[12px] text-[var(--tm-muted)]'>
              No traffic in either window.
            </p>
          ) : (
            <div className='max-h-[320px] overflow-auto'>
              <table className='w-full border-collapse text-[12px] tabular-nums'>
                <thead className='sticky top-0'>
                  <tr className='border-b border-[var(--tm-line-2)] bg-[var(--tm-card-2)] text-left'>
                    <th scope='col' className={TH}>
                      Entity
                    </th>
                    <th scope='col' className={`${TH} text-right`}>
                      A /min
                    </th>
                    <th scope='col' className={`${TH} text-right`}>
                      B /min
                    </th>
                    <th scope='col' className={`${TH} text-right`}>
                      Change
                    </th>
                    <th scope='col' className={`${TH} text-right`}>
                      Errors A · B
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {d.rows.map((r) => (
                    <tr
                      key={r.key}
                      className='cursor-pointer border-b border-[var(--tm-line-2)] last:border-0 hover:bg-[var(--tm-card-2)]'
                      onClick={() => {
                        if (model.entityKeys().includes(r.key))
                          setSelection({ kind: 'entity', id: r.key })
                      }}
                      data-tm-compare-row={r.key}
                    >
                      <td className={cn(TD, 'max-w-[260px] truncate')}>
                        {entityLabel(catalog, r.lane, r.entity)}
                        {r.only === 'a' && <Only>only in A</Only>}
                        {r.only === 'b' && <Only>only in B</Only>}
                      </td>
                      <td className={`${TD} text-right`}>{fmtRate(r.a_rpm)}</td>
                      <td className={`${TD} text-right`}>{fmtRate(r.b_rpm)}</td>
                      <td className={`${TD} text-right`}>
                        <Delta value={r.delta_rpm} pct={r.delta_pct} />
                      </td>
                      <td className={`${TD} text-right text-[var(--tm-fg-2)]`}>
                        {fmtCount(r.a.error)} · {fmtCount(r.b.error)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function instanceSentences(rows: InstanceRow[], here: string, there: string): string[] {
  const onlyHere = rows.filter((r) => r.only === 'here').slice(0, 3)
  const onlyThere = rows.filter((r) => r.only === 'there').slice(0, 3)
  const out: string[] = []
  if (onlyHere.length)
    out.push(`${here} handles ${onlyHere.map((r) => r.label).join(', ')} that ${there} does not.`)
  if (onlyThere.length)
    out.push(`${there} handles ${onlyThere.map((r) => r.label).join(', ')} that ${here} does not.`)
  return out
}

function InstanceCompare() {
  const { win, catalog } = useTrafficMap()
  const [component, setComponent] = useState('')
  const [asked, setAsked] = useState<string | null>(null)
  const comps = useQuery({
    queryKey: ['traffic-map', 'compare-components'],
    queryFn: async () =>
      (await api.get('/traffic-map/compare/components')).data.data as Component[],
    staleTime: 5 * 60_000
  })
  const q = useQuery({
    queryKey: ['traffic-map', 'compare-instances', asked, win],
    queryFn: async () => {
      const res = await api.get(`/traffic-map/compare/instances?component=${asked}&window=${win}`)
      return res.data.data as {
        component: { id: number; name: string }
        here: { instance: string; node_scope: string; totals: { req: number; error: number } }
        there: { instance: string; node_scope: string; totals: { req: number; error: number } }
        rows: InstanceRow[]
      }
    },
    enabled: !!asked,
    staleTime: 30_000
  })
  const list = comps.data ?? []
  if (comps.isSuccess && list.length === 0)
    return (
      <p className='px-3.5 py-3 text-[12px] text-[var(--tm-muted)]'>
        No other API is registered under Environments. Add one with its base URL and an API token to
        compare traffic side by side.
      </p>
    )
  const d = q.data
  const laneOfKey = (k: string) => k.slice(0, k.indexOf('/')) as Lane
  const label = (r: InstanceRow) =>
    entityLabel(catalog, laneOfKey(r.key), r.key.slice(r.key.indexOf('/') + 1))
  return (
    <div>
      <div className='flex flex-wrap items-end gap-2 px-3.5 py-2.5'>
        <div className='flex flex-col gap-1'>
          <label
            htmlFor='tm-cmp-component'
            className='text-[11.5px] font-medium text-[var(--tm-muted)]'
          >
            Compare with
          </label>
          <SimpleSelect
            value={component}
            onChange={setComponent}
            options={[
              { value: '', label: comps.isLoading ? 'Loading…' : 'Pick an API…' },
              ...list.map((c) => ({
                value: String(c.id),
                label: `${c.environment ? `${c.environment} · ` : ''}${c.name}${c.has_token ? '' : ' (no token)'}`
              }))
            ]}
            triggerProps={{ id: 'tm-cmp-component' }}
            className='h-7 min-w-[240px] border-[var(--tm-line)] bg-[var(--tm-card)] px-2.5 text-[12px] text-[var(--tm-fg-2)]'
          />
        </div>
        <button
          type='button'
          id='tm-cmp-instances-run'
          className={cn(BTN, BTN_ON)}
          disabled={!component || q.isFetching}
          onClick={() => setAsked(component)}
        >
          {q.isFetching ? 'Asking…' : 'Compare'}
        </button>
        <span className='pb-1 text-[11.5px] text-[var(--tm-muted)]'>
          Last {win === 60 ? 'minute' : `${win / 60} minutes`} on both
        </span>
      </div>
      {q.isError && (
        <p className='px-3.5 pb-2 text-[12px] text-[var(--tm-error-ink)]' role='alert'>
          {errorText(q.error)}
        </p>
      )}
      {d && (
        <div data-tm-compare-instances=''>
          <div className='border-y border-[var(--tm-line-2)] px-3.5 py-2 text-[12px]'>
            <p className='tabular-nums text-[var(--tm-fg-2)]'>
              Here ({d.here.instance}): {fmtCount(d.here.totals.req)} requests · {d.component.name}{' '}
              ({d.there.instance}): {fmtCount(d.there.totals.req)} requests
            </p>
            {instanceSentences(
              d.rows.map((r) => ({ ...r, label: label(r) })),
              d.here.instance || 'This deployment',
              d.there.instance || d.component.name
            ).map((s) => (
              <p key={s} className='mt-0.5'>
                {s}
              </p>
            ))}
          </div>
          <div className='max-h-[320px] overflow-auto'>
            <table className='w-full border-collapse text-[12px] tabular-nums'>
              <thead className='sticky top-0'>
                <tr className='border-b border-[var(--tm-line-2)] bg-[var(--tm-card-2)] text-left'>
                  <th scope='col' className={TH}>
                    Entity
                  </th>
                  <th scope='col' className={`${TH} text-right`}>
                    Here
                  </th>
                  <th scope='col' className={`${TH} text-right`}>
                    {d.component.name}
                  </th>
                  <th scope='col' className={`${TH} text-right`}>
                    Errors here · there
                  </th>
                </tr>
              </thead>
              <tbody>
                {d.rows.map((r) => (
                  <tr
                    key={r.key}
                    className='border-b border-[var(--tm-line-2)] last:border-0'
                    data-tm-instance-row={r.key}
                  >
                    <td className={cn(TD, 'max-w-[260px] truncate')}>
                      {label(r)}
                      {r.only === 'here' && <Only>only here</Only>}
                      {r.only === 'there' && <Only>{`only on ${d.component.name}`}</Only>}
                    </td>
                    <td className={`${TD} text-right`}>{fmtCount(r.here.req)}</td>
                    <td className={`${TD} text-right`}>{fmtCount(r.there.req)}</td>
                    <td className={`${TD} text-right text-[var(--tm-fg-2)]`}>
                      {fmtCount(r.here.error)} · {fmtCount(r.there.error)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

export function ComparePanel() {
  const frozen = useFrozenSnapshotId()
  const [mode, setMode] = useState<'windows' | 'instances'>('windows')
  if (frozen) return null
  return (
    <section
      className='min-w-0 rounded-lg border border-[var(--tm-line)] bg-[var(--tm-card)] min-[1100px]:col-span-2'
      aria-label='Compare'
      id='tm-compare'
    >
      <div className='flex flex-wrap items-center justify-between gap-2 border-b border-[var(--tm-line-2)] px-3.5 py-2'>
        <div>
          <h2 className='text-[13px] font-semibold'>Compare</h2>
          <p className='text-[11.5px] text-[var(--tm-muted)]'>
            {mode === 'windows'
              ? 'Two windows of this deployment, from the request log'
              : 'This deployment against another registered API, live'}
          </p>
        </div>
        <fieldset
          className='inline-flex min-w-0 overflow-hidden rounded-md border border-[var(--tm-line)]'
          aria-label='Compare what'
        >
          {(
            [
              ['windows', 'Two windows'],
              ['instances', 'Another deployment']
            ] as const
          ).map(([id, text], i) => (
            <button
              key={id}
              type='button'
              id={`tm-cmp-mode-${id}`}
              aria-pressed={mode === id}
              onClick={() => setMode(id)}
              className={cn(
                'px-2.5 py-[3px] text-[12px] font-medium leading-tight transition-colors duration-150 ease-out focus-visible:relative focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan',
                i > 0 && 'border-l border-[var(--tm-line)]',
                mode === id
                  ? 'bg-[var(--tm-accent-soft)] text-[var(--tm-accent-ink)]'
                  : 'bg-[var(--tm-card)] text-[var(--tm-fg-2)] hover:bg-[var(--tm-card-2)]'
              )}
            >
              {text}
            </button>
          ))}
        </fieldset>
      </div>
      {mode === 'windows' ? <WindowsCompare /> : <InstanceCompare />}
    </section>
  )
}

register(pagePanels, { id: 'compare', order: 80, Component: ComparePanel })
