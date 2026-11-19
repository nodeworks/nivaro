import knex from 'knex'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../db/index.js', () => ({ db: knex({ client: 'mssql' }) }))

import type { TimelineMark } from './logic.js'
import { firstErrorLine, shapeSlotMarks } from './slot.js'

/** The slot sheet's details: each mark gets its job, time taken, error line and who. */

const job = (run_id: number, failed = false): TimelineMark => ({
  at: '2026-11-18T13:20:00.000Z',
  kind: 'job',
  failed,
  sentence: failed ? 'x failed' : 'x ran',
  href: '/jobs',
  run_id
})

describe('firstErrorLine', () => {
  it('keeps the first line, trimmed and capped', () => {
    expect(firstErrorLine('Timeout\n    at foo (bar.ts:1)')).toBe('Timeout')
    expect(firstErrorLine(null)).toBeUndefined()
    expect(firstErrorLine('   \nsecond')).toBeUndefined()
    const long = firstErrorLine('x'.repeat(400)) as string
    expect(long.length).toBe(300)
    expect(long.endsWith('…')).toBe(true)
  })
})

describe('shapeSlotMarks', () => {
  const registry = [
    { id: 'staged-imports', description: 'Loads staged files' },
    { id: 'ext:acme:sync-orders', extensionId: 'acme', description: 'Pulls orders' }
  ]
  const runs = [
    {
      id: 1,
      job_id: 'staged-imports',
      label: 'staged-imports',
      kind: 'cron',
      status: 'completed',
      duration_ms: 120,
      error: null,
      triggered_by: null
    },
    {
      id: 2,
      job_id: 'ext:acme:sync-orders',
      label: 'Sync orders',
      kind: 'cron',
      status: 'error',
      duration_ms: 4500,
      error: 'Partner said 503\nstack…',
      triggered_by: 'AAAA-1'
    }
  ]
  const acts = [{ id: 9, user: 'bbbb-2', collection: 'nivaro_flows' }]
  const names = new Map([
    ['AAAA-1', 'Pat Lee'],
    ['BBBB-2', 'Sam Ray']
  ])

  it('adds the job, extension, purpose, time taken and the failed run’s error line', () => {
    const [a, b] = shapeSlotMarks([job(1), job(2, true)], runs, acts, names, registry)
    expect(a).toMatchObject({
      job_id: 'staged-imports',
      run_kind: 'cron',
      description: 'Loads staged files',
      duration_ms: 120
    })
    // A label equal to the id says nothing more; no error on a run that worked.
    expect(a.job_label).toBeUndefined()
    expect(a.error).toBeUndefined()
    expect(a.manual).toBeUndefined()
    expect(b).toMatchObject({
      job_id: 'ext:acme:sync-orders',
      job_label: 'Sync orders',
      extension: 'acme',
      error: 'Partner said 503',
      manual: true,
      user: 'AAAA-1',
      user_name: 'Pat Lee'
    })
  })

  it('names who made a config change', () => {
    const [c] = shapeSlotMarks(
      [
        {
          at: '2026-11-18T13:21:00.000Z',
          kind: 'config',
          failed: false,
          sentence: 'Changed a flow',
          href: '/activity/9',
          activity_id: 9
        }
      ],
      runs,
      acts,
      names,
      registry
    )
    expect(c).toMatchObject({ collection: 'nivaro_flows', user: 'bbbb-2', user_name: 'Sam Ray' })
  })

  it('keeps a mark whose run is gone as it was', () => {
    const [m] = shapeSlotMarks([job(77)], runs, acts, names, registry)
    expect(m).toEqual(job(77))
  })
})
