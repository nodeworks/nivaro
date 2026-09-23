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

  it('submission_id and owner_user carry real FK constraints, NO ACTION — not a bare column', () => {
    const submissionIdIdx = src.indexOf("t.integer('submission_id')")
    expect(submissionIdIdx).toBeGreaterThan(-1)
    const submissionIdBlock = src.slice(submissionIdIdx, submissionIdIdx + 200)
    expect(submissionIdBlock).toContain(".references('id')")
    expect(submissionIdBlock).toContain(".inTable('nivaro_erp_submissions')")
    expect(submissionIdBlock).toContain(".onDelete('NO ACTION')")

    const ownerUserIdx = src.indexOf("t.uuid('owner_user')")
    expect(ownerUserIdx).toBeGreaterThan(-1)
    const ownerUserBlock = src.slice(ownerUserIdx, ownerUserIdx + 200)
    expect(ownerUserBlock).toContain(".references('id')")
    expect(ownerUserBlock).toContain(".inTable('nivaro_users')")
    expect(ownerUserBlock).toContain(".onDelete('NO ACTION')")

    // NO ACTION is the fix for the multi-cascade-path risk — CASCADE must
    // never appear anywhere in this migration.
    expect(src).not.toContain("onDelete('CASCADE')")
  })

  it('obligation_id on nivaro_erp_submissions stays FK-free by design — the retention pass prunes obligations on its own schedule', () => {
    const obligationIdIdx = src.indexOf("t.bigInteger('obligation_id')")
    expect(obligationIdIdx).toBeGreaterThan(-1)
    const nearbyBlock = src.slice(obligationIdIdx, obligationIdIdx + 300)
    expect(nearbyBlock).not.toContain('.references(')
    // plain, but indexed — a submission's status change still needs to find
    // its obligation fast
    expect(nearbyBlock).toContain("t.index('obligation_id'")
  })

  it('the record index is raw SQL naming every column, including id DESC — knex cannot express that in the schema builder', () => {
    expect(src).toContain('ON nivaro_integration_obligations (collection, item, kind, id DESC)')
    const upBody = src.slice(src.indexOf('export async function up'), src.indexOf('export async function down'))
    // and it must not ALSO be declared through the schema builder, which
    // cannot carry DESC and would silently produce the wrong index
    expect(upBody).not.toContain("t.index(['collection', 'item', 'kind']")
  })

  it('down() drops the owner_user FK before dropping the column it lives on', () => {
    const downBody = src.slice(src.indexOf('export async function down'))
    const dropForeignIdx = downBody.indexOf("dropForeign('owner_user')")
    const dropColumnIdx = downBody.indexOf("dropColumn('owner_user')")
    expect(dropForeignIdx).toBeGreaterThan(-1)
    expect(dropColumnIdx).toBeGreaterThan(dropForeignIdx)
  })

  it('defaults the grace windows to the spec values', () => {
    expect(src).toContain('defaultTo(60)')
    expect(src).toContain('defaultTo(30)')
  })
})
