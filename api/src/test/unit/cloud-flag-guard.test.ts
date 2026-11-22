import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  type Batch,
  batchFor,
  listSourceFiles,
  MODE_MODULE,
  type ScannedSite,
  scanFile,
  scanTree,
  strayTokens,
  stripCommentsKeepLines
} from './cloud-flag-scan.js'

// Cloud-flag ratchet (Hub phase 5). Every place in api/src that tests CLOUD_META_DB_URL is in
// test/fixtures/cloud-flag-inventory.json with the predicate it means: isMultiTenant() (T rules)
// or isNivaroCloud() (C rules, the closed list in the phase-5 plan). The batches convert the
// sites file by file; a new raw read anywhere, or one left in a converted batch, fails here.
//
// Regenerate the skeleton (meaning: null) with
//   cd api && node --import tsx ../scripts/cloud-flag-inventory.mts
// and classify new sites by hand: rule, a one-line why, phase6 for every T6.

/** Batches whose files are converted (Tasks 3, 5–9 add their letter). */
const CONVERTED: Batch[] = ['R', 'B', 'C', 'D']

/** Predicate calls a converted file may carry beyond its inventory (new code written after the
 *  inventory, e.g. Task 4's hub source start in server.ts). Keep it short and explain each. */
const EXTRA_CALLS: Record<string, { multiTenant?: number; nivaroCloud?: number }> = {
  // Its one C1 read (getMetaDb's connection URL) moved to services/tenancy/cloud-meta-source.ts
  // as cloudMetaDbUrl(); the inventory entry stays, the file now holds no such call.
  'middleware/tenant.ts': { nivaroCloud: -1 }
}

type Rule = 'T1' | 'T2' | 'T3' | 'T4' | 'T5' | 'T6' | 'T7' | 'C1' | 'C2' | 'C3' | 'C4' | 'C5'
type InventorySite = ScannedSite & {
  id: string
  meaning: 'multiTenant' | 'nivaroCloud'
  rule: Rule
  why: string
  batch: string
  split?: boolean
  phase6?: string
}

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '../..')
const INVENTORY = (
  JSON.parse(readFileSync(join(SRC, 'test/fixtures/cloud-flag-inventory.json'), 'utf8')) as {
    sites: InventorySite[]
  }
).sites
const RULES: Rule[] = ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'C1', 'C2', 'C3', 'C4', 'C5']

