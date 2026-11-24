import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CORE_CRON_SCOPES, cronScope } from '../../services/cron-scope.js'
import { lexSource, listSourceFiles, stripCommentsKeepLines } from './cloud-flag-scan.js'

// Cron scope guard (Hub phase 5). Every core job id passed to app.cron.schedule — string ids
// scanned from api/src plus the dynamic ids row schedules build from a prefix — says in
// services/cron-scope.ts whether a shared deployment runs it once per app or once per process.

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '../..')

/** A schedule call whose id is not a string literal: which CORE_CRON_SCOPES keys cover it.
 *  Extension jobs (the loader) are not core: they default to 'app' or pass `scope`. */
const DYNAMIC: Record<string, string[]> = {
  'extensions/loader.ts `${cronPrefix}${id}`': [],
  'routes/flows.ts flowCronId(flow.id)': ['flow:*'],
  'routes/sync-jobs.ts cronId(job.id)': ['sync-job-*'],
  'services/row-schedules.ts id': [
    'retention-policy-*',
    'scheduled-report-*',
    'activity-view-*',
    'sync-job-*',
    'flow:*'
  ],
  'services/chaos/cron-test-job.ts CHAOS_TEST_JOB': ['chaos-test-overlap']
}

interface Call {
  file: string
  arg: string
}

/** The first argument of every `<…>cron.schedule(` / `m.schedule(` call in code (not in a
 *  comment, a string or template text such as the extension scaffold's sample code). */
function scheduleCalls(): Call[] {
  const out: Call[] = []
  for (const file of listSourceFiles(SRC)) {
    if (file === 'plugins/cron.ts') continue // the manager's own rebuild() re-schedules by id
    const code = readFileSync(join(SRC, file), 'utf8')
    const spans = lexSource(code)
    const inCode = (at: number) => spans.find((s) => s.start <= at && at < s.end)?.kind === 'code'
    for (const m of code.matchAll(/\b(?:cron\??|m)\.schedule\(\s*/g)) {
      if (!inCode(m.index)) continue
      const from = m.index + m[0].length
      let depth = 0
      let i = from
      for (; i < code.length; i++) {
        const c = code[i]
        if (c === '(' || c === '[' || c === '{') depth++
        else if (c === ')' || c === ']' || c === '}') depth--
        else if (c === ',' && depth === 0) break
      }
      out.push({ file, arg: code.slice(from, i).trim() })
    }
  }
  return out
}

const literal = (arg: string): string | null => {
  const m = /^(['"`])([^'"`$]*)\1$/.exec(arg)
  return m ? m[2] : null
}

/** `const NAME = 'value'` anywhere in api/src (exported or not). */
function constValue(name: string): string | null {
  for (const file of listSourceFiles(SRC)) {
    const m = new RegExp(`\\bconst ${name}\\s*=\\s*['"]([^'"]+)['"]`).exec(
      readFileSync(join(SRC, file), 'utf8')
    )
    if (m) return m[1]
  }
  return null
}

// Scans the source tree: about 1.5 s alone, past 5 s under the full suite's load.
describe('cron scope guard', { timeout: 60_000 }, () => {
  const calls = scheduleCalls()

  it('finds the core schedule calls', () => {
    expect(calls.length).toBeGreaterThan(100)
  })

  it('every core cron id passed to app.cron.schedule has an entry in CORE_CRON_SCOPES', () => {
    const missing = calls
      .map((c) => literal(c.arg))
      .filter((id): id is string => id !== null && !(id in CORE_CRON_SCOPES))
    expect(missing).toEqual([])
    // and every non-literal id is a known dynamic form
    const unknown = calls
      .filter((c) => literal(c.arg) === null)
      .map((c) => `${c.file} ${c.arg}`)
      .filter((k) => !(k in DYNAMIC))
    expect(unknown).toEqual([])
  })

  it('every dynamic cron id prefix has an entry in CORE_CRON_SCOPES', () => {
    for (const keys of Object.values(DYNAMIC))
      for (const k of keys) expect(CORE_CRON_SCOPES[k], k).toBeDefined()
    // the row-schedule prefixes reconcile() is given, read from the source
    const prefixes = new Set<string>()
    for (const file of listSourceFiles(SRC)) {
      const code = stripCommentsKeepLines(readFileSync(join(SRC, file), 'utf8'))
      for (const m of code.matchAll(/\breconcile\(\s*app\s*,\s*([^,]+),/g)) {
        const arg = m[1].trim()
        const value = literal(arg) ?? constValue(arg)
        expect(value, `${file}: reconcile prefix ${arg}`).not.toBeNull()
        prefixes.add(value as string)
      }
    }
    expect(prefixes.size).toBeGreaterThanOrEqual(5)
    for (const p of prefixes) expect(CORE_CRON_SCOPES[`${p}*`], `${p}*`).toBeDefined()
    expect(constValue('CHAOS_TEST_JOB')).toBe('chaos-test-overlap')
    expect(constValue('FLOW_CRON_PREFIX')).toBe('flow:')
  })

  it('every entry is still scheduled somewhere (no stale ids)', () => {
    const live = new Set<string>()
    for (const c of calls) {
      const id = literal(c.arg)
      if (id) live.add(id)
      for (const k of DYNAMIC[`${c.file} ${c.arg}`] ?? []) live.add(k)
    }
    expect(Object.keys(CORE_CRON_SCOPES).filter((k) => !live.has(k))).toEqual([])
  })

  it('cronScope: core map, then the job’s own scope, then app', () => {
    expect(cronScope('pool-monitor')).toBe('process')
    expect(cronScope('pool-monitor', { scope: 'app' })).toBe('process')
    expect(cronScope('outbox-worker')).toBe('app')
    expect(cronScope('retention-policy-12')).toBe('app')
    expect(cronScope('flow:abc')).toBe('app')
    expect(cronScope('efp-ops:sampler', { scope: 'process', extensionId: 'efp-ops' })).toBe(
      'process'
    )
    expect(cronScope('efp-ops:nightly', { extensionId: 'efp-ops' })).toBe('app')
  })
})
