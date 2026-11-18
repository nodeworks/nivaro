import knex from 'knex'
import { describe, expect, it } from 'vitest'
import { skipHandedOffExports } from '../../../services/job-run-sweeps.js'

// Background exports handed to a drainer are skipped by the starter's shutdown and boot sweeps
// (fix round 3): the SQL both sweeps run.
describe('skipHandedOffExports', () => {
  it('keeps runs with no lease holder or another one; leaves handed-off exports out', () => {
    const k = knex({ client: 'mssql' })
    const q = skipHandedOffExports(
      k('nivaro_job_runs').where('status', 'running').where('instance_id', 'web-1')
    )
    const { sql, bindings } = q.select('id').toSQL()
    expect(sql).toMatch(/\[lease_holder\] is null or \[lease_holder\] not in \(\?, \?\)/)
    expect(bindings).toEqual(['running', 'web-1', 'export-handoff', 'export-drainer'])
  })
})