const baseId = (id: string) => id.replace(/#\d+$/, '')
const key = (s: { file: string; form: string }) => `${s.file} [${s.form}]`

/** file+form → sorted texts (a split site counts once). */
function textsByFileForm(sites: { id?: string; file: string; form: string; text: string }[]) {
  const seen = new Set<string>()
  const out = new Map<string, string[]>()
  for (const s of sites) {
    if (s.id) {
      const b = baseId(s.id)
      if (seen.has(b)) continue
      seen.add(b)
    }
    const k = key(s)
    out.set(k, [...(out.get(k) ?? []), s.text])
  }
  for (const v of out.values()) v.sort()
  return out
}

describe('cloud-flag scanner', () => {
  it('finds raw, env-param, module-const, helper-def and helper-call sites, comments excluded', () => {
    const src = [
      '// process.env.CLOUD_META_DB_URL in a comment',
      '/* and process.env.CLOUD_META_DB_URL',
      '   over two lines */',
      'const cloudMode = !!process.env.CLOUD_META_DB_URL',
      'const inCloud = () => !!process.env.CLOUD_META_DB_URL',
      'function isCloud(): boolean {',
      '  return !!process.env.CLOUD_META_DB_URL',
      '}',
      'export function f(env = process.env) {',
      '  if (env.CLOUD_META_DB_URL) return 1',
      "  if (process.env['CLOUD_META_DB_URL']) return 2",
      '  if (cloudMode && inCloud() && isCloud()) return 3',
      "  return { cloudMode: 'x' }",
      '}'
    ].join('\n')
    const sites = scanFile('services/x.ts', src).map((s) => [s.line, s.form, s.weight])
    expect(sites).toEqual([
      [4, 'module-const', 1],
      [5, 'helper-def', 0],
      [6, 'helper-def', 0],
      [10, 'env-param', 1],
      [11, 'raw', 1],
      [12, 'helper-call', 0],
      [12, 'helper-call', 1],
      [12, 'helper-call', 1]
    ])
  })

  it('a Decision-4 helper left behind without a read is still a site', () => {
    expect(scanFile('a.ts', 'const inCloud = () => isMultiTenant()').map((s) => s.form)).toEqual([
      'helper-def'
    ])
    expect(scanFile('a.ts', 'const cloudMode = isMultiTenant()').map((s) => s.form)).toEqual([
      'helper-def'
    ])
  })

  it('an exported named function (huddleCloudMode) is a read, not a helper', () => {
    const src =
      'export function huddleCloudMode(env = process.env): boolean {\n  return !!env.CLOUD_META_DB_URL\n}\nhuddleCloudMode()'
    expect(scanFile('services/h.ts', src).map((s) => [s.line, s.form])).toEqual([[2, 'env-param']])
  })

  it('calls of a helper imported from outside-write-watch.ts are sites', () => {
    const src =
      "import { isCloudMode } from '../services/outside-write-watch.js'\nif (isCloudMode()) x()"
    expect(scanFile('routes/r.ts', src).map((s) => [s.line, s.form, s.weight])).toEqual([
      [2, 'helper-call', 1]
    ])
  })

  it('a /* or // inside a string, a template or a regex is not a comment; lines stay put', () => {
    const cases: [string, string[], number][] = [
      // '*/*' once opened a fake block comment that hid every line up to the next */
      [
        "const h = { accept: '*/*' }\nif (process.env.CLOUD_META_DB_URL) x()\n/* real\n comment */ y()",
        ["const h = { accept: '*/*' }", 'if (process.env.CLOUD_META_DB_URL) x()', '', ' y()'],
        2
      ],
      // " //" inside a string once cut the rest of the line
      [
        'go("http://x", !!process.env.CLOUD_META_DB_URL) // tail',
        ['go("http://x", !!process.env.CLOUD_META_DB_URL) '],
        1
      ],
      // template text with // and /*, a nested ${} holding another template and a brace
      [
        // biome-ignore lint/suspicious/noTemplateCurlyInString: TypeScript source under test
        'go(`a //b /*c ${{ k: `d/*${1}` }.k} e*/` + (process.env.CLOUD_META_DB_URL ?? "")) // tail',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: TypeScript source under test
        ['go(`a //b /*c ${{ k: `d/*${1}` }.k} e*/` + (process.env.CLOUD_META_DB_URL ?? "")) '],
        1
      ],
      // a regex literal holding /* (and a class with /), next to a real division
      [
        'const re = /a\\/*b[/*]/g; const q = n / 2 /* c */\nif (re.test(s) && process.env.CLOUD_META_DB_URL) x()',
        [
          'const re = /a\\/*b[/*]/g; const q = n / 2 ',
          'if (re.test(s) && process.env.CLOUD_META_DB_URL) x()'
        ],
        2
      ]
    ]
    for (const [src, want, line] of cases) {
      expect(stripCommentsKeepLines(src).split('\n')).toEqual(want)
      // the read is found, on its own line number
      expect(scanFile('services/x.ts', src).map((s) => [s.line, s.form])).toEqual([[line, 'raw']])
    }
  })

  it('never scans the mode module', () => {
    expect(scanFile(MODE_MODULE, 'x(process.env.CLOUD_META_DB_URL)')).toEqual([])
  })

  it('batchFor follows the plan table, first match', () => {
    expect(batchFor('middleware/tenant.ts')).toBe('R')
    expect(batchFor('middleware/authenticate.ts')).toBe('A')
    expect(batchFor('db/sqlite.ts')).toBe('A')
    expect(batchFor('services/cache-warm.ts')).toBe('A')
    expect(batchFor('plugins/socketio.ts')).toBe('B')
    expect(batchFor('services/realtime-delivery-slo.ts')).toBe('B')
    expect(batchFor('services/traffic-taps/redis.ts')).toBe('C')
    expect(batchFor('services/telemetry-store.ts')).toBe('C')
    expect(batchFor('routes/traffic-map-extras/ops.ts')).toBe('C')
    expect(batchFor('services/storage/fallback.ts')).toBe('D')
    expect(batchFor('routes/admin/provision.ts')).toBe('D')
    expect(batchFor('routes/infrastructure-drift.ts')).toBe('D')
    expect(batchFor('services/hub/mode.ts')).toBe('E')
    expect(batchFor('routes/hub-link.ts')).toBe('E')
  })
})

describe('cloud-flag token backstop', () => {
  const stray = (src: string, rel = 'services/x.ts') =>
    strayTokens(rel, src).map((t) => [t.line, t.reason.split(' ')[0]])

  it('catches the read forms the scanner does not know', () => {
    expect(stray('const { CLOUD_META_DB_URL } = process.env\nif (CLOUD_META_DB_URL) x()')).toEqual([
      [1, 'CLOUD_META_DB_URL'],
      [2, 'CLOUD_META_DB_URL']
    ])
    expect(
      stray('function f(env) {\n  const { CLOUD_META_DB_URL: meta } = env\n  return meta\n}')
    ).toEqual([[2, 'CLOUD_META_DB_URL']])
    expect(stray("if ('CLOUD_META_DB_URL' in process.env) x()")).toEqual([[1, 'CLOUD_META_DB_URL']])
    expect(stray("const K = 'CLOUD_META_DB_URL'\nif (process.env[K]) x()")).toEqual([
      [1, 'CLOUD_META_DB_URL']
    ])
    expect(stray('const { HUB_SHARED_DEPLOYMENT: key } = process.env')).toEqual([
      [1, 'HUB_SHARED_DEPLOYMENT']
    ])
  })

  it('a template-literal key is a raw read the scanner sees', () => {
    const src = 'if (process.env[`CLOUD_META_DB_URL`]) x()'
    expect(scanFile('services/x.ts', src).map((s) => s.form)).toEqual(['raw'])
    expect(stray(src)).toEqual([])
  })

  it('leaves comment lines, message strings, site lines and helper bodies alone', () => {
    const src = [
      '// CLOUD_META_DB_URL in a comment',
      '/* CLOUD_META_DB_URL',
      ' * CLOUD_META_DB_URL */',
      "throw new Error('Set CLOUD_META_DB_URL or DB_URL')",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: TypeScript source under test
      'log(`CLOUD_META_DB_URL is ${v}`)',
      'if (process.env.CLOUD_META_DB_URL) x()',
      'function inCloud(): boolean {',
      "  return !!process.env['CLOUD_META_DB_URL']",
      '}'
    ].join('\n')
    expect(stray(src)).toEqual([])
  })

  it('refuses a flag exported to other modules (importers are not scanned)', () => {
    expect(stray('export const CLOUD = !!process.env.CLOUD_META_DB_URL')).toEqual([[1, 'exports']])
    expect(stray('const CLOUD = !!process.env.CLOUD_META_DB_URL\nexport { CLOUD }')).toEqual([
      [1, 'exports']
    ])
    expect(stray('export const inCloud = () => !!process.env.CLOUD_META_DB_URL')).toEqual([
      [1, 'exports']
    ])
    expect(stray('export const CLOUD =\n  !!process.env.CLOUD_META_DB_URL')).toEqual([
      [2, 'exports']
    ])
    // the two Decision-4 exports, whose importers ARE scanned, and a non-flag export
    expect(
      stray(
        'export const isCloudMode = () => !!process.env.CLOUD_META_DB_URL',
        'services/outside-write-watch.ts'
      )
    ).toEqual([])
    expect(
      stray('export const _staticDb = process.env.CLOUD_META_DB_URL\n  ? a\n  : b', 'db/index.ts')
    ).toEqual([])
  })
})

describe('cloud-flag inventory (ratchet)', () => {
  const scanned = scanTree(SRC)

  it('(a) every scanned site is in the inventory and every entry is still there', () => {
    const want = textsByFileForm(scanned)
    // converted batches have no raw sites left; check (c) holds their predicate calls instead
    const have = textsByFileForm(INVENTORY.filter((e) => !CONVERTED.includes(e.batch as Batch)))
    const problems: string[] = ratchetProblems(want, have)
    // the backstop: a flag token no scanned site covers, or a flag exported to other modules
    for (const f of listSourceFiles(SRC))
      for (const t of strayTokens(f, readFileSync(join(SRC, f), 'utf8')))
        problems.push(`${t.file}:${t.line} ${t.text} — ${t.reason}`)
    expect(problems).toEqual([])
  })

  it('(a) keeps the ratchet for a converted file: a raw read added back is refused', () => {
    const converted = INVENTORY.find((e) => CONVERTED.includes(e.batch as Batch))!
    const added = scanFile(converted.file, 'if (process.env.CLOUD_META_DB_URL) go()')
    expect(added.length).toBe(1)
    const want = textsByFileForm(added)
    const have = textsByFileForm(INVENTORY.filter((e) => !CONVERTED.includes(e.batch as Batch)))
    expect(ratchetProblems(want, have).some((p) => p.startsWith('not in the inventory'))).toBe(true)
  })

  const ratchetProblems = (want: Map<string, string[]>, have: Map<string, string[]>): string[] => {
    const problems: string[] = []
    for (const k of new Set([...want.keys(), ...have.keys()])) {
      const w = want.get(k) ?? []
      const h = [...(have.get(k) ?? [])]
      const missing: string[] = []
      for (const t of w) {
        const i = h.indexOf(t)
        if (i >= 0) h.splice(i, 1)
        else missing.push(t)
      }
      for (const t of missing) problems.push(`not in the inventory: ${k} ${t}`)
      for (const t of h) problems.push(`in the inventory but gone from the code: ${k} ${t}`)
    }
    return problems
  }

  it('(b) every entry is classified', () => {
    const problems: string[] = []
    const ids = new Set<string>()
    for (const e of INVENTORY) {
      const at = e.id
      if (ids.has(e.id)) problems.push(`${at}: duplicate id`)
      ids.add(e.id)
      if (!RULES.includes(e.rule)) problems.push(`${at}: rule ${e.rule}`)
      const want = e.rule?.startsWith('C') ? 'nivaroCloud' : 'multiTenant'
      if (e.meaning !== want) problems.push(`${at}: ${e.rule} means ${want}, not ${e.meaning}`)
      if (!e.why?.trim()) problems.push(`${at}: no why`)
      if (e.batch !== batchFor(e.file))
        problems.push(`${at}: batch ${e.batch} ≠ ${batchFor(e.file)}`)
      if (e.rule === 'T6' && !e.phase6?.trim()) problems.push(`${at}: T6 needs a phase6 note`)
      if (/#\d+$/.test(e.id) !== !!e.split) problems.push(`${at}: split entries carry #n and split`)
    }
    // a split site has at least two entries
    const parts = new Map<string, number>()
    for (const e of INVENTORY)
      if (e.split) parts.set(baseId(e.id), (parts.get(baseId(e.id)) ?? 0) + 1)
    for (const [b, n] of parts) if (n < 2) problems.push(`${b}: split into ${n} entry`)
    expect(problems).toEqual([])
  })

  it('(c) converted batches have no sites and the classified predicate calls', () => {
    const problems: string[] = []
    const files = new Set(listSourceFiles(SRC))
    const sitesIn = new Map<string, number>()
    for (const s of scanned) sitesIn.set(s.file, (sitesIn.get(s.file) ?? 0) + 1)
    const expected = new Map<string, { multiTenant: number; nivaroCloud: number }>()
    for (const e of INVENTORY) {
      const x = expected.get(e.file) ?? { multiTenant: 0, nivaroCloud: 0 }
      x[e.meaning] += e.weight
      expected.set(e.file, x)
    }
    for (const file of files) {
      if (!CONVERTED.includes(batchFor(file))) continue
      if (sitesIn.get(file)) problems.push(`${file}: ${sitesIn.get(file)} cloud-flag site(s) left`)
      const want = expected.get(file)
      if (!want) continue
      const code = stripCommentsKeepLines(readFileSync(join(SRC, file), 'utf8'))
      const got = {
        multiTenant: code.match(/\bisMultiTenant\(/g)?.length ?? 0,
        nivaroCloud: code.match(/\b(?:isNivaroCloud|cloudMetaDbUrl)\(/g)?.length ?? 0
      }
      const extra = EXTRA_CALLS[file] ?? {}
      for (const m of ['multiTenant', 'nivaroCloud'] as const) {
        const n = want[m] + (extra[m] ?? 0)
        if (got[m] !== n) problems.push(`${file}: ${got[m]} ${m} call(s), inventory says ${n}`)
      }
    }
    expect(problems).toEqual([])
  })

  it('(d) only deployment-mode.ts reads HUB_SHARED_DEPLOYMENT / HUB_DEPLOYMENT_TOKEN', () => {
    const re =
      /\.(?:HUB_SHARED_DEPLOYMENT|HUB_DEPLOYMENT_TOKEN)\b|\[['"](?:HUB_SHARED_DEPLOYMENT|HUB_DEPLOYMENT_TOKEN)['"]\]/
    const readers = listSourceFiles(SRC).filter(
      (f) =>
        f !== MODE_MODULE && re.test(stripCommentsKeepLines(readFileSync(join(SRC, f), 'utf8')))
    )
    expect(readers).toEqual([])
  })
})
