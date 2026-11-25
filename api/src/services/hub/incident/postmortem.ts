import { db } from '../../../db/index.js'
import type { Incident, IncidentEvent } from './store.js'

/**
 * Post-mortem builder (Hub enhancement 35). After an incident (or while it is still open) the
 * Hub drafts a timeline of what it recorded in the window — two hours before the incident opened
 * to thirty minutes after it closed (at most WINDOW_MAX_MS):
 *
 *   deploys   nivaro_hub_deploys of the app's environments (promotions, rollbacks, applies)
 *   moves     nivaro_hub_moves (placement moves)
 *   alerts    nivaro_hub_fleet_alerts opened / resolved, and the Hub's own pages
 *   errors    nivaro_hub_issue_groups first seen in the window (titles as collected, scrubbed)
 *   uptime    the minute probes (nivaro_hub_uptime_samples, kept 48 h) folded into "stopped
 *             answering … answered again" spans; older windows read the hourly rollups
 *   incident  the incident's own timeline (opened, notes, banner, paging, resolved)
 *
 * The draft is a document (PostMortem) people then edit: summary, impact, root cause, follow-up
 * actions and the timeline itself. It is exported as Markdown, and as a PDF through htmlToPdf
 * (local Chromium or the render peer). The HTML is built here with every value escaped.
 * Internal (Hub admins and the app's owners): never on the status page.
 */

export const WINDOW_BEFORE_MS = 2 * 3_600_000
export const WINDOW_AFTER_MS = 30 * 60_000
export const WINDOW_MAX_MS = 14 * 86_400_000
export const MAX_TIMELINE = 400
const SAMPLE_KEEP_MS = 48 * 3_600_000

export type TimelineKind =
  | 'incident'
  | 'deploy'
  | 'move'
  | 'alert'
  | 'page'
  | 'error'
  | 'uptime'
  | 'note'

export interface TimelineItem {
  at: string
  kind: TimelineKind
  text: string
}

export interface ActionItem {
  text: string
  owner: string | null
  done: boolean
}

export interface PostMortem {
  version: 1
  title: string
  summary: string
  impact: string
  root_cause: string
  actions: ActionItem[]
  timeline: TimelineItem[]
  window: { from: string; to: string }
  drafted_at: string
}

export function windowOf(i: Pick<Incident, 'opened_at' | 'resolved_at'>, now = Date.now()) {
  const opened = Date.parse(i.opened_at)
  const end = i.resolved_at ? Date.parse(i.resolved_at) : now
  const from = opened - WINDOW_BEFORE_MS
  const to = Math.min(end + WINDOW_AFTER_MS, from + WINDOW_MAX_MS, now)
  return { from, to: Math.max(to, from + 60_000) }
}

