import { describe, expect, it } from 'vitest'
import {
  groupFindings,
  judgeAnnounceCoverage
} from '../../../services/announce-coverage-readiness.js'

describe('announce coverage readiness (rt4 #17)', () => {
  it('passes when nothing writes unannounced and nothing was caught', () => {
    const r = judgeAnnounceCoverage({
      unannounced: [],
      source: 'sql-checks',
      caught: {},
      watcherSeen: true
    })
    expect(r.status).toBe('pass')
    expect(r.detail).toContain('Every procedure')
  })

  it('warns (never fails) with procedures per collection, busiest first', () => {
    const r = judgeAnnounceCoverage({
      unannounced: [
        { collection: 'Workflows', procedures: ['dbo.a', 'dbo.b'] },
        { collection: 'inventory_request', procedures: ['dbo.c'] }
      ],
      source: 'sql-checks',
      caught: { inventory_request: 40, workflows: 2, invoices: 7 },
      watcherSeen: true
    })
    expect(r.status).toBe('warn')
    expect(r.detail).toContain('2 collections written by 3 procedures that do not announce')
    expect(r.detail).toContain('49 rows caught by the safety net in 24 h')
    expect(r.blockers?.[0]).toBe(
      'inventory_request: written by dbo.c without announcing; 40 rows caught by the safety net in 24 h'
    )
    expect(r.blockers?.[1]).toContain('invoices: 7 rows caught')
    expect(r.blockers?.[1]).toContain('no procedure check found')
    expect(r.blockers?.[2]).toBe(
      'Workflows: written by dbo.a, dbo.b without announcing; 2 rows caught by the safety net in 24 h'
    )
  })

  it('says when the procedure list was read just now', () => {
    const r = judgeAnnounceCoverage({
      unannounced: [{ collection: 'x', procedures: ['dbo.p'] }],
      source: 'live-scan',
      caught: {},
      watcherSeen: false
    })
    expect(r.status).toBe('warn')
    expect(r.detail).toContain('the SQL checks have not run')
  })

  it('groups findings by the collection their detail names', () => {
    const out = groupFindings([
      {
        object_schema: 'dbo',
        object_name: 'p1',
        object_type: 'procedure',
        detail: JSON.stringify({ collection: 'Workflows' })
      },
      {
        object_schema: 'dbo',
        object_name: 'p2',
        object_type: 'procedure',
        detail: JSON.stringify({ collection: 'workflows' })
      },
      {
        object_schema: null,
        object_name: 'po-import',
        object_type: 'import_definition',
        detail: JSON.stringify({ collection: 'orders' })
      },
      { object_schema: 'dbo', object_name: 'p3', object_type: 'procedure', detail: 'not json' }
    ])
    expect(out).toEqual([
      { collection: 'Workflows', procedures: ['dbo.p1', 'dbo.p2'] },
      { collection: 'orders', procedures: ['import po-import'] }
    ])
  })
})
