import { describe, expect, it, vi } from 'vitest'

vi.mock('../db/index.js', () => ({ db: () => ({}) }))

import {
  cleanDevice,
  DRAFT_TTL_MS,
  draftExpired,
  filterDraftFields,
  openDraft,
  sealDraft
} from './record-drafts.js'

const draft = {
  key: 'orders:7:u1',
  fields: { title: 'New title', secret_note: 'private', amount: 5 },
  base: { title: 'Old', secret_note: '', amount: 4 },
  filled: ['amount', 'secret_note'],
  pending_rows: { 'lines.order': [{ qty: 1 }] }
}

describe('sealDraft / openDraft', () => {
  it('round-trips the payload and the device, and the stored text shows no value', () => {
    const device = { id: 'abc123def', label: 'phone' }
    const text = sealDraft(draft, device)
    expect(text.startsWith('enc:d1:')).toBe(true)
    expect(text).not.toContain('private')
    expect(text).not.toContain('New title')
    expect(openDraft(text)).toEqual({ payload: draft, device })
  })

  it('seals the same draft differently every time', () => {
    expect(sealDraft(draft, null)).not.toBe(sealDraft(draft, null))
  })

  it('still reads a row written before sealing (plain JSON, no device)', () => {
    expect(openDraft(JSON.stringify(draft))).toEqual({ payload: draft, device: null })
  })

  it('answers null for a tampered or foreign row', () => {
    const text = sealDraft(draft, null)
    const parts = text.split(':')
    parts[parts.length - 1] = Buffer.from('tampered').toString('base64')
    expect(openDraft(parts.join(':'))).toBeNull()
    expect(openDraft('enc:d1:not:valid')).toBeNull()
    expect(openDraft('not json')).toBeNull()
  })
})

describe('cleanDevice', () => {
  it('keeps a plain id and one of the known labels', () => {
    expect(cleanDevice({ id: 'abc123def', label: 'Laptop' })).toEqual({
      id: 'abc123def',
      label: 'laptop'
    })
  })
  it('turns an unknown label into "computer" and refuses a bad id', () => {
    expect(cleanDevice({ id: 'abc123def', label: "Rob's MacBook" })?.label).toBe('computer')
    expect(cleanDevice({ id: 'x', label: 'phone' })).toBeNull()
    expect(cleanDevice({ id: 'has spaces here', label: 'phone' })).toBeNull()
    expect(cleanDevice(null)).toBeNull()
    expect(cleanDevice('phone')).toBeNull()
  })
})

describe('draftExpired', () => {
  const now = Date.parse('2026-11-14T12:00:00Z')
  it('lives 7 days from the last save', () => {
    expect(draftExpired(new Date(now - DRAFT_TTL_MS + 60_000), now)).toBe(false)
    expect(draftExpired(new Date(now - DRAFT_TTL_MS - 60_000), now)).toBe(true)
  })
  it('treats an unreadable stamp as expired', () => {
    expect(draftExpired('garbage', now)).toBe(true)
  })
})

describe('filterDraftFields', () => {
  it('keeps everything when the caller may edit every field', () => {
    expect(filterDraftFields(draft, null)).toEqual({ payload: draft, dropped: 0 })
    expect(filterDraftFields(draft, ['*'])).toEqual({ payload: draft, dropped: 0 })
  })

  it('drops fields the caller may no longer edit, with their loaded values and filled marks', () => {
    const { payload, dropped } = filterDraftFields(draft, ['title', 'amount'])
    expect(dropped).toBe(1)
    expect(payload.fields).toEqual({ title: 'New title', amount: 5 })
    expect(payload.base).toEqual({ title: 'Old', amount: 4 })
    expect(payload.filled).toEqual(['amount'])
    // staged lines are judged by the items service on save, not here
    expect(payload.pending_rows).toEqual(draft.pending_rows)
  })

  it('leaves the draft alone when nothing is dropped', () => {
    const r = filterDraftFields(draft, ['title', 'secret_note', 'amount', 'other'])
    expect(r.dropped).toBe(0)
    expect(r.payload).toBe(draft)
  })
})