const isoOf = (v: unknown): string | null => {
  if (v == null) return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

const fmtMin = (ms: number) => {
  const m = Math.max(1, Math.round(ms / 60_000))
  return m >= 120 ? `${Math.round(m / 60)} h` : `${m} min`
}

/** Down spans from minute samples (oldest first): runs of failed probes. Pure. */
export function downSpans(
  samples: Array<{ at: string; up: boolean }>
): Array<{ from: string; to: string | null; failed: number }> {
  const out: Array<{ from: string; to: string | null; failed: number }> = []
  let open: { from: string; to: string | null; failed: number } | null = null
  for (const s of samples) {
    if (!s.up) {
      if (!open) open = { from: s.at, to: null, failed: 0 }
      open.failed++
    } else if (open) {
      open.to = s.at
      out.push(open)
      open = null
    }
  }
  if (open) out.push(open)
  return out
}

export interface DraftSources {
  envKeys: Map<number, string>
  deploys: Array<Record<string, unknown>>
  moves: Array<Record<string, unknown>>
  alerts: Array<Record<string, unknown>>
  pages: Array<Record<string, unknown>>
  issues: Array<Record<string, unknown>>
  samples: Array<{ environment_id: number; at: string; up: boolean }>
  hours: Array<{ environment_id: number; hour: string; samples: number; up: number }>
  events: IncidentEvent[]
  names: Map<string, string>
}

const EVENT_WORDS: Record<string, string> = {
  opened: 'Incident opened',
  resolved: 'Incident resolved',
  acknowledged: 'Acknowledged',
  banner: 'Status banner',
  freeze: 'Deploy freeze',
  page: 'Paged',
  escalated: 'Escalated',
  changed: 'Changed',
  note: 'Note',
  postmortem: 'Post-mortem'
}

/** The draft timeline from what was read (pure, oldest first, at most MAX_TIMELINE). */
export function buildTimeline(
  src: DraftSources,
  win: { from: number; to: number }
): TimelineItem[] {
  const out: TimelineItem[] = []
  const env = (id: unknown) => src.envKeys.get(Number(id)) ?? `environment ${Number(id)}`
  const inWin = (at: string | null) =>
    !!at && Date.parse(at) >= win.from && Date.parse(at) <= win.to
  const who = (id: unknown) =>
    typeof id === 'string' && id ? (src.names.get(id.toLowerCase()) ?? null) : null
  for (const d of src.deploys) {
    const started = isoOf(d.started_at)
    const finished = isoOf(d.finished_at)
    const kind = String(d.kind ?? 'promote')
    const verb = kind === 'rollback' ? 'Rollback' : kind === 'apply' ? 'Stack apply' : 'Deploy'
    const by = who(d.started_by)
    if (inWin(started))
      out.push({
        at: started as string,
        kind: 'deploy',
        text: `${verb} of ${String(d.version ?? '')} to ${env(d.environment_id)} started${by ? ` by ${by}` : ''}${d.from_version ? ` (from ${String(d.from_version)})` : ''}`
      })
    if (inWin(finished))
      out.push({
        at: finished as string,
        kind: 'deploy',
        text: `${verb} of ${String(d.version ?? '')} to ${env(d.environment_id)} ${String(d.status ?? 'finished')}`
      })
  }
  for (const m of src.moves) {
    const started = isoOf(m.started_at)
    const finished = isoOf(m.finished_at)
    if (inWin(started))
      out.push({
        at: started as string,
        kind: 'move',
        text: `Move of ${env(m.environment_id)} started`
      })
    if (inWin(finished))
      out.push({
        at: finished as string,
        kind: 'move',
        text: `Move of ${env(m.environment_id)} ${String(m.status ?? 'finished')}`
      })
  }
  for (const a of src.alerts) {
    const opened = isoOf(a.opened_at)
    const resolved = isoOf(a.resolved_at)
    const where = a.environment_id == null ? '' : ` (${env(a.environment_id)})`
    if (inWin(opened))
      out.push({
        at: opened as string,
        kind: 'alert',
        text: `Alert: ${String(a.message ?? '').slice(0, 300)}${where}`
      })
    if (inWin(resolved))
      out.push({ at: resolved as string, kind: 'alert', text: `Alert cleared${where}` })
  }
  for (const p of src.pages) {
    const at = isoOf(p.created_at)
    if (inWin(at) && p.incident_id == null)
      out.push({
        at: at as string,
        kind: 'page',
        text: `Paged on call: ${String(p.subject ?? '')}`
      })
    const ack = isoOf(p.acknowledged_at)
    if (inWin(ack) && p.incident_id == null)
      out.push({
        at: ack as string,
        kind: 'page',
        text: `Page acknowledged${who(p.acknowledged_by) ? ` by ${who(p.acknowledged_by)}` : ''}`
      })
  }
  for (const i of src.issues) {
    const at = isoOf(i.first_seen)
    if (!inWin(at)) continue
    const n = Number(i.occurrences) || 0
    out.push({
      at: at as string,
      kind: 'error',
      text: `New ${i.kind === 'crash' ? 'crash' : 'error'} on ${env(i.environment_id)}: ${String(i.title ?? '').slice(0, 200)}${n ? ` (${n} times)` : ''}`
    })
  }
  // Uptime: minute spans while the samples are kept, else the hourly rollups.
  const byEnv = new Map<number, Array<{ at: string; up: boolean }>>()
  for (const s of src.samples) {
    const list = byEnv.get(s.environment_id) ?? []
    list.push({ at: s.at, up: s.up })
    byEnv.set(s.environment_id, list)
  }
  for (const [envId, list] of byEnv) {
    list.sort((a, b) => a.at.localeCompare(b.at))
    for (const span of downSpans(list)) {
      out.push({
        at: span.from,
        kind: 'uptime',
        text: `${env(envId)} stopped answering the Hub’s probes`
      })
      if (span.to)
        out.push({
          at: span.to,
          kind: 'uptime',
          text: `${env(envId)} answered again after ${fmtMin(Date.parse(span.to) - Date.parse(span.from))}`
        })
    }
  }
  if (!src.samples.length)
    for (const h of src.hours) {
      const failed = h.samples - h.up
      if (failed > 0 && inWin(h.hour))
        out.push({
          at: h.hour,
          kind: 'uptime',
          text: `${env(h.environment_id)}: ${failed} of ${h.samples} probes failed in this hour`
        })
    }
  for (const e of src.events) {
    if (e.kind === 'postmortem') continue
    const by = who(e.user_id)
    out.push({
      at: e.at,
      kind: e.kind === 'note' ? 'note' : 'incident',
      text: `${EVENT_WORDS[e.kind] ?? e.kind}${e.text ? `: ${e.text}` : ''}${by ? ` (${by})` : ''}`
    })
  }
  return out.sort((a, b) => a.at.localeCompare(b.at)).slice(0, MAX_TIMELINE)
}

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn()
  } catch {
    return fallback
  }
}

