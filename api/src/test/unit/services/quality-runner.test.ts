import { describe, expect, it } from 'vitest'
import { runOneCheck } from '../../../scripts/quality-checks.js'

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
      runbookRun: null
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
