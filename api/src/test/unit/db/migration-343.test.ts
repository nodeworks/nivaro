import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const src = readFileSync(
  join(process.cwd(), 'src/db/migrations/343_integration_obligations.ts'),
  'utf8'
)

describe('migration 343', () => {
  it('guards every create and every column add', () => {
    expect(src).toContain("hasTable('nivaro_integration_obligations')")
    expect(src).toContain("hasColumn('nivaro_erp_submissions', 'obligation_id')")
    expect(src).toContain("hasColumn('nivaro_erp_submissions', 'error_class')")
    expect(src).toContain("hasColumn('nivaro_external_apis', 'owner_user')")
    expect(src).toContain("hasColumn('nivaro_external_apis', 'ack_grace_minutes')")
    expect(src).toContain("hasColumn('nivaro_external_apis', 'skip_grace_minutes')")
  })

  it('uses a bigint identity key — one row per decision across 88k records', () => {
    expect(src).toContain("bigIncrements('id')")
  })

  it('names both indexes explicitly', () => {
    expect(src).toContain('ix_integration_obligations_api_outcome_due')
    expect(src).toContain('ix_integration_obligations_record')
  })

  it('adds no foreign key from the ledger — a second cascade path is MSSQL 1785', () => {
    const upBody = src.slice(src.indexOf('export async function up'), src.indexOf('export async function down'))
    expect(upBody).not.toContain('.references(')
  })

  it('defaults the grace windows to the spec values', () => {
    expect(src).toContain('defaultTo(60)')
    expect(src).toContain('defaultTo(30)')
  })
})
