import type { RelayHealth } from '../mail-stats.js'
import {
  ACTED_ELIGIBLE,
  ACTED_VALUES,
  bucketKeys,
  CHANNEL_LABELS,
  CHANNEL_STATUSES,
  CHANNELS,
  type Channel,
  type Cond,
  channelOutcome,
  channelStatusLabel,
  dimOf,
  ignoredFilters,
  MAIL_OUTCOME_LABELS,
  MAIL_OUTCOMES,
  MAIL_REASONS,
  type MailOutcome,
  mailReason,
  NOT_RECORDED,
  OUTCOME_LABELS,
  OUTCOMES,
  type Outcome,
  type PageFilters,
  pageFilterConds,
  type Registry,
  reasonLabel,
  SENDER_TYPE_LABELS,
  type Source,
  type Window
} from './model.js'
import { type AggQuery, type Executor, type Span, TIMED } from './query.js'

/**
 * One number on the page and the rows behind it: `n` is what is shown, and
 * opening it lists exactly the rows of `s` (in the window, under the page
 * filters) that match every condition in `w`. `win: 'prev'` = counted over the
 * previous period instead.
 */
export interface Cell {
  n: number
  s: Source
  w: Cond[]
  win?: 'prev'
}

export interface Labeler {
  users(ids: string[]): Promise<Map<string, string>>
  roles(ids: string[]): Promise<Map<string, string>>
  template(key: string): string | null
  category(key: string): string
}

/** Measures every notification breakdown counts, as conditions. */
export const N_MEASURES: Record<string, Cond[]> = {
  sent: [],
  read: [['read', ['read']]],
  unread: [['read', ['unread']]],
  timed: [TIMED],
  acted: [['acted', ['acted']]],
  eligible: [['acted', ACTED_ELIGIBLE]],
  read_ignored: [['acted', ['read_no_action']]]
}

export const BREAKDOWN_DIMS = [
  'category',
  'lane',
  'kind',
  'sender',
  'sender_type',
  'collection',
  'recipient_role',
  'reason'
] as const
export type BreakdownDim = (typeof BREAKDOWN_DIMS)[number]

export const FLOOD_PER_HOUR_DEFAULT = 10
export const NEVER_READ_MIN = 5
export const NOISY_MIN = 20
export const NOISY_READ_RATE = 0.25

export interface SummaryInput {
  exec: Executor
  reg: Registry
  window: Window
  filters: PageFilters
  actedHours: number
  labels: Labeler
  /** The newest relay attempts, judged by relayHealth (not window-bound). */
  relay: RelayHealth | null
  floodPerHour: number
  mutes: boolean
}

/** Run at most `limit` query bodies at once (each holds a pool connection). */
async function inBatches<T>(limit: number, jobs: Array<() => Promise<T>>): Promise<T[]> {
  const out: T[] = new Array(jobs.length)
  let next = 0
  const worker = async () => {
    while (next < jobs.length) {
      const i = next++
      out[i] = await (jobs[i] as () => Promise<T>)()
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker))
  return out
}

const plus = (base: Cond[], more: Cond[]): Cond[] => [...base, ...more]
const span = (w: Window): Span => ({ from: w.from, to: w.to })
const prevSpan = (w: Window): Span => ({ from: w.prevFrom, to: w.prevTo })

export function cell(n: number, s: Source, w: Cond[], prev = false): Cell {
  return prev ? { n, s, w, win: 'prev' } : { n, s, w }
}

export interface BreakdownRow {
  key: string
  label: string
  sent: Cell
  read: Cell
  unread: Cell
  timed: Cell
  acted: Cell
  eligible: Cell
  read_ignored: Cell
  p50: number | null
  p90: number | null
}

export interface Breakdown {
  by: BreakdownDim
  label: string
  rows: BreakdownRow[]
  /** More groups exist than the rows shown (the busiest are kept). */
  more: boolean
}

export const BREAKDOWN_LIMIT = 30