/** Reads every source for the incident's window (a missing table reads as nothing). */
export async function readSources(
  i: Incident,
  events: IncidentEvent[],
  win: { from: number; to: number },
  now = Date.now()
): Promise<DraftSources> {
  const from = new Date(win.from)
  const to = new Date(win.to)
  const envs = (await safe(
    () =>
      db('nivaro_hub_environments').where({ app_id: i.app_id }).select('id', 'key') as Promise<
        Array<{ id: number; key: string }>
      >,
    []
  )) as Array<{ id: number; key: string }>
  const envIds = envs.map((e) => Number(e.id))
  const envKeys = new Map(envs.map((e) => [Number(e.id), String(e.key)]))
  const ids = envIds.length ? envIds : [-1]
  const between = (col: string, col2?: string) => (q: ReturnType<typeof db>) =>
    q.where((w) => {
      w.whereBetween(col, [from, to])
      if (col2) w.orWhereBetween(col2, [from, to])
    })
  const deploys = await safe(
    () =>
      between(
        'started_at',
        'finished_at'
      )(db('nivaro_hub_deploys').whereIn('environment_id', ids))
        .limit(200)
        .select('*') as Promise<Array<Record<string, unknown>>>,
    []
  )
  const moves = await safe(
    () =>
      between(
        'started_at',
        'finished_at'
      )(db('nivaro_hub_moves').where({ app_id: i.app_id }))
        .limit(50)
        .select('*') as Promise<Array<Record<string, unknown>>>,
    []
  )
  const alerts = await safe(
    () =>
      between(
        'opened_at',
        'resolved_at'
      )(db('nivaro_hub_fleet_alerts').where({ app_id: i.app_id }))
        .limit(100)
        .select('*') as Promise<Array<Record<string, unknown>>>,
    []
  )
  const pages = await safe(
    () =>
      between(
        'created_at',
        'acknowledged_at'
      )(db('nivaro_hub_pages').where({ app_id: i.app_id }))
        .limit(100)
        .select('*') as Promise<Array<Record<string, unknown>>>,
    []
  )
  const issues = await safe(
    () =>
      db('nivaro_hub_issue_groups')
        .whereIn('environment_id', ids)
        .whereBetween('first_seen', [from, to])
        .orderBy('first_seen', 'asc')
        .limit(50)
        .select('environment_id', 'kind', 'title', 'occurrences', 'first_seen') as Promise<
        Array<Record<string, unknown>>
      >,
    []
  )
  const samples =
    now - win.from <= SAMPLE_KEEP_MS
      ? (
          (await safe(
            () =>
              db('nivaro_hub_uptime_samples')
                .whereIn('environment_id', ids)
                .whereBetween('at', [from, to])
                .orderBy('at', 'asc')
                .limit(20_000)
                .select('environment_id', 'at', 'up') as Promise<Array<Record<string, unknown>>>,
            []
          )) as Array<Record<string, unknown>>
        ).map((s) => ({
          environment_id: Number(s.environment_id),
          at: isoOf(s.at) ?? '',
          up: s.up === true || s.up === 1 || s.up === '1'
        }))
      : []
  const hours = samples.length
    ? []
    : (
        (await safe(
          () =>
            db('nivaro_hub_uptime_hours')
              .whereIn('environment_id', ids)
              .whereBetween('hour', [from, to])
              .limit(5000)
              .select('environment_id', 'hour', 'samples', 'up_samples') as Promise<
              Array<Record<string, unknown>>
            >,
          []
        )) as Array<Record<string, unknown>>
      ).map((h) => ({
        environment_id: Number(h.environment_id),
        hour: isoOf(h.hour) ?? '',
        samples: Number(h.samples) || 0,
        up: Number(h.up_samples) || 0
      }))
  const people = [
    ...deploys.map((d) => d.started_by),
    ...pages.map((p) => p.acknowledged_by),
    ...events.map((e) => e.user_id)
  ].filter((x): x is string => typeof x === 'string' && !!x)
  const names = await safe(async () => {
    const { personNames } = await import('../releases/person.js')
    return personNames(people)
  }, new Map<string, string>())
  return { envKeys, deploys, moves, alerts, pages, issues, samples, hours, events, names }
}

