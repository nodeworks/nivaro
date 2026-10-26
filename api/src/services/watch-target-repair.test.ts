import { describe, expect, it } from 'vitest'
import { repairWatchRow, watchedFromTarget } from './watch-target-repair.js'

const misfiled = {
  id: 7,
  collection: 'projects',
  item: '8181',
  subject: 'Sam Patel updated workflows CM26-81250 on 2026-KEY-CMTS-EXP',
  target: JSON.stringify({
    kind: 'record',
    collection: 'projects',
    id: '8181',
    query: `row=${encodeURIComponent('workflows:372799')}`,
    action: 'open'
  }),
  detail: JSON.stringify({
    why: { kind: 'watch', text: 'You watch workflows CM26-81250 on 2026-KEY-CMTS-EXP.' }
  })
}
const bound = new Set(['workflows', 'inventory_request'])

describe('watch target repair', () => {
  it('reads the watched record from the stored row query', () => {
    expect(watchedFromTarget(misfiled.target)).toEqual({ collection: 'workflows', id: '372799' })
    expect(watchedFromTarget('{"kind":"record"}')).toBeNull()
    expect(watchedFromTarget('not json')).toBeNull()
  })

  it('puts a misfiled workflow watch back on the workflow', () => {
    const fix = repairWatchRow(misfiled, bound, { own: 'CM26-81250', parent: '2026-KEY-CMTS-EXP' })
    expect(fix).toMatchObject({ id: 7, collection: 'workflows', item: '372799' })
    expect(JSON.parse(fix!.target)).toEqual({
      kind: 'record',
      collection: 'workflows',
      id: '372799',
      action: 'open'
    })
    expect(fix!.subject).toBe('Sam Patel updated CM26-81250')
    expect(JSON.parse(fix!.detail!).why.text).toBe('You watch CM26-81250.')
  })

  it('leaves real row watches (lines, forecast years) alone', () => {
    const line = {
      ...misfiled,
      collection: 'workflows',
      item: '372799',
      target: JSON.stringify({
        kind: 'record',
        query: `row=${encodeURIComponent('workflow_line_items:55')}`
      })
    }
    expect(repairWatchRow(line, bound)).toBeNull()
  })

  it('keeps the subject when the phrase is not there', () => {
    const fix = repairWatchRow({ ...misfiled, subject: 'Something else' }, bound, {
      own: 'CM26-1',
      parent: 'P'
    })
    expect(fix?.subject).toBeUndefined()
    expect(fix?.collection).toBe('workflows')
  })

  it('is idempotent', () => {
    const fixed = { ...misfiled, collection: 'workflows', item: '372799' }
    expect(repairWatchRow(fixed, bound)).toBeNull()
  })
})
