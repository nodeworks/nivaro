import { describe, expect, it } from 'vitest'
import { attachLegacyLinks, runOneCheck } from '../../../scripts/quality-checks.js'

const ctx = { db: {} as never, database: 'T', log: () => {} }

describe('runOneCheck', () => {
  it('isolates a throwing check', async () => {
    const out = await runOneCheck(
      {
        id: 'x',
        budgetMs: 1000,
        run: async () => {
          throw new Error('boom')
        }
      },
      ctx
    )
    expect(out.error).toBe('boom')
    expect(out.rows).toBeUndefined()
  })
  it('times out a slow check', async () => {
    const out = await runOneCheck(
      { id: 'x', budgetMs: 20, run: () => new Promise((r) => setTimeout(() => r([]), 200)) },
      ctx
    )
    expect(out.error).toBe('timed out after 0s')
  })
  it('refuses too many rows', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ key: String(i), values: {} }))
    const out = await runOneCheck(
      { id: 'x', budgetMs: 1000, maxRows: 3, run: async () => rows },
      ctx
    )
    expect(out.error).toBe('too many rows (5)')
  })
  it("refuses another run's baseline", async () => {
    // pickBaseline returns the error text when the stored side is missing; never looks up other runs
    const { pickBaseline } = await import('../../../scripts/quality-checks.js')
    expect(pickBaseline({ rows: null, error: null })).toEqual({
      error: 'no baseline for this run — capture failed'
    })
    expect(pickBaseline({ rows: null, error: 'boom' })).toEqual({
      error: 'no baseline for this run — capture failed (boom)'
    })
  })
})

describe('parseArgs', () => {
  it('accepts a baseline and a current invocation', async () => {
    const { parseArgs } = await import('../../../scripts/quality-checks.js')
    expect(
      parseArgs([
        '--stage',
        'baseline',
        '--target',
        'EFP_Staging',
        '--results-db',
        'EFP_Development',
        '--only',
        'a,b'
      ])
    ).toEqual({
      stage: 'baseline',
      target: 'EFP_Staging',
      resultsDb: 'EFP_Development',
      run: 'latest',
      only: ['a', 'b'],
      runbookRun: null,
      rerun: false
    })
    expect(parseArgs(['--stage=current', '--target=S', '--results-db=D'])).toMatchObject({
      stage: 'current',
      run: 'latest'
    })
  })
  it('refuses bad arguments', async () => {
    const { parseArgs } = await import('../../../scripts/quality-checks.js')
    const base = ['--results-db', 'EFP_Development']
    expect(parseArgs(['--target', 'S', ...base])).toBe('--stage must be baseline or current')
    expect(parseArgs(['--stage', 'baseline', '--target', 'EFP', ...base])).toMatch(/production/)
    expect(parseArgs(['--stage', 'baseline', '--target', 'efp_development', ...base])).toMatch(
      /different/
    )
    expect(parseArgs(['--stage', 'baseline', '--target', 'a;b', ...base])).toMatch(/database name/)
    expect(parseArgs(['--stage', 'baseline', '--target', 'S', '--run', 'latest', ...base])).toMatch(
      /current only/
    )
    expect(parseArgs(['--stage', 'current', '--target', 'S', '--run', 'nope', ...base])).toMatch(
      /run id/
    )
    expect(parseArgs(['--stage', 'current', '--target', 'S', '--bogus', 'x', ...base])).toMatch(
      /unknown option/
    )
  })
})

describe('loadQualityChecks', () => {
  it('loads checks from the module an extension names, inside its own folder', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { loadQualityChecks } = await import('../../../services/quality/load-checks.js')
    const root = mkdtempSync(join(tmpdir(), 'qc-'))
    const ext = join(root, 'extensions')
    const fn = 'async () => []'
    mkdirSync(join(ext, 'good', 'quality'), { recursive: true })
    writeFileSync(
      join(ext, 'good', 'index.ts'),
      "export default { id: 'good', quality_checks: 'extensions/good/quality/checks.ts' }\n"
    )
    writeFileSync(
      join(ext, 'good', 'quality', 'checks.ts'),
      `export default [
        { id: 'one.a', area: 'counts', label: 'A', description: '', baseline: ${fn}, current: ${fn} },
        { id: 'one.a', area: 'counts', label: 'dup', description: '', baseline: ${fn}, current: ${fn} },
        { id: 'Bad', area: 'counts', label: 'B', description: '', baseline: ${fn}, current: ${fn} }
      ]\n`
    )
    mkdirSync(join(ext, 'sneaky'), { recursive: true })
    writeFileSync(
      join(ext, 'sneaky', 'index.ts'),
      "export default { id: 'sneaky', quality_checks: 'extensions/good/quality/checks.ts' }\n"
    )
    mkdirSync(join(ext, 'climb'), { recursive: true })
    writeFileSync(
      join(ext, 'climb', 'index.ts'),
      "export default { id: 'climb', quality_checks: 'extensions/climb/../good/quality/checks.ts' }\n"
    )
    const logs: string[] = []
    const checks = await loadQualityChecks(ext, (m) => logs.push(m))
    expect(checks.map((c) => c.id)).toEqual(['one.a'])
    expect(checks[0].label).toBe('A')
    expect(logs.some((l) => l.includes('duplicate check id one.a'))).toBe(true)
    expect(logs.filter((l) => l.includes('must be a path inside'))).toHaveLength(2)
  })
})

