import { describe, expect, it } from 'vitest'
import {
  CONFIG_TABLES,
  type ConfigSnapshot,
  DERIVED_TABLES,
  RUNTIME_TABLES,
  classifyTables,
  diffSnapshots,
  hashRow,
  redactRow
} from '../../../services/config-inventory.js'

function snapshot(
  tables: Record<string, Record<string, Record<string, unknown>>>,
  instance?: Partial<ConfigSnapshot['instance']>
): ConfigSnapshot {
  const built: ConfigSnapshot['tables'] = {}
  for (const [table, rows] of Object.entries(tables)) {
    built[table] = {}
    for (const [key, data] of Object.entries(rows)) {
      built[table][key] = { hash: hashRow(data), data }
    }
  }
  return {
    format: 1,
    generated_at: '2026-08-16T00:00:00.000Z',
    instance: { version: '1.0.0', environment: 'test', database: 'A', ...instance },
    classification: {
      config: Object.keys(tables),
      derived: [],
      runtime: [],
      unclassified: [],
      absent: []
    },
    tables: built,
    errors: {}
  }
}

describe('classifyTables', () => {
  it('classification is total — the three lists do not overlap', () => {
    const seen = new Set<string>()
    const dupes: string[] = []
    for (const t of [...CONFIG_TABLES, ...DERIVED_TABLES, ...RUNTIME_TABLES]) {
      if (seen.has(t)) dupes.push(t)
      seen.add(t)
    }
    expect(dupes).toEqual([])
  })

  it('reports a table it has never heard of rather than ignoring it', () => {
    // This is the whole point: a new migration must surface here, because a
    // silently-skipped table produces a diff that claims agreement it never
    // checked.
    const c = classifyTables(['nivaro_queues', 'nivaro_brand_new_thing'])
    expect(c.unclassified).toEqual(['nivaro_brand_new_thing'])
    expect(c.config).toContain('nivaro_queues')
  })

  it('reports classified tables missing from an older instance', () => {
    const c = classifyTables(['nivaro_queues'])
    expect(c.absent).toContain('nivaro_fields')
    expect(c.config).toEqual(['nivaro_queues'])
  })
})

describe('redactRow', () => {
  it('drops secrets rather than masking them', () => {
    // A constant mask would make two DIFFERENT secrets hash equal, so the diff
    // would report agreement about a credential that actually differs.
    const row = redactRow('nivaro_users', {
      id: 'u1',
      email: 'a@example.com',
      password_hash: 'abc',
      static_token: 'tok',
      preferences: '{}'
    })
    expect(row).toEqual({ id: 'u1', email: 'a@example.com' })
    expect('password_hash' in row).toBe(false)
  })

  it('applies per-table redaction on top of the global list', () => {
    const row = redactRow('nivaro_settings', {
      id: 1,
      smtp_host: 'mail.example.com',
      smtp_pass: 'hunter2',
      anthropic_api_key: 'sk-x'
    })
    expect(row).toEqual({ id: 1, smtp_host: 'mail.example.com' })
  })

  it('leaves an unlisted table untouched apart from the global secrets', () => {
    const row = redactRow('nivaro_queues', { id: 'q', name: 'Work', key_hash: 'x' })
    expect(row).toEqual({ id: 'q', name: 'Work' })
  })
})

describe('hashRow', () => {
  it('is stable across key order', () => {
    expect(hashRow({ a: 1, b: 2 })).toBe(hashRow({ b: 2, a: 1 }))
  })

  it('normalizes Dates so a re-read of the same row does not read as drift', () => {
    const d = new Date('2026-01-01T00:00:00.000Z')
    expect(hashRow({ at: d })).toBe(hashRow({ at: '2026-01-01T00:00:00.000Z' }))
  })

  it('changes when a value changes', () => {
    expect(hashRow({ name: 'a' })).not.toBe(hashRow({ name: 'b' }))
  })
})

describe('diffSnapshots', () => {
  const mine = snapshot({
    nivaro_queues: {
      q1: { id: 'q1', name: 'Workflows' },
      q2: { id: 'q2', name: 'Inventory' }
    }
  })

  it('reports nothing when both sides match', () => {
    const diff = diffSnapshots(mine, snapshot({ nivaro_queues: { q1: { id: 'q1', name: 'Workflows' }, q2: { id: 'q2', name: 'Inventory' } } }))
    expect(diff.totals).toEqual({ added: 0, removed: 0, changed: 0, tables_differing: 0 })
    expect(diff.tables).toEqual([])
  })

  it('reports a field-level change with both sides', () => {
    const theirs = snapshot({
      nivaro_queues: { q1: { id: 'q1', name: 'Renamed' }, q2: { id: 'q2', name: 'Inventory' } }
    })
    const diff = diffSnapshots(mine, theirs)
    expect(diff.totals.changed).toBe(1)
    expect(diff.tables[0].changed[0]).toEqual({
      key: 'q1',
      fields: [{ field: 'name', mine: 'Workflows', theirs: 'Renamed' }]
    })
    expect(diff.tables[0].same).toBe(1)
  })

  it('separates rows only here from rows only there', () => {
    const theirs = snapshot({
      nivaro_queues: { q2: { id: 'q2', name: 'Inventory' }, q9: { id: 'q9', name: 'Ghost' } }
    })
    const diff = diffSnapshots(mine, theirs)
    expect(diff.tables[0].added).toEqual(['q1'])
    expect(diff.tables[0].removed).toEqual(['q9'])
  })

  it('marks a table only one side captured', () => {
    const theirs = snapshot({
      nivaro_queues: { q1: { id: 'q1', name: 'Workflows' }, q2: { id: 'q2', name: 'Inventory' } },
      nivaro_rules: { r1: { id: 'r1', name: 'Rule' } }
    })
    const diff = diffSnapshots(mine, theirs)
    const rules = diff.tables.find((t) => t.table === 'nivaro_rules')
    expect(rules?.only_on).toBe('theirs')
    expect(rules?.removed).toEqual(['r1'])
  })

  it('treats null and a missing key as the same value', () => {
    // Otherwise every nullable column added by a migration reads as drift on
    // every row, and the real differences drown.
    const a = snapshot({ t: { r: { id: 'r', note: null } } })
    const b = snapshot({ t: { r: { id: 'r' } } })
    const diff = diffSnapshots(a, b)
    expect(diff.totals.changed).toBe(0)
  })

  it('names which instance is which in the result', () => {
    const theirs = snapshot({ nivaro_queues: {} }, { database: 'B', label: 'staging' })
    const diff = diffSnapshots(mine, theirs)
    expect(diff.mine.database).toBe('A')
    expect(diff.theirs.database).toBe('B')
    expect(diff.theirs.label).toBe('staging')
  })
})
