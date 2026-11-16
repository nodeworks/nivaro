import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  CONFIG_TABLES,
  DERIVED_TABLES,
  isRedactedColumn,
  RUNTIME_TABLES
} from '../../../services/config-inventory.js'
import {
  allKeeps,
  CORE_KEEPS,
  EnvKeepError,
  entryTables,
  keepsForTarget,
  OUTBOUND_COLUMN_RE,
  OUTBOUND_EXCEPTIONS,
  SETTINGS_FROM_SOURCE,
  SETTINGS_KEEP,
  SOURCE_CREDENTIAL_DECISIONS,
  validateKeepEntry
} from '../../../services/env-refresh/registry.js'
import { SAFETY_TABLES } from '../../../services/env-refresh/safety.js'

/**
 * The environment-refresh guard: a refresh copies EVERYTHING from the source except what the
 * registry says the target keeps, so an unclassified table or settings column is a silent decision
 * to overwrite the target's value with production's. These tests make that decision explicit.
 *
 * Inputs: the column fixture (every nivaro_* column on the dev database — refresh it with
 *   SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.columns WHERE TABLE_NAME LIKE 'nivaro[_]%'
 * ) plus what migrations created or added after it, read from the migration sources.
 */
const COLUMNS = JSON.parse(
  readFileSync(new URL('../../fixtures/nivaro-column-names.json', import.meta.url), 'utf8')
) as Record<string, string[]>

const MIGRATIONS = fileURLToPath(new URL('../../../db/migrations', import.meta.url))
const NAME = String.raw`['"\x60](nivaro_[A-Za-z0-9_]+)['"\x60]`
const upPart = (src: string) => {
  const i = src.search(/export\s+(async\s+)?function\s+down\b/)
  return i < 0 ? src : src.slice(0, i)
}
// In migration order (numeric prefix), so a later drop removes what an earlier one created.
const sources = readdirSync(MIGRATIONS)
  .filter((f) => /^\d+.*\.ts$/.test(f) && !f.endsWith('.test.ts'))
  .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10) || a.localeCompare(b))
  .map((f) => upPart(readFileSync(join(MIGRATIONS, f), 'utf8')))

/** Tables the migrations leave in place: created by literal or module constant, minus later drops. */
function migrationTables(): Set<string> {
  const out = new Set<string>()
  for (const src of sources) {
    for (const m of src.matchAll(new RegExp(String.raw`dropTable(?:IfExists)?\(\s*` + NAME, 'g')))
      out.delete(m[1])
    for (const m of src.matchAll(new RegExp(String.raw`createTable\(\s*` + NAME, 'g')))
      out.add(m[1])
    for (const m of src.matchAll(/createTable\(\s*([A-Z_][A-Z0-9_]*)\s*[,)]/g)) {
      const c = src.match(new RegExp(String.raw`const\s+${m[1]}\s*(?::\s*string\s*)?=\s*` + NAME))
      if (c) out.add(c[1])
    }
  }
  return out
}