async function labelFor(
  reg: Registry,
  source: Source,
  dim: string,
  keys: string[],
  labels: Labeler
): Promise<Map<string, string>> {
  const d = dimOf(reg, source, dim)
  const out = new Map<string, string>()
  const real = keys.filter((k) => k !== '(none)' && k !== '__system__' && k !== NOT_RECORDED)
  if (d.labelled === 'user') {
    const names = await labels.users(real)
    for (const k of keys)
      out.set(
        k,
        k === '__system__'
          ? 'System and automations'
          : k === '(none)'
            ? 'Nobody'
            : (names.get(k.toUpperCase()) ?? 'Unknown person')
      )
  } else if (d.labelled === 'role') {
    const names = await labels.roles(real)
    for (const k of keys) out.set(k, k === '(none)' ? 'No role' : (names.get(k.toUpperCase()) ?? k))
  } else if (d.labelled === 'category') {
    for (const k of keys) out.set(k, k === '(none)' ? 'Uncategorised' : labels.category(k))
  } else if (d.labelled === 'reason') {
    for (const k of keys) out.set(k, reasonLabel(k))
  } else if (d.labelled === 'template') {
    for (const k of keys) out.set(k, labels.template(k) ?? k)
  } else if (d.labelled === 'mail_reason') {
    for (const k of keys) out.set(k, mailReason(k)?.label ?? k)
  } else if (dim === 'sender_type') {
    for (const k of keys) out.set(k, SENDER_TYPE_LABELS[k] ?? k)
  } else if (dim === 'acted') {
    for (const k of keys) out.set(k, ACTED_VALUES[k as keyof typeof ACTED_VALUES] ?? k)
  } else if (dim === 'read') {
    for (const k of keys) out.set(k, k === 'read' ? 'Read' : 'Unread')
  } else if (dim === 'outcome') {
    for (const k of keys) out.set(k, MAIL_OUTCOME_LABELS[k as MailOutcome] ?? k)
  } else if (dim.startsWith('ch.')) {
    const c = dim.slice(3) as Channel
    for (const k of keys) out.set(k, channelStatusLabel(c, k))
  } else if (dim.startsWith('ch_outcome.')) {
    for (const k of keys) out.set(k, OUTCOME_LABELS[k as Outcome] ?? k)
  } else {
    for (const k of keys)
      out.set(k, k === '(none)' ? 'None' : k === '(untemplated)' ? 'No template' : k)
  }
  return out
}

/** One notification split (the breakdown table): the busiest groups with every measure. */
export async function buildBreakdown(
  input: Pick<SummaryInput, 'exec' | 'reg' | 'window' | 'filters' | 'labels'>,
  by: BreakdownDim
): Promise<Breakdown> {
  const { exec, reg, window, filters } = input
  const where = pageFilterConds('n', filters)
  const [groups, pct] = await Promise.all([
    exec.aggregate({
      source: 'n',
      span: span(window),
      where,
      groupBy: [by],
      measures: N_MEASURES,
      top: { by: 'sent', n: BREAKDOWN_LIMIT + 1 }
    }),
    exec.percentiles({ span: span(window), where, groupBy: [by] })
  ])
  const shown = groups.slice(0, BREAKDOWN_LIMIT)
  const pctBy = new Map(pct.map((p) => [p.keys[0], p]))
  const names = await labelFor(
    reg,
    'n',
    by,
    shown.map((g) => g.keys[0] as string),
    input.labels
  )
  return {
    by,
    label: dimOf(reg, 'n', by).label,
    more: groups.length > BREAKDOWN_LIMIT,
    rows: shown.map((g) => {
      const key = g.keys[0] as string
      const base: Cond[] = [[by, [key]]]
      const c = (m: keyof typeof N_MEASURES) =>
        cell(g.counts[m] ?? 0, 'n', plus(base, N_MEASURES[m] as Cond[]))
      return {
        key,
        label: names.get(key) ?? key,
        sent: c('sent'),
        read: c('read'),
        unread: c('unread'),
        timed: c('timed'),
        acted: c('acted'),
        eligible: c('eligible'),
        read_ignored: c('read_ignored'),
        p50: pctBy.get(key)?.p50 ?? null,
        p90: pctBy.get(key)?.p90 ?? null
      }
    })
  }
}