/** A fresh draft for the incident (the summary carries over when one was written). */
export async function draftPostMortem(
  i: Incident,
  events: IncidentEvent[],
  now = Date.now(),
  read: typeof readSources = readSources
): Promise<PostMortem> {
  const win = windowOf(i, now)
  const src = await read(i, events, win, now)
  return {
    version: 1,
    title: `Post-mortem: ${i.title}`.slice(0, 200),
    summary: i.summary ?? '',
    impact: '',
    root_cause: '',
    actions: [],
    timeline: buildTimeline(src, win),
    window: { from: new Date(win.from).toISOString(), to: new Date(win.to).toISOString() },
    drafted_at: new Date(now).toISOString()
  }
}

const clip = (v: unknown, n: number) => (typeof v === 'string' ? v.slice(0, n) : '')
const KINDS: readonly TimelineKind[] = [
  'incident',
  'deploy',
  'move',
  'alert',
  'page',
  'error',
  'uptime',
  'note'
]

/** An edited document as stored (validated, trimmed to size). */
export function normalizePostMortem(b: unknown): PostMortem | { error: string } {
  if (!b || typeof b !== 'object' || Array.isArray(b))
    return { error: 'the post-mortem is an object' }
  const o = b as Record<string, unknown>
  const timeline = Array.isArray(o.timeline) ? o.timeline : []
  if (timeline.length > MAX_TIMELINE) return { error: `at most ${MAX_TIMELINE} timeline entries` }
  const actions = Array.isArray(o.actions) ? o.actions : []
  if (actions.length > 50) return { error: 'at most 50 actions' }
  const items: TimelineItem[] = []
  for (const t of timeline) {
    const r = (t ?? {}) as Record<string, unknown>
    const at = isoOf(r.at)
    const text = clip(r.text, 500).trim()
    if (!at || !text) return { error: 'every timeline entry has a time and text' }
    const kind = (KINDS as readonly string[]).includes(String(r.kind))
      ? (r.kind as TimelineKind)
      : 'note'
    items.push({ at, kind, text })
  }
  const win = (o.window ?? {}) as Record<string, unknown>
  return {
    version: 1,
    title: clip(o.title, 200).trim() || 'Post-mortem',
    summary: clip(o.summary, 8000),
    impact: clip(o.impact, 8000),
    root_cause: clip(o.root_cause, 8000),
    actions: actions
      .map((a) => {
        const r = (a ?? {}) as Record<string, unknown>
        return {
          text: clip(r.text, 500).trim(),
          owner:
            typeof r.owner === 'string' && r.owner.trim() ? r.owner.trim().slice(0, 120) : null,
          done: r.done === true
        }
      })
      .filter((a) => a.text),
    timeline: items.sort((a, b) => a.at.localeCompare(b.at)),
    window: {
      from: isoOf(win.from) ?? items[0]?.at ?? new Date().toISOString(),
      to: isoOf(win.to) ?? items[items.length - 1]?.at ?? new Date().toISOString()
    },
    drafted_at: isoOf(o.drafted_at) ?? new Date().toISOString()
  }
}

/** "2026-11-25 14:05 UTC" — UTC in exports, so a reader anywhere reads the same times. */
export function utcLabel(at: string): string {
  return `${at.slice(0, 16).replace('T', ' ')} UTC`
}

export interface ExportFacts {
  app: string
  environment: string | null
  severity: string
  status: string
  opened_at: string
  resolved_at: string | null
}

const SEV_WORDS: Record<string, string> = { sev1: 'SEV 1', sev2: 'SEV 2', sev3: 'SEV 3' }

/** Markdown text that cannot break the document: no raw HTML, list/heading markers kept as text. */
function mdText(v: string): string {
  return v.replace(/[<>]/g, (c) => (c === '<' ? '&lt;' : '&gt;'))
}

