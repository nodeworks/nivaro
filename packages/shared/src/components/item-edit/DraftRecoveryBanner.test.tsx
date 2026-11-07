// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { draftFilledBack, type StoredDraft } from '../../lib/draft-store'
import { DraftRecoveryBanner } from './DraftRecoveryBanner'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function draftOf(over: Partial<StoredDraft>): StoredDraft {
  return {
    key: 'k',
    collection: 'inventory_request',
    item_id: 'new',
    user_id: 'u',
    saved_at: new Date().toISOString(),
    fields: {},
    base: {},
    base_updated_at: null,
    pending_rows: {},
    pending_edits: {},
    pending_deletes: {},
    m2m_links: {},
    m2m_unlinks: {},
    ...over
  }
}

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function show(draft: StoredDraft, createdId: string | null = null) {
  act(() =>
    root.render(
      <DraftRecoveryBanner
        draft={draft}
        labelFor={(f) => f}
        current={{}}
        recordChanged={false}
        onRestore={() => {}}
        onDiscard={() => {}}
        createdId={createdId}
        collection='inventory_request'
      />
    )
  )
  return host.textContent ?? ''
}

describe('DraftRecoveryBanner counts (army6 L2)', () => {
  it('counts the person’s own edits, as the Leave dialog does; filled fields apart', () => {
    const text = show(
      draftOf({
        fields: { project: 1, zone: 2, shipping: 3, org_code: 4, billing: 5 },
        filled: ['shipping', 'org_code', 'billing']
      })
    )
    expect(text).toContain('2 fields · 3 filled in from them')
    expect(text).not.toContain('5 fields')
  })

  it('an older draft (no `filled`) counts every field', () => {
    expect(show(draftOf({ fields: { a: 1, b: 2 } }))).toContain('2 fields')
  })

  it('only filled fields: "N fields", never "filled in from them" with nothing before it', () => {
    const text = show(draftOf({ fields: { a: 1, b: 2, c: 3 }, filled: ['a', 'b', 'c'] }))
    expect(text).toContain('3 fields')
    expect(text).not.toContain('filled in')
  })

  it('an existing record counts every field as the person’s (restore keeps them touched)', () => {
    const text = show(
      draftOf({ item_id: '372777', fields: { a: 1, b: 2, c: 3 }, filled: ['b', 'c'] })
    )
    expect(text).toContain('3 fields')
    expect(text).not.toContain('filled in')
  })

  it('an already-created draft never shows the record’s row id', () => {
    const text = show(draftOf({ fields: { a: 1 } }), '372777')
    expect(text).toContain('were already saved as a new record')
    expect(text).toContain('Open the record')
    expect(text).not.toContain('372777')
  })
})

describe('draftFilledBack — the restore and the offer count by one rule (R7 review)', () => {
  it('a new form keeps the rule-filled fields apart', () => {
    const d = draftOf({ fields: { a: 1, b: 2, c: 3 }, filled: ['b', 'c', 'gone'] })
    expect([...draftFilledBack(d)].sort()).toEqual(['b', 'c'])
  })
  it('an existing record: none (every restored value stays protected as touched)', () => {
    expect(
      draftFilledBack(draftOf({ item_id: '9', fields: { a: 1, b: 2 }, filled: ['b'] })).size
    ).toBe(0)
  })
  it('a draft of filled fields only: none (they all come back as the person’s)', () => {
    expect(draftFilledBack(draftOf({ fields: { a: 1 }, filled: ['a'] })).size).toBe(0)
  })
})