export interface SplitRow {
  key: string
  label: string
  cell: Cell
}

/** Counts of a drill's rows split by one more dimension (composing a drill one step further). */
export async function buildSplit(
  input: Pick<SummaryInput, 'exec' | 'reg' | 'labels'>,
  q: { source: Source; span: Span | null; filters: PageFilters; where: Cond[]; by: string }
): Promise<{ by: string; label: string; rows: SplitRow[]; more: boolean }> {
  const d = dimOf(input.reg, q.source, q.by)
  const groups = await input.exec.aggregate({
    source: q.source,
    span: q.span,
    where: [...pageFilterConds(q.source, q.filters), ...q.where],
    groupBy: [q.by],
    measures: { all: [] },
    top: { by: 'all', n: 51 }
  })
  const shown = groups.slice(0, 50)
  const names = await labelFor(
    input.reg,
    q.source,
    q.by,
    shown.map((g) => g.keys[0] as string),
    input.labels
  )
  return {
    by: q.by,
    label: d.label,
    more: groups.length > 50,
    rows: shown.map((g) => {
      const key = g.keys[0] as string
      return {
        key,
        label: names.get(key) ?? key,
        cell: cell(g.counts.all ?? 0, q.source, [...q.where, [q.by, [key]]])
      }
    })
  }
}

export interface HealthItem {
  id: string
  tone: 'bad' | 'warn'
  title: string
  detail: string
  cell?: Cell
}

