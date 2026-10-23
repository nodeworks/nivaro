#!/usr/bin/env node
// Results report: every <suite>.json in a run folder → summary.md (for the lead) + summary.json.
// Also compares two runs (e.g. single vs tier) case by case.
//
//   node tests/realtime/report.mjs <run dir>                     summary of one run
//   node tests/realtime/report.mjs <run dir> --compare <run dir>  plus a side-by-side table
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

function loadRun(dir) {
  const suites = []
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith('.json') || f.startsWith('summary')) continue
    try {
      suites.push(JSON.parse(readFileSync(resolve(dir, f), 'utf8')))
    } catch {}
  }
  return suites
}

const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')
const brief = (d) => {
  if (d == null) return ''
  const s = typeof d === 'string' ? d : JSON.stringify(d)
  return s.length > 160 ? `${s.slice(0, 160)}…` : s
}

export function buildReport(dir, compareDir = null) {
  const suites = loadRun(dir)
  const lines = []
  const total = { pass: 0, fail: 0, skip: 0 }
  for (const s of suites) for (const k of Object.keys(total)) total[k] += s.counts?.[k] ?? 0
  const mode = suites[0]?.mode ?? '?'
  lines.push(`# Realtime CI — ${basename(dir)}`)
  lines.push('')
  lines.push(`Mode **${mode}**, image \`${suites[0]?.image ?? '?'}\`, entry ${suites[0]?.base ?? '?'}.`)
  lines.push(`Cases: **${total.pass} pass, ${total.fail} fail, ${total.skip} skipped.**`)
  lines.push('')
  lines.push('| Suite | Verdict | Pass | Fail | Skip | Seconds |')
  lines.push('|---|---|---|---|---|---|')
  for (const s of suites)
    lines.push(
      `| ${s.suite} | ${s.verdict} | ${s.counts?.pass ?? 0} | ${s.counts?.fail ?? 0} | ${s.counts?.skip ?? 0} | ${s.seconds ?? ''} |`
    )
  for (const s of suites) {
    lines.push('')
    lines.push(`## ${s.suite}`)
    if (s.error) lines.push(`\nSuite error: \`${esc(brief(s.error))}\``)
    const failed = (s.cases ?? []).filter((c) => c.status === 'fail')
    if (failed.length) {
      lines.push('')
      lines.push('**Failures**')
      lines.push('')
      for (const c of failed) {
        lines.push(`- **${c.name}**${c.error ? ` — error: \`${esc(brief(c.error))}\`` : ''}`)
        for (const x of c.checks.filter((x) => !x.ok))
          lines.push(`  - ${esc(x.label)}${x.detail != null ? `: \`${esc(brief(x.detail))}\`` : ''}`)
      }
    }
    lines.push('')
    lines.push('| Case | Status | ms | Key metrics |')
    lines.push('|---|---|---|---|')
    for (const c of s.cases ?? [])
      lines.push(
        `| ${esc(c.name)} | ${c.status}${c.skip ? ` (${esc(c.skip)})` : ''} | ${c.ms ?? ''} | ${esc(brief(Object.keys(c.metrics ?? {}).length ? c.metrics : ''))} |`
      )
    if (s.metrics && Object.keys(s.metrics).length) {
      lines.push('')
      lines.push('```json')
      lines.push(JSON.stringify(s.metrics, null, 2).slice(0, 6000))
      lines.push('```')
    }
    if (s.notes?.length) {
      lines.push('')
      lines.push('Notes:')
      for (const n of s.notes) lines.push(`- ${esc(n)}`)
    }
    if (s.untested?.length) {
      lines.push('')
      lines.push('Not covered by this suite:')
      for (const n of s.untested) lines.push(`- ${esc(n)}`)
    }
  }
  if (compareDir && existsSync(compareDir)) {
    const other = loadRun(compareDir)
    const byName = new Map()
    for (const s of other) for (const c of s.cases ?? []) byName.set(`${s.suite}/${c.name}`, c)
    lines.push('')
    lines.push(`## Compared with ${basename(compareDir)} (mode ${other[0]?.mode ?? '?'})`)
    lines.push('')
    lines.push('| Case | This run | Other run | ms this / other |')
    lines.push('|---|---|---|---|')
    for (const s of suites)
      for (const c of s.cases ?? []) {
        const o = byName.get(`${s.suite}/${c.name}`)
        const flag = o && o.status !== c.status ? ' ⚠' : ''
        lines.push(`| ${s.suite}/${esc(c.name)} | ${c.status} | ${o?.status ?? '—'}${flag} | ${c.ms ?? ''} / ${o?.ms ?? ''} |`)
      }
  }
  const md = `${lines.join('\n')}\n`
  writeFileSync(resolve(dir, 'summary.md'), md)
  const summary = {
    run: basename(dir),
    mode,
    total,
    suites: suites.map((s) => ({
      suite: s.suite,
      verdict: s.verdict,
      counts: s.counts,
      failed: (s.cases ?? []).filter((c) => c.status === 'fail').map((c) => c.name),
      skipped: (s.cases ?? []).filter((c) => c.status === 'skip').map((c) => `${c.name}: ${c.skip}`),
      metrics: s.metrics
    }))
  }
  writeFileSync(resolve(dir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
  return { md, summary }
}

/**
 * One table over several run folders (e.g. every suite in single mode and in tier mode): a row
 * per suite/case, a column per run. Suites a run did not have show "—".
 */
export function buildMatrix(dirs, outFile) {
  const runs = dirs.map((d) => ({ dir: d, suites: loadRun(d) }))
  const label = (r) => `${basename(r.dir)} (${r.suites[0]?.mode ?? '?'})`
  const rows = new Map()
  for (const [i, r] of runs.entries())
    for (const s of r.suites)
      for (const c of s.cases ?? []) {
        const key = `${s.suite} › ${c.name}`
        if (!rows.has(key)) rows.set(key, Array(runs.length).fill('—'))
        const failed = (c.checks ?? []).filter((x) => !x.ok).map((x) => x.label)
        rows.get(key)[i] =
          c.status === 'pass' ? 'pass' : c.status === 'skip' ? 'skip' : `**FAIL**${failed.length ? `: ${failed.slice(0, 2).join('; ')}` : c.error ? ': error' : ''}`
      }
  const lines = ['# Realtime CI — matrix', '', `| Case | ${runs.map(label).join(' | ')} |`, `|---|${runs.map(() => '---').join('|')}|`]
  for (const [k, v] of [...rows].sort((a, b) => a[0].localeCompare(b[0]))) lines.push(`| ${esc(k)} | ${v.map(esc).join(' | ')} |`)
  lines.push('')
  for (const r of runs) {
    const t = { pass: 0, fail: 0, skip: 0 }
    for (const s of r.suites) for (const k of Object.keys(t)) t[k] += s.counts?.[k] ?? 0
    lines.push(`- ${label(r)}: ${t.pass} pass, ${t.fail} fail, ${t.skip} skip — suites ${r.suites.map((s) => s.suite).join(', ')}`)
  }
  const md = `${lines.join('\n')}\n`
  if (outFile) writeFileSync(outFile, md)
  return md
}

/**
 * Load runs side by side (each dir holds a load.json): delivery, web pressure, per-process memory.
 * `label` per dir defaults to its folder name.
 */
export function buildLoadTable(dirs) {
  const rows = []
  for (const dir of dirs) {
    let r
    try {
      r = JSON.parse(readFileSync(resolve(dir, 'load.json'), 'utf8'))
    } catch {
      continue
    }
    const c = r.cases?.[0]
    if (!c) continue
    const m = c.metrics ?? {}
    const steps = m.load_steps ?? []
    const hold = steps.find((s) => s.label === 'hold') ?? steps.at(-1) ?? {}
    const webNodes = Object.values(hold.server?.nodes ?? {})
    const pm = m.process_memory ?? {}
    const web = ['web-1', 'web-2'].map((n) => pm[n]).filter(Boolean)
    const rts = Object.entries(pm).filter(([n]) => n.startsWith('rt-') && pm[n]?.at_peak_sockets?.sockets)
    rows.push({
      run: `${r.mode ?? '?'} / ${basename(dir)}`,
      sockets: `${hold.sockets ?? '?'} (peak ${Object.values(m.sockets_peak ?? {}).reduce((a, b) => a + (b ?? 0), 0)})`,
      presence: m.load_delivery ? `p50 ${m.load_delivery.p50_ms} / p95 ${m.load_delivery.p95_ms} / p99 ${m.load_delivery.p99_ms} ms, ${m.load_delivery.within_target_pct}% ≤2 s, missed ${m.load_delivery.missed}` : '—',
      record: m.probe_delivery_ms ? `p50 ${m.probe_delivery_ms.p50} / p95 ${m.probe_delivery_ms.p95} / p99 ${m.probe_delivery_ms.p99} ms, lost ${m.probe_delivery_ms.lost}` : '—',
      online: (() => {
        const o = (m.load_routes ?? []).find((x) => /presence\/online/.test(x.route))
        return o ? `${o.rps} req/s, p95 ${o.p95_ms} ms, errors ${o.errors}` : '—'
      })(),
      webPool: webNodes.length ? `used ${Math.max(...webNodes.map((n) => n.pool_used_max ?? 0))}/${webNodes[0].pool_max}, waiting ≤${Math.max(...webNodes.map((n) => n.pool_waiting_max ?? 0))}, lag ≤${Math.max(...webNodes.map((n) => n.lag_max_ms ?? 0))} ms` : '—',
      webHeap: web.length ? `heap ≤${Math.max(...web.map((w) => w.heap_max))} MiB, RSS ≤${Math.max(...web.map((w) => w.rss_max))} → after ${Math.max(...web.map((w) => w.after?.rss ?? 0))} MiB` : '—',
      realtime: rts.length ? rts.map(([n, v]) => `${n}: ${v.at_peak_sockets.sockets} sockets, RSS ${v.rss_max} / heap ${v.heap_max} / ext ${v.external_max} MiB, lag p99 ≤${v.lag_p99_max} ms`).join('; ') : '—',
      machine: `${(m.machine_load_start ?? []).join(' ')} → ${(m.machine_load_end ?? []).join(' ')}`
    })
  }
  const cols = ['run', 'sockets', 'presence', 'record', 'online', 'webPool', 'webHeap', 'realtime', 'machine']
  const head = ['Run', 'Sockets (hold)', 'Presence delivery', 'Record delivery (probe, from write response)', '/presence/online (whole run)', 'Web pool / lag', 'Web memory', 'Realtime tasks at peak', 'Host load (1/5/15 min)']
  return [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${cols.map((k) => esc(r[k])).join(' | ')} |`)].join('\n')
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === '--load-table') {
  console.log(buildLoadTable(process.argv.slice(3).map((d) => resolve(d))))
  process.exit(0)
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === '--matrix') {
  const rest = process.argv.slice(3)
  const oi = rest.indexOf('--out')
  const out = oi >= 0 ? resolve(rest[oi + 1]) : null
  const dirs = rest.filter((_, i) => i !== oi && i !== oi + 1 || oi < 0).map((d) => resolve(d))
  console.log(buildMatrix(dirs, out))
  process.exit(0)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2]
  if (!dir) {
    console.error('usage: node tests/realtime/report.mjs <run dir> [--compare <run dir>]')
    process.exit(2)
  }
  const i = process.argv.indexOf('--compare')
  const { md } = buildReport(resolve(dir), i > 0 ? resolve(process.argv[i + 1]) : null)
  console.log(md)
}
