import type { Knex } from 'knex'

// nivaro_policies is read on the hot path of EVERY items request — can(),
// getAllowedFields() and getRowFilter() each look up a policy, and readItems
// repeats the last two per expanded M2O relation. The table shipped with only
// its clustered PK on `id`, so each of those lookups scanned all 3,670 wide
// rows (~58ms measured), stacking into a ~600ms floor on every list/read call
// regardless of collection size.
//
// The covering index matches the exact predicate shape used by all three:
//   WHERE role = ? AND action = ? AND (collection = ? OR collection = '*')

export async function up(knex: Knex): Promise<void> {
  const exists = await knex.raw(
    `SELECT 1 AS found FROM sys.indexes WHERE name = 'idx_policies_role_action_collection' AND object_id = OBJECT_ID('nivaro_policies')`
  )
  if (Array.isArray(exists) && exists.length > 0) return
  await knex.raw(
    `CREATE INDEX idx_policies_role_action_collection
     ON nivaro_policies (role, action, collection)`
  )
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(
    `IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_policies_role_action_collection' AND object_id = OBJECT_ID('nivaro_policies'))
     DROP INDEX idx_policies_role_action_collection ON nivaro_policies`
  )
}