describe('fix round 1', () => {
  it('refuses EFP and the target as the results database', async () => {
    const { parseArgs } = await import('../../../scripts/quality-checks.js')
    expect(
      parseArgs(['--stage', 'baseline', '--target', 'EFP_Staging', '--results-db', 'efp'])
    ).toBe('refusing to write results to the production database EFP')
    expect(
      parseArgs(['--stage', 'current', '--target', 'EFP_Staging', '--results-db', 'EFP_STAGING'])
    ).toBe('--target and --results-db must be different databases')
    expect(
      parseArgs(['--stage', 'current', '--target', 'S', '--results-db', 'D', '--rerun'])
    ).toMatchObject({ rerun: true, run: 'latest' })
    expect(
      parseArgs(['--stage', 'baseline', '--target', 'S', '--results-db', 'D', '--rerun'])
    ).toBe('--rerun is for --stage current only')
  })

  it('keeps the password knex hides on its stored connection', async () => {
    const { connectionFor } = await import('../../../scripts/quality-checks.js')
    const knex = (await import('knex')).default
    const k = knex({
      client: 'mssql',
      connection: {
        server: 'h',
        database: 'EFP_Staging',
        user: 'u',
        password: 'pw',
        options: { encrypt: true }
      }
    })
    const stored = k.client.config.connection as Record<string, unknown>
    // the trap: a spread of the stored connection has no password
    expect({ ...stored }.password).toBeUndefined()
    const built = connectionFor(stored, 'EFP_Development', { requestTimeout: 600000 })
    expect(built).toMatchObject({
      server: 'h',
      user: 'u',
      password: 'pw',
      database: 'EFP_Development',
      requestTimeout: 600000,
      options: { encrypt: true }
    })
    expect(Object.keys(built)).toContain('password')
    expect(built.options).not.toBe(stored.options)
    expect(connectionFor({ server: 'h' }, 'X', {}, 'fallback').password).toBe('fallback')
    await k.destroy()
  })

  it('picks only a fresh capture for latest, any capture for --rerun or an explicit id', async () => {
    const { pickRun } = await import('../../../scripts/quality-checks.js')
    const at = new Date('2026-10-06T01:00:00Z')
    const fresh = { id: 'R1', target: 'T', status: 'captured', captured_at: at, verified_at: null }
    const verified = { ...fresh, status: 'done', verified_at: at }
    const died = { ...fresh, status: 'capturing', captured_at: null }
    const latest = { target: 'T', requested: 'latest', rerun: false }
    expect(pickRun(fresh, latest)).toEqual({ id: 'R1' })
    expect(pickRun({ ...fresh, status: 'verifying' }, latest)).toEqual({ id: 'R1' })
    expect(pickRun(verified, latest)).toEqual({
      error: 'latest run R1 for T is done — no fresh capture to verify'
    })
    expect(pickRun(died, latest)).toEqual({
      error: 'latest run R1 for T is capturing — no fresh capture to verify'
    })
    expect(pickRun(null, latest)).toEqual({ error: 'no quality run for T' })
    expect(pickRun(verified, { ...latest, rerun: true })).toEqual({ id: 'R1' })
    expect(pickRun(died, { ...latest, rerun: true })).toEqual({
      error: 'run R1 for T is capturing — it has no capture'
    })
    expect(pickRun(verified, { target: 'T', requested: 'R1', rerun: false })).toEqual({ id: 'R1' })
    expect(pickRun(died, { target: 'T', requested: 'R1', rerun: false })).toEqual({
      error: 'run R1 for T is capturing — it has no capture'
    })
    expect(pickRun(verified, { target: 'U', requested: 'R1', rerun: false })).toEqual({
      error: 'no quality run R1 for U'
    })
  })
})

describe('attachLegacyLinks', () => {
  const mk = (key: string) =>
    ({ key, status: 'mismatch', fields: [], base: null, cur: null }) as never as {
      key: string
      legacy?: string
    }
  it('sets legacy from legacyLink and survives a throwing one', () => {
    const rows = [mk('a'), mk('boom'), mk('none')]
    attachLegacyLinks(
      {
        legacyLink: (k) => {
          if (k === 'boom') throw new Error('x')
          return k === 'none' ? undefined : `https://legacy/${k}`
        }
      },
      rows as never
    )
    expect(rows.map((r) => r.legacy)).toEqual(['https://legacy/a', undefined, undefined])
  })
})