/** nivaro_settings columns migrations ADD (`if (!(await …hasColumn('nivaro_settings', x)))`), minus later drops. */
function migrationSettingsColumns(): Set<string> {
  const out = new Set<string>()
  const ADD = String.raw`!\s*\(\s*await\s+knex\.schema\.hasColumn\(\s*['"]nivaro_settings['"]\s*,\s*`
  for (const src of sources) {
    if (/nivaro_settings['"]/.test(src))
      for (const m of src.matchAll(/dropColumn\(\s*['"]([a-z0-9_]+)['"]/g)) out.delete(m[1])
    for (const m of src.matchAll(new RegExp(`${ADD}['"]([a-z0-9_]+)['"]`, 'g'))) out.add(m[1])
    for (const m of src.matchAll(new RegExp(`${ADD}([A-Z_][A-Z0-9_]*)\\s*\\)`, 'g'))) {
      const c = src.match(new RegExp(String.raw`const\s+${m[1]}\s*=\s*['"]([a-z0-9_]+)['"]`))
      if (c) out.add(c[1])
    }
  }
  return out
}

const classified = new Set([...CONFIG_TABLES, ...DERIVED_TABLES, ...RUNTIME_TABLES])
const keptTables = new Set(allKeeps().flatMap(entryTables))

describe('environment refresh registry — every table and settings column has a decision', () => {
  it('the inputs are real', () => {
    expect(Object.keys(COLUMNS).length).toBeGreaterThan(300)
    expect(migrationTables().size).toBeGreaterThan(200)
    expect(COLUMNS.nivaro_settings.length).toBeGreaterThan(150)
  })

  it('every nivaro_* table is classified (config / derived / runtime) — the promote classification, not a fork', () => {
    const all = new Set([...Object.keys(COLUMNS), ...migrationTables()])
    const missing = [...all].filter((t) => !classified.has(t) && !keptTables.has(t)).sort()
    expect(missing).toEqual([])
  })

  it('every nivaro_settings column is either kept by the target or follows the source', () => {
    const keep = new Set(SETTINGS_KEEP)
    const from = new Set(SETTINGS_FROM_SOURCE)
    const cols = new Set([...COLUMNS.nivaro_settings, ...migrationSettingsColumns()])
    expect([...cols].filter((c) => !keep.has(c) && !from.has(c)).sort()).toEqual([])
    expect(SETTINGS_KEEP.filter((c) => from.has(c))).toEqual([])
  })

  it('no settings decision names a column that does not exist', () => {
    const cols = new Set([...COLUMNS.nivaro_settings, ...migrationSettingsColumns()])
    expect([...SETTINGS_KEEP, ...SETTINGS_FROM_SOURCE].filter((c) => !cols.has(c))).toEqual([])
  })

  it('every credential in the settings row stays with the target', () => {
    const keep = new Set(SETTINGS_KEEP)
    const creds = COLUMNS.nivaro_settings.filter((c) => isRedactedColumn('nivaro_settings', c))
    expect(creds.length).toBeGreaterThan(5)
    expect(creds.filter((c) => !keep.has(c))).toEqual([])
  })

  it('every config table with a credential column has a refresh decision', () => {
    const decided = new Set([...keptTables, ...Object.keys(SOURCE_CREDENTIAL_DECISIONS)])
    const open: string[] = []
    for (const t of CONFIG_TABLES) {
      if (t === 'nivaro_settings') continue
      const creds = (COLUMNS[t] ?? []).filter((c) => isRedactedColumn(t, c))
      if (creds.length && !decided.has(t)) open.push(`${t} (${creds.join(', ')})`)
    }
    expect(open).toEqual([])
  })

  it('every core entry names tables and columns that exist', () => {
    const problems: string[] = []
    for (const e of CORE_KEEPS) {
      const cols = COLUMNS[e.table]
      if (!cols) {
        problems.push(`${e.id}: no table ${e.table}`)
        continue
      }
      for (const c of [...(e.key ?? []), ...(e.columns ?? []), ...(e.secret_columns ?? [])])
        if (!cols.includes(c)) problems.push(`${e.id}: no column ${e.table}.${c}`)
    }
    expect(problems).toEqual([])
  })

  it('core entries pass their own validation and have unique ids', () => {
    for (const e of CORE_KEEPS) expect(() => validateKeepEntry(e)).not.toThrow()
    expect(new Set(CORE_KEEPS.map((e) => e.id)).size).toBe(CORE_KEEPS.length)
  })

  it('keeps what Rob named: external APIs, mail, the per-instance rows, runbook queue on dev only', () => {
    const byTable = (t: string) => CORE_KEEPS.filter((e) => e.table === t)
    expect(byTable('nivaro_external_apis')[0].columns).toEqual(
      expect.arrayContaining([
        'base_url',
        'auth_config',
        'headers',
        'mock_config',
        'instance_overrides'
      ])
    )
    expect(byTable('nivaro_external_apis')[0].key).toEqual(['name'])
    expect(SETTINGS_KEEP).toEqual(
      expect.arrayContaining([
        'smtp_host',
        'mail_test_mode',
        'mail_test_allowlist',
        'environment_label'
      ])
    )
    expect(byTable('nivaro_settings_overrides')[0].kind).toBe('table')
    const staging = keepsForTarget(allKeeps(), { runbook_queue: false }).map((e) => e.table)
    const dev = keepsForTarget(allKeeps(), { runbook_queue: true }).map((e) => e.table)
    expect(staging).not.toContain('nivaro_runbook_queue')
    expect(dev).toContain('nivaro_runbook_queue')
    expect(dev).toContain('nivaro_runbook_agents')
  })

  it('refuses malformed entries', () => {
    const ok = { id: 'x:y', label: 'L', reason: 'R', table: 'nivaro_x', kind: 'table' as const }
    expect(() => validateKeepEntry(ok)).not.toThrow()
    expect(() => validateKeepEntry({ ...ok, table: 'x; DROP TABLE y' })).toThrow(EnvKeepError)
    expect(() => validateKeepEntry({ ...ok, kind: 'columns' })).toThrow(/key and columns/)
    expect(() =>
      validateKeepEntry({ ...ok, kind: 'rows', key: ['id'], where: '1=1; DROP' })
    ).toThrow(/one predicate/)
    expect(() =>
      validateKeepEntry({ ...ok, kind: 'columns', key: ['name'], columns: ['name'] })
    ).toThrow(/key column/)
    expect(() =>
      validateKeepEntry({ ...ok, kind: 'delegate', commands: { save: ['rm', '-rf', '/'] } })
    ).toThrow(/npx, tsx, node or bash/)
    expect(() => validateKeepEntry({ ...ok, commands: { save: ['npx', 'x'] } })).toThrow(/delegate/)
  })

  it('every table with an outward address or a credential column is kept, made safe, or excused', () => {
    const covered = new Set([...keptTables, ...SAFETY_TABLES])
    const open: string[] = []
    for (const [t, cols] of Object.entries(COLUMNS)) {
      const hits = cols.filter((c) => OUTBOUND_COLUMN_RE.test(c))
      if (hits.length && !covered.has(t) && !OUTBOUND_EXCEPTIONS[t])
        open.push(`${t} (${hits.join(', ')})`)
    }
    expect(open).toEqual([])
  })

  it('outbound exceptions name real tables that nothing else covers', () => {
    const covered = new Set([...keptTables, ...SAFETY_TABLES])
    for (const t of Object.keys(OUTBOUND_EXCEPTIONS)) {
      expect(COLUMNS[t], t).toBeDefined()
      expect(covered.has(t), t).toBe(false)
    }
  })

  it('agent triggers keep their target, secret and switch by name; flows keep on/off', () => {
    const at = CORE_KEEPS.find((e) => e.id === 'core:agent-triggers')!
    expect(at).toMatchObject({ table: 'nivaro_agent_triggers', kind: 'columns', key: ['name'] })
    expect(at.columns).toEqual(['url', 'signing_secret', 'headers', 'enabled'])
    expect(CORE_KEEPS.find((e) => e.id === 'core:flows')?.columns).toEqual(['status'])
  })

  it('settings secrets that are not named like secrets are still masked', () => {
    const s = CORE_KEEPS.find((e) => e.id === 'core:settings')!
    expect(s.secret_columns).toEqual(
      expect.arrayContaining([
        'teams_webhook_url',
        'teams_test_webhook_url',
        'storage_config',
        'mcp_settings'
      ])
    )
  })

  it('the accounts note says what happens to copied credentials and that sign-in keeps working', () => {
    const a = CORE_KEEPS.find((e) => e.id === 'core:accounts')!
    expect(a.reason).toMatch(/static tokens/)
    expect(a.reason).toMatch(/two-factor secrets stay/)
    expect(a.reason).toMatch(/Redis/)
  })
})