export function postMortemMarkdown(pm: PostMortem, f: ExportFacts): string {
  const lines: string[] = []
  lines.push(`# ${mdText(pm.title)}`, '')
  lines.push(`- **App:** ${mdText(f.app)}${f.environment ? ` · ${mdText(f.environment)}` : ''}`)
  lines.push(`- **Severity:** ${SEV_WORDS[f.severity] ?? f.severity}`)
  lines.push(`- **Opened:** ${utcLabel(f.opened_at)}`)
  lines.push(`- **Resolved:** ${f.resolved_at ? utcLabel(f.resolved_at) : 'still open'}`)
  if (f.resolved_at)
    lines.push(`- **Duration:** ${fmtMin(Date.parse(f.resolved_at) - Date.parse(f.opened_at))}`)
  lines.push('')
  const section = (h: string, body: string) => {
    lines.push(`## ${h}`, '', body.trim() ? mdText(body.trim()) : '_Not written yet._', '')
  }
  section('Summary', pm.summary)
  section('Impact', pm.impact)
  section('Root cause', pm.root_cause)
  lines.push('## Timeline', '')
  if (!pm.timeline.length) lines.push('_No entries._')
  for (const t of pm.timeline)
    lines.push(`- **${utcLabel(t.at)}** · ${t.kind} · ${mdText(t.text).replace(/\n+/g, ' ')}`)
  lines.push('', '## Follow-up actions', '')
  if (!pm.actions.length) lines.push('_None yet._')
  for (const a of pm.actions)
    lines.push(
      `- [${a.done ? 'x' : ' '}] ${mdText(a.text)}${a.owner ? ` — ${mdText(a.owner)}` : ''}`
    )
  lines.push('')
  return lines.join('\n')
}

const esc = (v: string) =>
  v.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'
  )

const para = (v: string) =>
  v.trim()
    ? v
        .trim()
        .split(/\n{2,}/)
        .map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`)
        .join('')
    : '<p class="muted">Not written yet.</p>'

/** The print page for the PDF (light only, every value escaped, no scripts, no remote assets). */
export function postMortemHtml(pm: PostMortem, f: ExportFacts, brand = 'Nivaro Hub'): string {
  const rows = pm.timeline
    .map(
      (t) =>
        `<tr><td class="t">${esc(utcLabel(t.at))}</td><td class="k">${esc(t.kind)}</td><td>${esc(t.text)}</td></tr>`
    )
    .join('')
  const actions = pm.actions.length
    ? `<ul>${pm.actions
        .map(
          (a) =>
            `<li>${a.done ? '☑' : '☐'} ${esc(a.text)}${a.owner ? ` <span class="muted">— ${esc(a.owner)}</span>` : ''}</li>`
        )
        .join('')}</ul>`
    : '<p class="muted">None yet.</p>'
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(pm.title)}</title><style>
  @page { size: A4; margin: 18mm 16mm; }
  body { font: 11pt/1.5 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #14110a; }
  header { border-bottom: 2px solid #f5a623; padding-bottom: 8px; margin-bottom: 14px; }
  .brand { font-size: 9pt; letter-spacing: .08em; text-transform: uppercase; color: #6b6459; }
  h1 { font-size: 18pt; margin: 4px 0 6px; } h2 { font-size: 12.5pt; margin: 18px 0 6px; }
  .facts { font-size: 9.5pt; color: #3d382f; } .facts b { color: #14110a; }
  table { width: 100%; border-collapse: collapse; font-size: 9.5pt; }
  td { border-top: 1px solid #e7e2d8; padding: 4px 6px; vertical-align: top; }
  td.t { white-space: nowrap; font-variant-numeric: tabular-nums; width: 1%; }
  td.k { color: #6b6459; width: 1%; white-space: nowrap; } .muted { color: #8a8378; }
  </style></head><body>
  <header><div class="brand">${esc(brand)} · post-mortem</div><h1>${esc(pm.title)}</h1>
  <div class="facts"><b>${esc(f.app)}</b>${f.environment ? ` · ${esc(f.environment)}` : ''} · ${esc(SEV_WORDS[f.severity] ?? f.severity)} · opened ${esc(utcLabel(f.opened_at))} · ${f.resolved_at ? `resolved ${esc(utcLabel(f.resolved_at))}` : 'still open'}</div></header>
  <h2>Summary</h2>${para(pm.summary)}<h2>Impact</h2>${para(pm.impact)}<h2>Root cause</h2>${para(pm.root_cause)}
  <h2>Timeline</h2>${rows ? `<table>${rows}</table>` : '<p class="muted">No entries.</p>'}
  <h2>Follow-up actions</h2>${actions}
  </body></html>`
}
