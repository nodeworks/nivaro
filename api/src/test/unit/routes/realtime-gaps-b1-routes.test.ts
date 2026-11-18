import { beforeEach, describe, expect, it, vi } from 'vitest'

// Realtime gaps 2026-11-17, batch B1: S2 (default-mode CSV import) and Low 2 (column presets).

const h = vi.hoisted(() => ({
  raw: [] as Array<{ collection: string; ids: unknown; opts: Record<string, unknown> }>
}))

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/raw-write-announcer.js', () => ({
  BULK_CAP: 100,
  announceRawWrites: async (
    collection: string,
    ids: unknown,
    opts: Record<string, unknown> = {}
  ) => {
    h.raw.push({ collection, ids, opts })
  }
}))

import {
  announceImportWrites,
  IMPORT_IDS_KEPT,
  keepImportId,
  type RawImportTouched
} from '../../../routes/imports.js'
import { presetWriteAnnounces } from '../../../routes/presets.js'

beforeEach(() => {
  h.raw.length = 0
})

describe('S2 — a default-mode CSV import announces what it wrote', () => {
  it('created and overwritten rows: one announcement per action, with the field names', () => {
    announceImportWrites(
      {
        collection: 'vendors',
        created: [1, 2, null],
        unknownCreate: false,
        updated: [7],
        fields: new Set(['name', 'city'])
      },
      'import:job-9'
    )
    expect(h.raw).toEqual([
      {
        collection: 'vendors',
        ids: [1, 2],
        opts: { action: 'create', source: 'import:job-9', noticeOnly: true }
      },
      {
        collection: 'vendors',
        ids: [7],
        opts: {
          action: 'update',
          changed_fields: ['name', 'city'],
          source: 'import:job-9',
          noticeOnly: true
        }
      }
    ])
  })
  it('an insert whose id could not be read makes it collection-wide', () => {
    announceImportWrites(
      { collection: 'vendors', created: [1], unknownCreate: true, updated: [], fields: new Set() },
      'import:job-9'
    )
    expect(h.raw).toEqual([
      {
        collection: 'vendors',
        ids: null,
        opts: { action: 'create', source: 'import:job-9', noticeOnly: true }
      }
    ])
  })
  it('a through-items import (nothing raw) announces nothing here', () => {
    announceImportWrites(
      { collection: null, created: [], unknownCreate: false, updated: [], fields: new Set() },
      'import:job-9'
    )
    expect(h.raw).toEqual([])
  })
})

describe('S2 — a big import never holds every id (B1 review)', () => {
  it('keeps at most 101 ids per action, then announces collection-wide', () => {
    const t: RawImportTouched = {
      collection: 'vendors',
      created: [],
      unknownCreate: false,
      updated: [],
      fields: new Set(['name'])
    }
    for (let i = 0; i < 5000; i++) keepImportId(t.created, i + 1)
    for (let i = 0; i < 50; i++) keepImportId(t.updated, i + 1)
    expect(t.created).toHaveLength(IMPORT_IDS_KEPT)
    expect(IMPORT_IDS_KEPT).toBe(101)
    announceImportWrites(t, 'import:job-1')
    expect(h.raw[0]).toMatchObject({ collection: 'vendors', ids: null })
    expect((h.raw[1].ids as unknown[]).length).toBe(50)
  })
  it('exactly 100 ids still go out by id', () => {
    const t: RawImportTouched = {
      collection: 'vendors',
      created: [],
      unknownCreate: false,
      updated: [],
      fields: new Set()
    }
    for (let i = 0; i < 100; i++) keepImportId(t.created, i + 1)
    announceImportWrites(t, 'import:job-1')
    expect((h.raw[0].ids as unknown[]).length).toBe(100)
  })
})

describe('Low 2 — preset writes tell the person’s other tabs', () => {
  it('only successful writes announce', () => {
    expect(presetWriteAnnounces('POST', 201)).toBe(true)
    expect(presetWriteAnnounces('PATCH', 200)).toBe(true)
    expect(presetWriteAnnounces('DELETE', 204)).toBe(true)
    expect(presetWriteAnnounces('GET', 200)).toBe(false)
    expect(presetWriteAnnounces('POST', 403)).toBe(false)
  })
})
