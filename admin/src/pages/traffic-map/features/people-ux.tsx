import { type ReactNode, useState } from 'react'
import { cn } from '@/lib/utils'
import { fmtCount, fmtMs } from '../EventTicker'
import { Empty, Section } from '../Inspector'
import { inspectorPanels } from '../registry/inspectorPanels'
import { pagePanels } from '../registry/pagePanels'
import { register } from '../registry/registry'
import { BTN, INPUT, inMapOnly, PanelCard, useTmRoute } from './ops-common'
import { Segmented } from './shared'

/**
 * People and real-user experience lenses (#2190 #2191 #2194 #2202 #2250 #2251 #2149 #2258 #2163
 * #2207): one page panel with a lens switch. Every lens reads GET /traffic-map/people-ux/<lens>
 * (admin only) and shows the worst rows first. Numbers come from real-user timings, the api log
 * and the journeys; a request is given a page by the visit the person had open.
 */

type Lens =
  | 'new'
  | 'devices'
  | 'errors'
  | 'split'
  | 'apdex'
  | 'signin'
  | 'flow'
  | 'notify'
  | 'ai'
  | 'heat'

const LENSES: Array<{ id: Lens; label: string; hint: string }> = [
  { id: 'new', label: 'New people', hint: 'First-week people against everyone else, per page' },
  { id: 'devices', label: 'Browsers', hint: 'Browser, system and screen against load time' },
  { id: 'errors', label: 'Errors by person', hint: 'Who hit the most errors, and where' },
  { id: 'split', label: 'Network or server', hint: 'Where a slow page spends its time' },
  { id: 'apdex', label: 'Apdex', hint: 'Satisfied, tolerating and frustrated, worst first' },
  { id: 'signin', label: 'Sign-in', hint: 'The sign-in path step by step, per method' },
  {
    id: 'flow',
    label: 'Screen flow',
    hint: 'How people move between screens, and what a move costs'
  },
  { id: 'notify', label: 'Notification load', hint: 'People being flooded, and who is sending' },
  { id: 'ai', label: 'AI spend', hint: 'Which screens drive AI cost' },
  { id: 'heat', label: 'Business heat', hint: 'Which zone, region or type the traffic is about' }
]

const TH =
  'whitespace-nowrap px-2.5 py-1.5 text-left text-[11.5px] font-medium text-[var(--tm-muted)]'
const TD = 'px-2.5 py-1 align-top'
const NUM = `${TD} text-right tabular-nums`
const ROW = 'border-b border-[var(--tm-line-2)] last:border-0'
const MONO = 'font-mono text-[11px]'

function Scroll({ children }: { children: ReactNode }) {
  return <div className='max-h-[380px] overflow-auto'>{children}</div>
}
function Note({ children, error }: { children: ReactNode; error?: boolean }) {
  return (
    <p
      role={error ? 'alert' : undefined}
      className={cn(
        'px-3.5 py-3 text-[12px]',
        error ? 'text-[var(--tm-error-ink)]' : 'text-[var(--tm-muted)]'
      )}
    >
      {children}
    </p>
  )
}
/** A lens with no data yet: loading, a failed read, or nothing at all. */
function ReadState({ loading, error }: { loading: boolean; error: boolean }) {
  if (loading) return <Note>Loading…</Note>
  if (error) return <Note error>Could not be read.</Note>
  return <Note>Nothing to show.</Note>
}
function Head({ cols }: { cols: Array<[string, boolean?]> }) {
  return (
    <thead className='sticky top-0'>
      <tr className='border-b border-[var(--tm-line-2)] bg-[var(--tm-card-2)]'>
        {cols.map(([c, right]) => (
          <th key={c} scope='col' className={`${TH} ${right ? 'text-right' : ''}`}>
            {c}
          </th>
        ))}
      </tr>
    </thead>
  )
}
const TABLE = 'w-full border-collapse text-[12px]'
const dash = (n: number | null | undefined) => (n == null ? '—' : fmtMs(n))
const pct = (n: number | null | undefined) => (n == null ? '—' : `${n}%`)