export async function buildSummary(input: SummaryInput) {
  const { exec, reg, window, filters } = input
  const nWhere = pageFilterConds('n', filters)
  const mWhere = pageFilterConds('m', filters)
  const cur = span(window)
  const prev = prevSpan(window)
  const bucketDim = window.bucket
  const headlineMeasures: Record<string, Cond[]> = N_MEASURES

  const q = (a: AggQuery) => () => exec.aggregate(a)
  const jobs = [
    q({ source: 'n', span: cur, where: nWhere, groupBy: [], measures: headlineMeasures }),
    q({ source: 'n', span: prev, where: nWhere, groupBy: [], measures: headlineMeasures }),
    q({
      source: 'm',
      span: cur,
      where: mWhere,
      groupBy: ['template', 'reason'],
      measures: { all: [] }
    }),
    q({ source: 'm', span: prev, where: mWhere, groupBy: ['reason'], measures: { all: [] } }),
    q({
      source: 'n',
      span: cur,
      where: nWhere,
      groupBy: [bucketDim],
      measures: { sent: [], read: N_MEASURES.read as Cond[] }
    }),
    q({
      source: 'm',
      span: cur,
      where: mWhere,
      groupBy: [bucketDim, 'outcome'],
      measures: { all: [] }
    }),
    q({
      source: 'n',
      span: cur,
      where: nWhere,
      groupBy: CHANNELS.map((c) => `ch.${c}`),
      measures: { all: [] }
    }),
    q({
      source: 'n',
      span: cur,
      where: nWhere,
      groupBy: ['recipient'],
      measures: { sent: [], read: N_MEASURES.read as Cond[], unread: N_MEASURES.unread as Cond[] }
    }),
    q({
      source: 'n',
      span: cur,
      where: nWhere,
      groupBy: ['recipient', 'hour'],
      measures: { all: [] },
      having: { measure: 'all', min: input.floodPerHour + 1 },
      top: { by: 'all', n: 25 }
    }),
    q({
      source: 'n',
      span: cur,
      where: nWhere,
      groupBy: ['sender'],
      measures: { sent: [], read: N_MEASURES.read as Cond[] },
      top: { by: 'sent', n: 10 }
    }),
    ...(reg.features.resend
      ? [
          q({
            source: 'm',
            span: cur,
            where: mWhere,
            groupBy: [],
            measures: { resend: [['resend', ['yes']]] }
          })
        ]
      : []),
    ...(input.mutes
      ? [
          q({ source: 'x', span: null, where: [], groupBy: ['collection'], measures: { all: [] } }),
          q({
            source: 'n',
            span: cur,
            where: nWhere,
            groupBy: ['collection'],
            measures: { sent: [] }
          })
        ]
      : [])
  ]
  const [aggs, ttrCur, ttrPrev, breakdown] = await Promise.all([
    inBatches(4, jobs),
    exec.percentiles({ span: cur, where: nWhere, groupBy: [] }),
    exec.percentiles({ span: prev, where: nWhere, groupBy: [] }),
    buildBreakdown(input, 'category')
  ])
  let i = 0
  const take = () => aggs[i++] ?? []
  const headCur = take()[0]?.counts ?? {}
  const headPrev = take()[0]?.counts ?? {}
  const mailCur = take()
  const mailPrev = take()
  const nSeries = take()
  const mSeries = take()
  const chanRows = take()
  const people = take()
  const floods = take()
  const senders = take()
  const resend = reg.features.resend ? (take()[0]?.counts.resend ?? 0) : null
  const muteRows = input.mutes ? take() : []
  const muteSent = input.mutes ? take() : []

  // ── Headline ────────────────────────────────────────────────────────────
  const hc = (m: string, isPrev = false) =>
    cell((isPrev ? headPrev : headCur)[m] ?? 0, 'n', headlineMeasures[m] as Cond[], isPrev)
  const mailOutcome = (rows: typeof mailCur, idx: number) => {
    const by = new Map<MailOutcome, number>()
    let total = 0
    for (const r of rows) {
      const reason = r.keys[idx] as string
      const o = mailReason(reason)?.outcome ?? 'other'
      by.set(o, (by.get(o) ?? 0) + (r.counts.all ?? 0))
      total += r.counts.all ?? 0
    }
    return { by, total }
  }
  const mc = mailOutcome(mailCur, 1)
  const mp = mailOutcome(mailPrev, 0)
  const headline = {
    sent: hc('sent'),
    sent_prev: hc('sent', true),
    read: hc('read'),
    read_prev: hc('read', true),
    unread: hc('unread'),
    timed: hc('timed'),
    timed_prev: hc('timed', true),
    ttr: { p50: ttrCur[0]?.p50 ?? null, p90: ttrCur[0]?.p90 ?? null },
    ttr_prev: { p50: ttrPrev[0]?.p50 ?? null, p90: ttrPrev[0]?.p90 ?? null },
    acted: hc('acted'),
    acted_prev: hc('acted', true),
    eligible: hc('eligible'),
    eligible_prev: hc('eligible', true),
    read_ignored: hc('read_ignored'),
    email_total: cell(mc.total, 'm', []),
    email_total_prev: cell(mp.total, 'm', [], true),
    email_delivered: cell(mc.by.get('delivered') ?? 0, 'm', [['outcome', ['delivered']]]),
    email_delivered_prev: cell(
      mp.by.get('delivered') ?? 0,
      'm',
      [['outcome', ['delivered']]],
      true
    ),
    email_failed: cell(mc.by.get('failed') ?? 0, 'm', [['outcome', ['failed']]]),
    email_failed_prev: cell(mp.by.get('failed') ?? 0, 'm', [['outcome', ['failed']]], true)
  }

  // ── Series ──────────────────────────────────────────────────────────────
  const nBy = new Map(nSeries.map((r) => [r.keys[0], r.counts]))
  const mBy = new Map<string, Map<string, number>>()
  for (const r of mSeries) {
    const k = r.keys[0] as string
    const o = r.keys[1] as string
    const m = mBy.get(k) ?? new Map<string, number>()
    m.set(o, (m.get(o) ?? 0) + (r.counts.all ?? 0))
    mBy.set(k, m)
  }
  const series = bucketKeys(window).map((b) => {
    const bc: Cond = [bucketDim, [b]]
    const mm = mBy.get(b)
    return {
      bucket: b,
      sent: cell(nBy.get(b)?.sent ?? 0, 'n', [bc]),
      read: cell(nBy.get(b)?.read ?? 0, 'n', [bc, ...(N_MEASURES.read as Cond[])]),
      email_delivered: cell(mm?.get('delivered') ?? 0, 'm', [bc, ['outcome', ['delivered']]]),
      email_failed: cell(mm?.get('failed') ?? 0, 'm', [bc, ['outcome', ['failed']]])
    }
  })

  // ── Channels ────────────────────────────────────────────────────────────
  const channels = CHANNELS.map((c, ci) => {
    const byStatus = new Map<string, number>()
    for (const r of chanRows) {
      const s = r.keys[ci] as string
      byStatus.set(s, (byStatus.get(s) ?? 0) + (r.counts.all ?? 0))
    }
    const byOutcome = new Map<Outcome, number>()
    let attempted = 0
    for (const [s, n] of byStatus) {
      const o = channelOutcome(c, s)
      byOutcome.set(o, (byOutcome.get(o) ?? 0) + n)
      if (s !== 'not_requested' && s !== NOT_RECORDED) attempted += n
    }
    const known = new Set(CHANNEL_STATUSES[c].map((s) => s.status))
    const statuses = [...byStatus.entries()]
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([status, n]) => ({
        status,
        label: channelStatusLabel(c, status),
        outcome: channelOutcome(c, status),
        known: known.has(status) || status === NOT_RECORDED,
        cell: cell(n, 'n', [[`ch.${c}`, [status]]])
      }))
    return {
      channel: c,
      label: CHANNEL_LABELS[c],
      attempted: cell(attempted, 'n', [[`ch_attempted.${c}`, ['yes']]]),
      outcomes: Object.fromEntries(
        OUTCOMES.map((o) => [o, cell(byOutcome.get(o) ?? 0, 'n', [[`ch_outcome.${c}`, [o]]])])
      ) as Record<Outcome, Cell>,
      statuses
    }
  })

  // ── Email ───────────────────────────────────────────────────────────────
  const byReason = new Map<string, number>()
  const byTemplate = new Map<string, Map<MailOutcome, number>>()
  for (const r of mailCur) {
    const t = r.keys[0] as string
    const reason = r.keys[1] as string
    const n = r.counts.all ?? 0
    byReason.set(reason, (byReason.get(reason) ?? 0) + n)
    const o = mailReason(reason)?.outcome ?? 'other'
    const tm = byTemplate.get(t) ?? new Map<MailOutcome, number>()
    tm.set(o, (tm.get(o) ?? 0) + n)
    byTemplate.set(t, tm)
  }
  const templateNames = await labelFor(reg, 'm', 'template', [...byTemplate.keys()], input.labels)
  const email = {
    total: headline.email_total,
    outcomes: MAIL_OUTCOMES.map((o) => ({
      key: o,
      label: MAIL_OUTCOME_LABELS[o],
      cell: cell(mc.by.get(o) ?? 0, 'm', [['outcome', [o]]])
    })).filter((o) => o.cell.n > 0 || ['delivered', 'failed'].includes(o.key)),
    reasons: MAIL_REASONS.filter((r) => (byReason.get(r.key) ?? 0) > 0).map((r) => ({
      key: r.key,
      label: r.label,
      hint: r.hint,
      outcome: r.outcome,
      cell: cell(byReason.get(r.key) ?? 0, 'm', [['reason', [r.key]]])
    })),
    templates: [...byTemplate.entries()]
      .map(([t, m]) => {
        const total = [...m.values()].reduce((s, n) => s + n, 0)
        const tc: Cond = ['template', [t]]
        return {
          key: t,
          label: templateNames.get(t) ?? t,
          total: cell(total, 'm', [tc]),
          outcomes: Object.fromEntries(
            MAIL_OUTCOMES.map((o) => [o, cell(m.get(o) ?? 0, 'm', [tc, ['outcome', [o]]])])
          ) as Record<MailOutcome, Cell>
        }
      })
      .sort((a, b) => b.total.n - a.total.n)
      .slice(0, 15),
    resends: resend == null ? null : cell(resend, 'm', [['resend', ['yes']]]),
    relay: input.relay,
    ignored_filters: ignoredFilters('m', filters)
  }

  // ── People ──────────────────────────────────────────────────────────────
  const unreadTop = people
    .filter((p) => (p.counts.unread ?? 0) > 0)
    .sort((a, b) => (b.counts.unread ?? 0) - (a.counts.unread ?? 0))
    .slice(0, 15)
  const neverRead = people
    .filter((p) => (p.counts.read ?? 0) === 0 && (p.counts.sent ?? 0) >= NEVER_READ_MIN)
    .sort((a, b) => (b.counts.sent ?? 0) - (a.counts.sent ?? 0))
  const peopleIds = [
    ...new Set([
      ...unreadTop.map((p) => p.keys[0] as string),
      ...neverRead.slice(0, 15).map((p) => p.keys[0] as string),
      ...floods.map((f) => f.keys[0] as string),
      ...senders.map((s) => s.keys[0] as string)
    ])
  ]
  const userNames = await labelFor(reg, 'n', 'recipient', peopleIds, input.labels)
  const personCells = (p: (typeof people)[number]) => {
    const rc: Cond = ['recipient', [p.keys[0] as string]]
    return {
      id: p.keys[0] as string,
      name: userNames.get(p.keys[0] as string) ?? 'Unknown person',
      sent: cell(p.counts.sent ?? 0, 'n', [rc]),
      unread: cell(p.counts.unread ?? 0, 'n', [rc, ...(N_MEASURES.unread as Cond[])])
    }
  }
  const peopleOut = {
    unread: unreadTop.map(personCells),
    never_read: neverRead.slice(0, 15).map(personCells),
    never_read_count: neverRead.length,
    floods: floods.map((f) => ({
      id: f.keys[0] as string,
      name: userNames.get(f.keys[0] as string) ?? 'Unknown person',
      hour: f.keys[1] as string,
      cell: cell(f.counts.all ?? 0, 'n', [
        ['recipient', [f.keys[0] as string]],
        ['hour', [f.keys[1] as string]]
      ])
    })),
    flood_per_hour: input.floodPerHour
  }

  // ── Health callouts ─────────────────────────────────────────────────────
  const health: HealthItem[] = []
  if (input.relay?.status === 'failing') {
    health.push({
      id: 'relay',
      tone: 'bad',
      title: 'The mail relay is failing',
      detail: `${input.relay.failed} of the newest ${input.relay.attempted} attempts failed the same way${input.relay.since ? ` since ${input.relay.since.slice(0, 16).replace('T', ' ')} UTC` : ''}.`,
      cell: headline.email_failed
    })
  }
  for (const r of MAIL_REASONS.filter((x) => x.outcome === 'failed')) {
    const n = byReason.get(r.key) ?? 0
    if (n > 0 && r.key !== 'failed_other')
      health.push({
        id: `mail:${r.key}`,
        tone: 'bad',
        title: `${r.label}: ${n} email${n === 1 ? '' : 's'} not sent`,
        detail: r.hint,
        cell: cell(n, 'm', [['reason', [r.key]]])
      })
  }
  for (const ch of channels) {
    if (ch.channel === 'email') continue
    const f = ch.outcomes.failed
    if (f.n > 0)
      health.push({
        id: `channel:${ch.channel}`,
        tone: 'bad',
        title: `${ch.label}: ${f.n} failed`,
        detail: 'Sends the channel tried and could not deliver.',
        cell: f
      })
  }
  const unconfigured = channels
    .find((c) => c.channel === 'email')
    ?.statuses.find((s) => s.status === 'unconfigured')
  if (unconfigured)
    health.push({
      id: 'email:unconfigured',
      tone: 'bad',
      title: `No mail relay: ${unconfigured.cell.n} emails could not go out`,
      detail: 'Set up a relay in Settings → Email.',
      cell: unconfigured.cell
    })
  if (peopleOut.floods.length > 0) {
    const people = new Set(peopleOut.floods.map((f) => f.id)).size
    const worst = peopleOut.floods[0]
    health.push({
      id: 'flood',
      tone: 'warn',
      title: `${people} ${people === 1 ? 'person' : 'people'} got more than ${input.floodPerHour} notifications in one hour`,
      detail: worst
        ? `Worst: ${worst.name}, ${worst.cell.n} in the hour from ${worst.hour.replace('T', ' ')}:00 UTC.`
        : '',
      cell: worst?.cell
    })
  }
  if (neverRead.length > 0) {
    const top = neverRead[0] as (typeof people)[number]
    health.push({
      id: 'never-read',
      tone: 'warn',
      title: `${neverRead.length} ${neverRead.length === 1 ? 'person has' : 'people have'} read none of their notifications`,
      detail: `Each got ${NEVER_READ_MIN} or more in this window. Most: ${userNames.get(top.keys[0] as string) ?? 'Unknown person'}.`,
      cell: cell(top.counts.sent ?? 0, 'n', [['recipient', [top.keys[0] as string]]])
    })
  }
  const noisy = (
    rows: Array<{ key: string; label: string; sent: Cell; read: Cell }>,
    what: string
  ) => {
    for (const r of rows) {
      if (r.sent.n < NOISY_MIN) continue
      const rate = r.read.n / r.sent.n
      if (rate >= NOISY_READ_RATE) continue
      health.push({
        id: `noisy:${what}:${r.key}`,
        tone: 'warn',
        title: `${r.label}: ${Math.round(rate * 100)}% read`,
        detail: `${r.sent.n} sent by ${what === 'category' ? 'this category' : 'this sender'} in the window, ${r.read.n} read. A candidate to quieten or move to a summary.`,
        cell: r.sent
      })
    }
  }
  noisy(breakdown.rows, 'category')
  noisy(
    senders.map((s) => {
      const key = s.keys[0] as string
      const sc: Cond = ['sender', [key]]
      return {
        key,
        label: userNames.get(key) ?? (key === '__system__' ? 'System and automations' : key),
        sent: cell(s.counts.sent ?? 0, 'n', [sc]),
        read: cell(s.counts.read ?? 0, 'n', [sc, ...(N_MEASURES.read as Cond[])])
      }
    }),
    'sender'
  )

  // ── Mutes ───────────────────────────────────────────────────────────────
  const sentBy = new Map(muteSent.map((r) => [r.keys[0], r.counts.sent ?? 0]))
  const mutes = input.mutes
    ? {
        total: cell(
          muteRows.reduce((s, r) => s + (r.counts.all ?? 0), 0),
          'x',
          []
        ),
        by_collection: muteRows
          .sort((a, b) => (b.counts.all ?? 0) - (a.counts.all ?? 0))
          .slice(0, 15)
          .map((r) => {
            const key = r.keys[0] as string
            return {
              key,
              mutes: cell(r.counts.all ?? 0, 'x', [['collection', [key]]]),
              sent: cell(sentBy.get(key) ?? 0, 'n', [['collection', [key]]])
            }
          })
      }
    : null

  return {
    window: {
      from: window.from.toISOString(),
      to: window.to.toISOString(),
      prev_from: window.prevFrom.toISOString(),
      prev_to: window.prevTo.toISOString(),
      bucket: window.bucket,
      preset: window.preset
    },
    asof: window.to.toISOString(),
    acted_hours: input.actedHours,
    filters,
    ignored_filters: { m: ignoredFilters('m', filters), x: ignoredFilters('x', filters) },
    features: { resend: reg.features.resend, mutes: input.mutes },
    headline,
    series,
    channels,
    email,
    breakdown,
    people: peopleOut,
    health,
    mutes
  }
}

export type Summary = Awaited<ReturnType<typeof buildSummary>>
