import { describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({ first: [] as unknown[][] }))
vi.mock('../../db/index.js', () => ({
  db: () => {
    const q: any = {
      where: () => q,
      first: async (...cols: unknown[]) => {
        calls.first.push(cols)
        return { id: 5, title: 't' }
      }
    }
    return q
  }
}))
vi.mock('../app-links.js', () => ({ linkTo: async () => 'https://nivaro.test/issues' }))
vi.mock('../issue-raise.js', () => ({
  hitCounts: async () => ({ hits: 0, people: 0 }),
  hitKey: () => 'k'
}))

import { ISSUE_LITE_COLUMNS, loadIssue, loadIssueLite } from './issue-body.js'

describe('loadIssueLite (final review M6)', () => {
  it('names its columns and never reads the screenshot blob', async () => {
    calls.first = []
    expect(await loadIssueLite(5)).toEqual({ id: 5, title: 't' })
    expect(calls.first[0]).toEqual(ISSUE_LITE_COLUMNS)
    expect(ISSUE_LITE_COLUMNS).not.toContain('screenshot')
    for (const c of ['id', 'title', 'details', 'fingerprint', 'source', 'recording_id'])
      expect(ISSUE_LITE_COLUMNS).toContain(c)
    // the whole row is still there for create paths (they attach the screenshot)
    await loadIssue(5)
    expect(calls.first[1]).toEqual([])
  })
})
