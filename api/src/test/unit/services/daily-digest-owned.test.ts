import { describe, expect, it } from 'vitest'
import { MAX_OWNED_LINES, type OwnedRef, ownedLines } from '../../../services/daily-digest.js'

// Army 4 (2026-11-05): "Open items assigned to you (168)" listed 25 rows labelled
// "Workflow 372095" linking every reader to the admin host, and said nothing of the rest.

const ref = (i: number): OwnedRef => ({
  collection: 'workflows',
  item: String(1000 + i),
  stateLabel: 'Waiting on Level 1 Approval',
  addendum: null
})
const links = {
  record: async (c: string, id: string, q?: string) =>
    `https://portal.test/records/${c}/${id}${q ? `?${q}` : ''}`,
  myWork: async () => 'https://portal.test/my-work'
}

describe('daily digest owned lines', () => {
  it('labels by the display template, links per recipient, and points at My Work for the rest', async () => {
    const owned = Array.from({ length: 30 }, (_, i) => ref(i))
    const labels = { 'workflows:1000': 'CR26-81383' }
    const lines = await ownedLines(owned, labels, () => 'Workflow', links)
    expect(lines).toHaveLength(MAX_OWNED_LINES + 1)
    expect(lines[0]).toEqual({
      text: 'Workflow CR26-81383',
      sub: 'Waiting on Level 1 Approval',
      url: 'https://portal.test/records/workflows/1000'
    })
    expect(lines[1].text).toBe('Workflow 1001') // no label → the id, never blank
    expect(lines.at(-1)).toEqual({
      text: '+5 more — see them all on My Work',
      sub: null,
      url: 'https://portal.test/my-work'
    })
  })

  it('an addendum links its parent with the addendum view', async () => {
    const lines = await ownedLines(
      [
        {
          collection: 'nivaro_addendums',
          item: 'a-1',
          stateLabel: 'Review',
          addendum: { id: 'a-1', parentCollection: 'workflows', parentId: '7', title: 'Extra' }
        }
      ],
      { 'workflows:7': 'CR26-1' },
      () => 'Workflow',
      links
    )
    expect(lines).toEqual([
      {
        text: 'Addendum "Extra" · Workflow CR26-1',
        sub: 'Review',
        url: 'https://portal.test/records/workflows/7?addendum=a-1'
      }
    ])
  })

  it('no "more" line when everything fits', async () => {
    const lines = await ownedLines([ref(0)], {}, () => 'Workflow', links)
    expect(lines).toHaveLength(1)
  })
})
