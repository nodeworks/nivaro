import { describe, expect, it } from 'vitest'
import {
  missingRowParamMessage,
  resolveSheetConfig,
  resolveSheetValue,
  totalSheetTitle
} from './PageRenderer'

// Army 6 M12: a Total-row drill read '$row.project_id' off a null row, so the
// sheet ran over every project (or refused with the raw "Missing required
// parameter: projects") under the title "—".
const shown = [
  { project_id: '201001', name: 'Test one' },
  { project_id: '201003', name: 'Test two' },
  { project_id: '201003', name: 'Test two (dup)' }
]

describe('totals-row drill', () => {
  it("'$row.x' on the totals row reads every row the total covers, distinct", () => {
    expect(resolveSheetValue('$row.project_id', null, [], {}, {}, undefined, shown)).toBe(
      '201001,201003'
    )
  })

  it('a clicked row still reads only itself; no total rows → undefined as before', () => {
    expect(
      resolveSheetValue('$row.project_id', { project_id: '9' }, [], {}, {}, undefined, shown)
    ).toBe('9')
    expect(resolveSheetValue('$row.project_id', null, [], {}, {}, undefined)).toBeUndefined()
  })

  it('names row params that found nothing', () => {
    const cfg = resolveSheetConfig(
      { query_slug: 'x', params: { projects: '$row.project_id', fy: '$param.fy' } },
      { name: 'no id' },
      [],
      { fy: '2026' },
      {},
      undefined
    )
    expect(cfg.params).toEqual({ fy: '2026' })
    expect(cfg.unresolved_params).toEqual(['projects'])
    const ok = resolveSheetConfig(
      { query_slug: 'x', params: { projects: '$row.project_id' } },
      null,
      [],
      {},
      {},
      undefined,
      shown
    )
    expect(ok.params).toEqual({ projects: '201001,201003' })
    expect(ok.unresolved_params).toBeUndefined()
  })

  it('titles the sheet "Total of N <noun>"', () => {
    expect(totalSheetTitle({ title: '{{project_id}} — {{project_name}}' }, 9)).toBe(
      'Total of 9 projects'
    )
    expect(totalSheetTitle({ title: '{{project_id}}' }, 1)).toBe('Total of 1 project')
    expect(totalSheetTitle({ title: '{{name}}' }, 3)).toBe('Total of 3 rows')
    expect(totalSheetTitle({ row_noun: 'workflows' }, 1200)).toBe('Total of 1,200 workflows')
  })

  it('never shows the raw missing-parameter refusal', () => {
    const err = {
      status: 400,
      response: {
        statusCode: 400,
        error: 'Bad Request',
        message: 'Missing required parameter: projects'
      }
    }
    expect(missingRowParamMessage(err, ['projects'])).toBe(
      'Nothing to show: the row you opened has no projects.'
    )
    expect(missingRowParamMessage(err, undefined)).toBe('Choose projects to see this view.')
    expect(missingRowParamMessage(new Error('boom'), ['projects'])).toBeNull()
  })
})