function scoreTone(s: number | null): string {
  if (s == null) return 'text-[var(--tm-muted)]'
  if (s >= 0.94) return 'text-[var(--tm-fg)]'
  if (s >= 0.85) return 'text-[var(--tm-update)]'
  return 'text-[var(--tm-error-ink)]'
}

// ── #2190 ────────────────────────────────────────────────────────────────────
interface Cohort {
  visits: number
  requests: number
  errors: number
  req_per_visit: number | null
  error_rate: number | null
  p50: number | null
  p95: number | null
  rum_p75: number | null
}
function NewPeople({ hours }: { hours: number }) {
  const { data, loading, error } = useTmRoute<{
    new_people: number
    rows: Array<{ screen: string; new: Cohort; experienced: Cohort; slower_by: number | null }>
  }>(['ux', 'new', hours], `/people-ux/new-vs-experienced?hours=${hours}`, 120_000)
  if (!data) return <ReadState loading={loading} error={error} />
  if (data.rows.length === 0)
    return <Note>No page visits by people in their first week in this window.</Note>
  return (
    <>
      <p className='px-3.5 pt-2 text-[11.5px] text-[var(--tm-muted)]'>
        {fmtCount(data.new_people)} people joined in the last 7 days. Calls are given to the page
        the person had open.
      </p>
      <Scroll>
        <table className={TABLE} data-tm-ux='new'>
          <Head
            cols={[
              ['Page'],
              ['Visits (new / others)', true],
              ['Calls per visit', true],
              ['p95 new', true],
              ['p95 others', true],
              ['Errors new', true],
              ['Errors others', true],
              ['Slower by', true]
            ]}
          />
          <tbody>
            {data.rows.map((r) => (
              <tr key={r.screen} className={ROW}>
                <td className={`${TD} ${MONO}`}>{r.screen}</td>
                <td className={NUM}>
                  {r.new.visits} / {r.experienced.visits}
                </td>
                <td className={NUM}>
                  {r.new.req_per_visit ?? '—'} / {r.experienced.req_per_visit ?? '—'}
                </td>
                <td className={NUM}>{dash(r.new.p95)}</td>
                <td className={NUM}>{dash(r.experienced.p95)}</td>
                <td className={NUM}>{pct(r.new.error_rate)}</td>
                <td className={NUM}>{pct(r.experienced.error_rate)}</td>
                <td
                  className={`${NUM} ${(r.slower_by ?? 0) >= 1.5 ? 'text-[var(--tm-error-ink)]' : ''}`}
                >
                  {r.slower_by != null ? `${r.slower_by}x` : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Scroll>
    </>
  )
}

// ── #2191 ────────────────────────────────────────────────────────────────────
function Devices({ hours }: { hours: number }) {
  const { data, loading, error } = useTmRoute<{
    migrated: boolean
    samples: number
    with_device: number
    rows: Array<{
      screen_id: string
      dimension: string
      value: string
      samples: number
      load_p75: number | null
      route_p75: number | null
      page_p75: number | null
      outlier: boolean
    }>
  }>(['ux', 'devices', hours], `/people-ux/devices?hours=${hours}`, 120_000)
  if (!data) return <ReadState loading={loading} error={error} />
  if (data.rows.length === 0)
    return (
      <Note>
        {data.with_device === 0
          ? 'No timings carry a browser yet. They do once people load pages on this version; older timings have none.'
          : 'Every page so far was seen from one browser, system and screen size, so there is nothing to split.'}
      </Note>
    )
  return (
    <Scroll>
      <table className={TABLE} data-tm-ux='devices'>
        <Head
          cols={[
            ['Page'],
            ['By'],
            ['Value'],
            ['Samples', true],
            ['Load p75', true],
            ['Route p75', true],
            ['Page p75', true]
          ]}
        />
        <tbody>
          {data.rows.map((r) => (
            <tr key={`${r.screen_id}|${r.dimension}|${r.value}`} className={ROW}>
              <td className={`${TD} ${MONO}`}>{r.screen_id}</td>
              <td className={TD}>{r.dimension}</td>
              <td className={`${TD} ${r.outlier ? 'font-medium text-[var(--tm-error-ink)]' : ''}`}>
                {r.value}
                {r.outlier ? ' · slower' : ''}
              </td>
              <td className={NUM}>{r.samples}</td>
              <td className={NUM}>{dash(r.load_p75)}</td>
              <td className={NUM}>{dash(r.route_p75)}</td>
              <td className={NUM}>{dash(r.page_p75)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Scroll>
  )
}

// ── #2194 ────────────────────────────────────────────────────────────────────
function ErrorPeople({ hours }: { hours: number }) {
  const { data, loading, error } = useTmRoute<{
    rows: Array<{
      user: string
      name: string
      email: string | null
      client: number
      server: number
      total: number
      pages: Array<{ page: string; n: number }>
      errors: Array<{ text: string; n: number }>
      last_at: string
    }>
  }>(['ux', 'errors', hours], `/people-ux/error-people?hours=${hours}`, 60_000)
  if (!data) return <ReadState loading={loading} error={error} />
  if (data.rows.length === 0) return <Note>Nobody hit an error in this window.</Note>
  return (
    <Scroll>
      <table className={TABLE} data-tm-ux='errors'>
        <Head
          cols={[['Person'], ['Browser', true], ['Server', true], ['Pages'], ['Errors'], ['Last']]}
        />
        <tbody>
          {data.rows.map((r) => (
            <tr key={r.user} className={ROW}>
              <td className={TD}>
                <div className='font-medium'>{r.name}</div>
                {r.email ? (
                  <div className='text-[11px] text-[var(--tm-muted)]'>{r.email}</div>
                ) : null}
              </td>
              <td className={NUM}>{r.client}</td>
              <td className={NUM}>{r.server}</td>
              <td className={`${TD} ${MONO}`}>
                {r.pages.map((p) => (
                  <div key={p.page}>
                    {p.page} <span className='text-[var(--tm-muted)]'>x{p.n}</span>
                  </div>
                ))}
              </td>
              <td className={`${TD} max-w-[300px]`}>
                {r.errors.map((e) => (
                  <div key={e.text} className='truncate' data-tip={e.text}>
                    {e.text} <span className='text-[var(--tm-muted)]'>x{e.n}</span>
                  </div>
                ))}
              </td>
              <td className={`${TD} whitespace-nowrap text-[var(--tm-muted)]`}>
                {new Date(r.last_at).toLocaleString()}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Scroll>
  )
}

// ── #2202 ────────────────────────────────────────────────────────────────────
function Split({ hours }: { hours: number }) {
  const { data, loading, error } = useTmRoute<{
    rows: Array<{
      screen_id: string
      kind: string
      samples: number
      network: number
      server: number
      browser: number
      total: number
      verdict: string
    }>
  }>(['ux', 'split', hours], `/people-ux/network-server?hours=${hours}`, 120_000)
  if (!data) return <ReadState loading={loading} error={error} />
  if (data.rows.length === 0) return <Note>No browser timings in this window.</Note>
  return (
    <>
      <p className='px-3.5 pt-2 text-[11.5px] text-[var(--tm-muted)]'>
        An estimate. Network is the wait for the first byte, server is the slowest call the page
        waited on, browser is the rest. A route change has no first-byte wait.
      </p>
      <Scroll>
        <table className={TABLE} data-tm-ux='split'>
          <Head
            cols={[
              ['Page'],
              ['Kind'],
              ['Samples', true],
              ['Total', true],
              ['Network', true],
              ['Server', true],
              ['Browser', true],
              ['Mostly']
            ]}
          />
          <tbody>
            {data.rows.map((r) => (
              <tr key={`${r.screen_id}|${r.kind}`} className={ROW}>
                <td className={`${TD} ${MONO}`}>{r.screen_id}</td>
                <td className={TD}>{r.kind === 'load' ? 'page load' : 'route change'}</td>
                <td className={NUM}>{r.samples}</td>
                <td className={NUM}>{fmtMs(r.total)}</td>
                <td className={NUM}>{fmtMs(r.network)}</td>
                <td className={NUM}>{fmtMs(r.server)}</td>
                <td className={NUM}>{fmtMs(r.browser)}</td>
                <td className={TD}>{r.verdict}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Scroll>
    </>
  )
}

// ── #2250 ────────────────────────────────────────────────────────────────────
interface ApdexSide {
  n: number
  satisfied: number
  tolerating: number
  frustrated: number
  score: number | null
}
const TARGETS_KEY = 'nivaro.trafficmap.apdex'
function readTargets(): { page: number; request: number } {
  try {
    const v = JSON.parse(localStorage.getItem(TARGETS_KEY) ?? '{}')
    return { page: Number(v.page) || 1000, request: Number(v.request) || 500 }
  } catch {
    return { page: 1000, request: 500 }
  }
}
function Apdex({ hours }: { hours: number }) {
  const [by, setBy] = useState<'page' | 'person'>('page')
  const [t, setT] = useState(readTargets)
  const [draft, setDraft] = useState({ page: String(t.page), request: String(t.request) })
  const { data, loading, error } = useTmRoute<{
    page_target_ms: number
    request_target_ms: number
    rows: Array<{
      id: string
      label: string
      page: ApdexSide
      request: ApdexSide
      weeks: Array<{ week: string; page: number | null; request: number | null }>
    }>
  }>(
    ['ux', 'apdex', hours, by, t.page, t.request],
    `/people-ux/apdex?hours=${hours}&by=${by}&page_ms=${t.page}&request_ms=${t.request}`,
    120_000
  )
  const apply = () => {
    const next = {
      page: Math.min(60_000, Math.max(100, Number(draft.page) || 1000)),
      request: Math.min(60_000, Math.max(50, Number(draft.request) || 500))
    }
    setT(next)
    try {
      localStorage.setItem(TARGETS_KEY, JSON.stringify(next))
    } catch {
      /* private window: the targets last for this visit */
    }
  }
  return (
    <>
      <div className='flex flex-wrap items-center gap-2 px-3.5 pt-2 text-[12px]'>
        <Segmented
          label='Group by'
          value={by}
          options={[
            ['page', 'Per page'],
            ['person', 'Per person']
          ]}
          onChange={setBy}
        />
        <label className='flex items-center gap-1 text-[var(--tm-muted)]'>
          Page target (ms)
          <input
            className={`${INPUT} w-20`}
            inputMode='numeric'
            value={draft.page}
            onChange={(e) => setDraft({ ...draft, page: e.target.value })}
            onBlur={apply}
            onKeyDown={(e) => e.key === 'Enter' && apply()}
          />
        </label>
        <label className='flex items-center gap-1 text-[var(--tm-muted)]'>
          Request target (ms)
          <input
            className={`${INPUT} w-20`}
            inputMode='numeric'
            value={draft.request}
            onChange={(e) => setDraft({ ...draft, request: e.target.value })}
            onBlur={apply}
            onKeyDown={(e) => e.key === 'Enter' && apply()}
          />
        </label>
      </div>
      {!data ? (
        <ReadState loading={loading} error={error} />
      ) : data.rows.length === 0 ? (
        <Note>Not enough timings yet.</Note>
      ) : (
        <Scroll>
          <table className={TABLE} data-tm-ux='apdex'>
            <Head
              cols={[
                [by === 'page' ? 'Page' : 'Person'],
                ['Page apdex', true],
                ['Samples', true],
                ['Request apdex', true],
                ['Samples', true],
                ['By week (page / request)']
              ]}
            />
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.id} className={ROW}>
                  <td className={`${TD} ${by === 'page' ? MONO : ''}`}>{r.label}</td>
                  <td className={`${NUM} ${scoreTone(r.page.score)}`}>{r.page.score ?? '—'}</td>
                  <td className={NUM}>{r.page.n}</td>
                  <td className={`${NUM} ${scoreTone(r.request.score)}`}>
                    {r.request.score ?? '—'}
                  </td>
                  <td className={NUM}>{r.request.n}</td>
                  <td className={`${TD} text-[11px] tabular-nums text-[var(--tm-muted)]`}>
                    {r.weeks.map((w) => (
                      <span key={w.week} className='mr-2 whitespace-nowrap'>
                        {w.week.slice(5)}: {w.page ?? '—'} / {w.request ?? '—'}
                      </span>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Scroll>
      )}
    </>
  )
}

// ── #2251 ────────────────────────────────────────────────────────────────────
const METHOD_LABEL: Record<string, string> = {
  microsoft: 'Microsoft',
  saml: 'SAML',
  password: 'Password',
  token: 'Token'
}
function SignIn({ hours }: { hours: number }) {
  const { data, loading, error } = useTmRoute<{
    funnels: Array<{
      method: string
      attempts: number
      completed: number
      steps: Array<{
        key: string
        label: string
        reached: number
        failed: number
        p50_ms: number | null
        p95_ms: number | null
      }>
    }>
  }>(['ux', 'signin', hours], `/people-ux/signin-funnel?hours=${hours}`, 120_000)
  if (!data) return <ReadState loading={loading} error={error} />
  if (data.funnels.length === 0) return <Note>No sign-ins in this window.</Note>
  return (
    <div className='grid gap-3 px-3.5 py-3 min-[900px]:grid-cols-2' data-tm-ux='signin'>
      {data.funnels.map((f) => {
        const top = Math.max(1, f.steps[0]?.reached ?? f.attempts)
        return (
          <div key={f.method}>
            <h3 className='mb-1 text-[12px] font-medium'>
              {METHOD_LABEL[f.method] ?? f.method}{' '}
              <span className='font-normal text-[var(--tm-muted)]'>
                {f.attempts} attempts · {f.completed} reached a first page
              </span>
            </h3>
            <div className='grid gap-1'>
              {f.steps.map((s) => (
                <div key={s.key} className='text-[12px]'>
                  <div className='flex items-baseline justify-between gap-2'>
                    <span>{s.label}</span>
                    <span className='tabular-nums text-[var(--tm-muted)]'>
                      {s.reached}
                      {s.failed ? (
                        <span className='text-[var(--tm-error-ink)]'> · {s.failed} failed</span>
                      ) : null}
                      {s.p50_ms != null ? ` · p50 ${fmtMs(s.p50_ms)}` : ''}
                      {s.p95_ms != null ? ` · p95 ${fmtMs(s.p95_ms)}` : ''}
                    </span>
                  </div>
                  <div className='h-1.5 overflow-hidden rounded-full bg-[var(--tm-card-2)]'>
                    <div
                      className='h-full rounded-full bg-[var(--tm-accent)]'
                      style={{ width: `${Math.min(100, (100 * s.reached) / top)}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── #2149 ────────────────────────────────────────────────────────────────────
interface Edge {
  from: string
  to: string
  moves: number
  requests: number
  per_move: number | null
}
/** Source and target columns joined by bands as wide as the moves: a plain two-column flow. */
function FlowDiagram({ edges }: { edges: Edge[] }) {
  const top = edges.slice(0, 14)
  const side = (pick: (e: Edge) => string) => {
    const m = new Map<string, number>()
    for (const e of top) m.set(pick(e), (m.get(pick(e)) ?? 0) + e.moves)
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }
  const left = side((e) => e.from)
  const right = side((e) => e.to)
  const ROWH = 22
  const H = Math.max(left.length, right.length) * ROWH + 8
  const W = 760
  const L = 250
  const R = W - 250
  const yOf = (list: Array<[string, number]>, name: string) =>
    list.findIndex(([n]) => n === name) * ROWH + ROWH / 2 + 4
  const max = Math.max(1, ...top.map((e) => e.moves))
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className='w-full'
      role='img'
      aria-label='Screen to screen flow'
      data-tm-ux-flow=''
    >
      {top.map((e) => {
        const y1 = yOf(left, e.from)
        const y2 = yOf(right, e.to)
        return (
          <path
            key={`${e.from}>${e.to}`}
            d={`M${L},${y1} C${(L + R) / 2},${y1} ${(L + R) / 2},${y2} ${R},${y2}`}
            fill='none'
            stroke='var(--tm-accent)'
            strokeOpacity={0.45}
            strokeWidth={1 + (7 * e.moves) / max}
          >
            <title>{`${e.from} to ${e.to}: ${e.moves} moves, ${e.per_move ?? 0} calls each`}</title>
          </path>
        )
      })}
      {left.map(([n], i) => (
        <text
          key={`l${n}`}
          x={L - 6}
          y={i * ROWH + ROWH / 2 + 8}
          textAnchor='end'
          fontSize='11'
          fill='var(--tm-fg-2)'
          fontFamily='ui-monospace, monospace'
        >
          {n.length > 34 ? `…${n.slice(-33)}` : n}
        </text>
      ))}
      {right.map(([n], i) => (
        <text
          key={`r${n}`}
          x={R + 6}
          y={i * ROWH + ROWH / 2 + 8}
          fontSize='11'
          fill='var(--tm-fg-2)'
          fontFamily='ui-monospace, monospace'
        >
          {n.length > 34 ? `…${n.slice(-33)}` : n}
        </text>
      ))}
    </svg>
  )
}
function Flow({ hours }: { hours: number }) {
  const [app, setApp] = useState<string>('')
  const { data, loading, error } = useTmRoute<{ apps: string[]; edges: Edge[] }>(
    ['ux', 'flow', hours, app],
    `/people-ux/flow?hours=${hours}${app ? `&app=${encodeURIComponent(app)}` : ''}`,
    120_000
  )
  if (!data) return <ReadState loading={loading} error={error} />
  return (
    <>
      {data.apps.length > 1 ? (
        <div className='flex flex-wrap gap-1.5 px-3.5 pt-2'>
          <Segmented
            label='App'
            value={app}
            options={['', ...data.apps].map((a): [string, string] => [a, a || 'All apps'])}
            onChange={setApp}
          />
        </div>
      ) : null}
      {data.edges.length === 0 ? (
        <Note>No moves between screens in this window.</Note>
      ) : (
        <>
          <div className='px-3.5 py-2'>
            <FlowDiagram edges={data.edges} />
          </div>
          <Scroll>
            <table className={TABLE} data-tm-ux='flow'>
              <Head
                cols={[
                  ['From'],
                  ['To'],
                  ['Moves', true],
                  ['Calls', true],
                  ['Calls per move', true]
                ]}
              />
              <tbody>
                {data.edges.map((e) => (
                  <tr key={`${e.from}>${e.to}`} className={ROW}>
                    <td className={`${TD} ${MONO}`}>{e.from}</td>
                    <td className={`${TD} ${MONO}`}>{e.to}</td>
                    <td className={NUM}>{e.moves}</td>
                    <td className={NUM}>{e.requests}</td>
                    <td className={NUM}>{e.per_move ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Scroll>
        </>
      )}
    </>
  )
}

// ── #2258 ────────────────────────────────────────────────────────────────────
function Spark({ values }: { values: number[] }) {
  const max = Math.max(1, ...values)
  return (
    <svg viewBox={`0 0 ${values.length * 4} 16`} className='h-4 w-24' aria-hidden='true'>
      {values.map((v, i) => (
        <rect
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed hourly slots
          key={i}
          x={i * 4}
          y={16 - (16 * v) / max}
          width={3}
          height={(16 * v) / max}
          fill='var(--tm-accent)'
        />
      ))}
    </svg>
  )
}
function Notify({ hours }: { hours: number }) {
  const h = Math.min(hours, 72)
  const { data, loading, error } = useTmRoute<{
    threshold: number
    total: number
    rows: Array<{
      user: string
      name: string
      total: number
      peak: number
      peak_hour: string
      per_hour: number[]
      channels: Record<string, number>
      categories: Array<{ name: string; n: number }>
      senders: Array<{ name: string; n: number }>
    }>
  }>(['ux', 'notify', h], `/people-ux/notification-pressure?hours=${h}`, 120_000)
  if (!data) return <ReadState loading={loading} error={error} />
  if (data.rows.length === 0)
    return (
      <Note>
        Nobody got {data.threshold} or more notifications in an hour ({fmtCount(data.total)} sent in
        the window).
      </Note>
    )
  return (
    <Scroll>
      <table className={TABLE} data-tm-ux='notify'>
        <Head
          cols={[
            ['Person'],
            ['Peak / hour', true],
            ['Total', true],
            ['Hours'],
            ['Channels'],
            ['Categories'],
            ['Senders']
          ]}
        />
        <tbody>
          {data.rows.map((r) => (
            <tr key={r.user} className={ROW}>
              <td className={TD}>{r.name}</td>
              <td className={NUM} data-tip={`at ${new Date(r.peak_hour).toLocaleString()}`}>
                {r.peak}
              </td>
              <td className={NUM}>{r.total}</td>
              <td className={TD}>
                <Spark values={r.per_hour} />
              </td>
              <td className={TD}>
                {Object.entries(r.channels)
                  .map(([c, n]) => `${c} ${n}`)
                  .join(' · ')}
              </td>
              <td className={TD}>{r.categories.map((c) => `${c.name} ${c.n}`).join(' · ')}</td>
              <td className={TD}>{r.senders.map((c) => `${c.name} ${c.n}`).join(' · ')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Scroll>
  )
}

// ── #2163 ────────────────────────────────────────────────────────────────────
interface AiRow {
  screen: string
  calls: number
  cost: number
  tokens: number
  errors: number
  features: Array<{ feature: string; calls: number; cost: number }>
}
const usd = (n: number) => `$${n < 1 ? n.toFixed(3) : n.toFixed(2)}`
function AiTable({ rows }: { rows: AiRow[] }) {
  return (
    <Scroll>
      <table className={TABLE} data-tm-ux='ai'>
        <Head
          cols={[
            ['Screen'],
            ['Cost', true],
            ['Calls', true],
            ['Tokens', true],
            ['Failed', true],
            ['Features']
          ]}
        />
        <tbody>
          {rows.map((r) => (
            <tr key={r.screen} className={ROW}>
              <td className={`${TD} ${MONO}`}>{r.screen}</td>
              <td className={NUM}>{usd(r.cost)}</td>
              <td className={NUM}>{r.calls}</td>
              <td className={NUM}>{fmtCount(r.tokens)}</td>
              <td className={NUM}>{r.errors || '—'}</td>
              <td className={TD}>
                {r.features.map((f) => `${f.feature} ${usd(f.cost)}`).join(' · ')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Scroll>
  )
}
function AiSpend({ hours }: { hours: number }) {
  const { data, loading, error } = useTmRoute<{
    total_cost: number
    total_calls: number
    rows: AiRow[]
  }>(['ux', 'ai', hours], `/people-ux/ai-cost?hours=${hours}`, 120_000)
  if (!data) return <ReadState loading={loading} error={error} />
  if (data.rows.length === 0) return <Note>No AI calls in this window.</Note>
  return (
    <>
      <p className='px-3.5 pt-2 text-[11.5px] text-[var(--tm-muted)]'>
        {usd(data.total_cost)} over {fmtCount(data.total_calls)} calls. A call lands on the screen
        its person had open when it ran.
      </p>
      <AiTable rows={data.rows} />
    </>
  )
}

// ── #2207 ────────────────────────────────────────────────────────────────────
function Heat() {
  const [win, setWin] = useState(300)
  const { data, loading, error } = useTmRoute<{
    dropped: number
    attributed: number
    rows: Array<{ dimension: string; id: string; label: string; reads: number; writes: number }>
  }>(['ux', 'heat', win], `/people-ux/business-heat?window=${win}`, 10_000)
  const max = Math.max(1, ...(data?.rows ?? []).map((r) => r.reads + r.writes * 3))
  return (
    <>
      <div className='flex flex-wrap items-center gap-1.5 px-3.5 pt-2'>
        <Segmented
          label='Window'
          value={win}
          options={[60, 300, 900].map((w): [number, string] => [w, `${w / 60} min`])}
          onChange={setWin}
        />
        <span className='text-[11.5px] text-[var(--tm-muted)]'>
          Single-record reads and writes, by the dimension value the record belongs to. Counted
          while this page is open.
        </span>
      </div>
      {!data ? (
        <ReadState loading={loading} error={error} />
      ) : data.rows.length === 0 ? (
        <Note>
          No attributed traffic yet. It fills as records are opened or saved while this page is
          open, and needs at least one active User Scope dimension.
        </Note>
      ) : (
        <Scroll>
          <table className={TABLE} data-tm-ux='heat'>
            <Head cols={[['Dimension'], ['Value'], ['Reads', true], ['Writes', true], ['Heat']]} />
            <tbody>
              {data.rows.map((r) => (
                <tr key={`${r.dimension}:${r.id}`} className={ROW}>
                  <td className={TD}>{r.dimension}</td>
                  <td className={TD}>{r.label}</td>
                  <td className={NUM}>{r.reads}</td>
                  <td className={NUM}>{r.writes}</td>
                  <td className={`${TD} w-40`}>
                    <div className='h-1.5 overflow-hidden rounded-full bg-[var(--tm-card-2)]'>
                      <div
                        className='h-full rounded-full bg-[var(--tm-accent)]'
                        style={{ width: `${(100 * (r.reads + r.writes * 3)) / max}%` }}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Scroll>
      )}
      {data && data.dropped > 0 ? (
        <p className='px-3.5 pb-2 text-[11.5px] text-[var(--tm-muted)]'>
          {data.dropped} records were not counted because the queue was full.
        </p>
      ) : null}
    </>
  )
}

// ── the panel ────────────────────────────────────────────────────────────────
const RANGES = [
  { hours: 24, label: '24 hours' },
  { hours: 168, label: '7 days' }
]

function PeopleUxPanel() {
  const [lens, setLens] = useState<Lens>('new')
  const [hours, setHours] = useState(24)
  const cur = LENSES.find((l) => l.id === lens) as (typeof LENSES)[number]
  return (
    <div className='min-w-0'>
      <PanelCard
        title='People and experience'
        id='tm-people-ux'
        hint={cur.hint}
        actions={
          lens === 'heat' ? undefined : (
            <div className='flex shrink-0'>
              <Segmented
                label='Range'
                value={hours}
                options={RANGES.map((r): [number, string] => [r.hours, r.label])}
                onChange={setHours}
              />
            </div>
          )
        }
      >
        <div
          className='flex flex-wrap gap-1.5 border-b border-[var(--tm-line-2)] px-3.5 py-2'
          role='tablist'
          aria-label='Lens'
        >
          {LENSES.map((l) => (
            <button
              key={l.id}
              type='button'
              role='tab'
              aria-selected={lens === l.id}
              className={cn(
                BTN,
                lens === l.id && 'bg-[var(--tm-accent-soft)] text-[var(--tm-accent-ink)]'
              )}
              onClick={() => setLens(l.id)}
            >
              {l.label}
            </button>
          ))}
        </div>
        {lens === 'new' && <NewPeople hours={hours} />}
        {lens === 'devices' && <Devices hours={hours} />}
        {lens === 'errors' && <ErrorPeople hours={hours} />}
        {lens === 'split' && <Split hours={hours} />}
        {lens === 'apdex' && <Apdex hours={hours} />}
        {lens === 'signin' && <SignIn hours={hours} />}
        {lens === 'flow' && <Flow hours={hours} />}
        {lens === 'notify' && <Notify hours={hours} />}
        {lens === 'ai' && <AiSpend hours={hours} />}
        {lens === 'heat' && <Heat />}
      </PanelCard>
    </div>
  )
}

/** The AI provider node: which screens drive its spend (#2163). */
function AiScreens() {
  const { data, loading, error } = useTmRoute<{ rows: AiRow[] }>(
    ['ux', 'ai-node'],
    '/people-ux/ai-cost?hours=168',
    120_000
  )
  const rows = (data?.rows ?? []).slice(0, 6)
  return (
    <Section title='Screens driving AI spend (7 days)'>
      {rows.length === 0 ? (
        <Empty>
          {loading ? 'Loading…' : error ? 'Could not be read.' : 'No AI calls in the last 7 days.'}
        </Empty>
      ) : (
        <ul className='grid gap-1 text-[12px]' data-tm-ai-screens=''>
          {rows.map((r) => (
            <li key={r.screen} className='flex justify-between gap-2'>
              <span className={`${MONO} truncate`} data-tip={r.screen}>
                {r.screen}
              </span>
              <span className='shrink-0 tabular-nums'>
                {usd(r.cost)} <span className='text-[var(--tm-muted)]'>{r.calls} calls</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}

register(pagePanels, {
  id: 'people-ux',
  order: 75,
  wide: true,
  Component: inMapOnly(PeopleUxPanel)
})
register(inspectorPanels, {
  id: 'ai-screens',
  order: 50,
  applies: (sel) => sel.kind === 'down' && sel.id.startsWith('ai:'),
  Component: AiScreens
})
