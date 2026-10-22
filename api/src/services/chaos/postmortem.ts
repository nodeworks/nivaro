import type { RunReport } from './report.js'
import { markLabel } from './report.js'
import type { ChaosRun } from './runs.js'

/**
 * "Export postmortem" (#2849): the run report as Markdown a person pastes into their postmortem
 * template — the verdict, the timings, the hypothesis with each sampler's band and worst value,
 * alerts, readiness, the errors people saw (route templates and counts), notes and a timeline.
 * Never record data: the run carries none, and the errors section is counts only.
 */

export interface ErrorsSeen {
  /** Server errors (5xx) people's requests got, by route template. */
  server: Array<{ route: string; count: number }>
  server_total: number
  people: number
  client_errors: number
  rage_clicks: number
  dead_clicks: number
  /** False when the sources could not be read (no table, no database). */
  available: boolean
}

const fmtS = (s: number | null): string => {
  if (s == null) return '—'
  if (s < 90) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m ${String(s % 60).padStart(2, '0')}s`
}

const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')

const isoMin = (iso: string | null) => (iso ? `${iso.replace('T', ' ').slice(0, 19)}Z` : '—')

const VERDICT_TEXT: Record<string, string> = {
  held: 'Held — every limit stayed true for the whole window.',
  broke: 'Broke — a limit was crossed while the fault ran.',
  aborted: 'Aborted — a limit was crossed past its tolerance and the fault stopped itself.'
}

export function postmortemMarkdown(input: {
  run: ChaosRun
  report: RunReport
  errors: ErrorsSeen | null
  names: Record<string, string>
  link: string | null
}): string {
  const { run, report: r, errors, names, link } = input
  const who = (id: string | null, stamped: string | null = null) =>
    (id ? names[id] : null) ?? stamped ?? (id ? 'someone' : 'the system')
  const out: string[] = []
  out.push(`# Chaos drill postmortem: ${run.label}`)
  out.push('')
  out.push(`- **Run:** ${run.id}${link ? ` (${link})` : ''}`)
  out.push(`- **Kind:** ${run.kind}`)
  out.push(`- **Fault:** ${run.fault_key ?? '—'}`)
  out.push(
    `- **Started by:** ${typeof run.meta.started_by_name === 'string' ? run.meta.started_by_name : '—'}`
  )
  out.push(`- **Armed:** ${isoMin(r.armed_at)}`)
  out.push(`- **Ended:** ${isoMin(r.disarmed_at)}`)
  out.push('')
  out.push('## Verdict')
  out.push('')
  out.push(run.verdict ? (VERDICT_TEXT[run.verdict] ?? run.verdict) : `No verdict (${run.status}).`)
  if (r.broke_by)
    out.push(
      `Broken by \`${r.broke_by.sampler}\`${r.broke_by.value != null ? ` = ${r.broke_by.value}` : ''}${r.broke_by.op && r.broke_by.limit != null ? ` (limit ${r.broke_by.op} ${r.broke_by.limit})` : ''}.`
    )
  out.push('')
  out.push('## Timings')
  out.push('')
  out.push('| Measure | Value |')
  out.push('| --- | --- |')
  out.push(`| Time to detect | ${fmtS(r.ttd_s)}${r.ttd_source ? ` (${r.ttd_source})` : ''} |`)
  out.push(`| Time to fix | ${fmtS(r.ttf_s)} |`)
  out.push(
    `| Time to recover | ${r.ttr_state === 'recovered' ? fmtS(r.ttr_s) : r.ttr_state === 'not_recovered' ? 'not back inside the baseline while watched' : 'no samples after the fault'} |`
  )
  out.push('')
  if (r.series.length) {
    out.push('## What should have stayed true')
    out.push('')
    out.push('| Sampler | Rule | Baseline | Worst during | Crossed |')
    out.push('| --- | --- | --- | --- | --- |')
    for (const s of r.series) {
      const during = s.points
        .filter((p) => p.phase === 'during' && p.v != null)
        .map((p) => p.v as number)
      const worst =
        during.length === 0
          ? '—'
          : String(
              s.rule && (s.rule.op === '>' || s.rule.op === '>=')
                ? Math.min(...during)
                : Math.max(...during)
            )
      out.push(
        `| ${esc(s.key)} | ${s.rule ? `${s.rule.op} ${s.rule.limit}${s.rule.tolerance ? ` ± ${s.rule.tolerance}` : ''}` : '—'} | ${s.band ? `${s.band.lo}–${s.band.hi}` : '—'} | ${worst} | ${s.breached ? 'yes' : 'no'} |`
      )
    }
    out.push('')
  }
  out.push('## Alerts')
  out.push('')
  if (!r.alerts.length) out.push('No alert fired during the run.')
  for (const a of r.alerts)
    out.push(
      `- ${isoMin(a.at)}${a.after_s != null ? ` (+${fmtS(a.after_s)})` : ''}: ${esc(a.label)}${a.source ? ` — ${esc(a.source)}` : ''}`
    )
  out.push('')
  if (r.readiness.length) {
    out.push('## Readiness')
    out.push('')
    for (const x of r.readiness)
      out.push(
        `- ${isoMin(x.at)}: ${x.status}${x.score != null ? ` (score ${x.score})` : ''}${x.failing.length ? ` — failing: ${x.failing.map(esc).join(', ')}` : ''}`
      )
    out.push('')
  }
  out.push('## Errors people saw')
  out.push('')
  if (!errors?.available) out.push('The error sources could not be read for this window.')
  else {
    out.push(
      `${errors.server_total} server error(s) reached ${errors.people} person(s); ${errors.client_errors} client error report(s); ${errors.rage_clicks} rage click(s), ${errors.dead_clicks} dead click(s).`
    )
    if (errors.server.length) {
      out.push('')
      out.push('| Route | Server errors |')
      out.push('| --- | --- |')
      for (const e of errors.server) out.push(`| ${esc(e.route)} | ${e.count} |`)
    }
  }
  out.push('')
  out.push('## Notes')
  out.push('')
  if (!r.notes.length) out.push('Nobody left a note.')
  for (const n of r.notes)
    out.push(
      `- ${isoMin(n.at)}${n.after_s != null ? ` (+${fmtS(n.after_s)})` : ''} ${who(n.actor, n.name)}${n.mark ? ` [${markLabel(n.mark)}]` : ''}: ${esc(n.text)}`
    )
  out.push('')
  out.push('## Timeline')
  out.push('')
  for (const m of r.markers)
    out.push(`- ${isoMin(new Date(m.t).toISOString())} ${m.kind}: ${esc(m.label)}`)
  out.push('')
  out.push('## Follow-ups')
  out.push('')
  out.push('- [ ] ')
  out.push('')
  return out.join('\n')
}
