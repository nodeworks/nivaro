import { describe, expect, it } from 'vitest'
import { bulkLinksValue, bulkPreviewSentence, bulkUpdateOutcome } from './bulk-update-preview'

const base = { would_update: 0, skipped: 0, refused: 0, refused_reason: null, unreadable: 0 }

describe('bulk update preview', () => {
  it('builds the to-many value for each mode, without duplicates', () => {
    expect(bulkLinksValue('append', [1, 2, 2])).toEqual({ create: [1, 2] })
    expect(bulkLinksValue('replace', [])).toEqual({ set: [] })
    expect(bulkLinksValue('remove', ['A', 'a'])).toEqual({ delete: ['A'] })
  })

  it('words a plain field preview', () => {
    expect(
      bulkPreviewSentence({
        ...base,
        would_update: 12,
        skipped: 3,
        refused: 1,
        refused_reason: 'locked on its form'
      })
    ).toEqual({
      headline: 'Changes 12 records',
      notes: ['3 records already hold it', '1 record refused — locked on its form']
    })
  })

  it('words Add / Replace / Remove', () => {
    expect(
      bulkPreviewSentence(
        { ...base, would_update: 14, skipped: 3, links_added: 28, links_removed: 0 },
        { mode: 'append' }
      )
    ).toEqual({ headline: 'Adds 28 links to 14 records', notes: ['3 records already have them'] })
    expect(
      bulkPreviewSentence(
        { ...base, would_update: 14, links_added: 28, links_removed: 21 },
        { mode: 'replace' }
      ).headline
    ).toBe('Removes 21 links and adds 28 across 14 records')
    expect(
      bulkPreviewSentence(
        { ...base, would_update: 2, skipped: 1, links_removed: 2 },
        { mode: 'remove' }
      )
    ).toEqual({ headline: 'Removes 2 links from 2 records', notes: ['1 record has none of them'] })
    expect(bulkPreviewSentence({ ...base, skipped: 4 }, { mode: 'append' }).headline).toBe(
      'Nothing would change'
    )
  })

  it('says when the links cannot be read', () => {
    const s = bulkPreviewSentence(
      { ...base, would_update: 5, links_unknown: true },
      { mode: 'append' }
    )
    expect(s.headline).toBe('Changes 5 records')
    expect(s.notes[0]).toMatch(/cannot read the current links/)
  })

  it('names every record the write did not change, never raw error text', () => {
    expect(
      bulkUpdateOutcome({
        updated: 2,
        skipped: 1,
        links_added: 3,
        failed: 2,
        failures: [{ id: 'X', reason: 'Ana Ruiz is editing this record' }]
      })
    ).toBe(
      'Updated 2 records (3 links added) · 1 already there · 2 not changed — Ana Ruiz is editing this record'
    )
    const raw = bulkUpdateOutcome({
      updated: 0,
      failed: 1,
      failures: [{ id: 'X', reason: 'TypeError: Cannot read properties of undefined' }]
    })
    expect(raw).not.toMatch(/TypeError/)
  })
})
