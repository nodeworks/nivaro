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
