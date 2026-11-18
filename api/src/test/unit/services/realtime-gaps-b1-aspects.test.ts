import type { RecordAspectName } from '@nivaro/extension-kit'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Realtime gaps 2026-11-17, S3: extensions and procedures can announce `$` aspects. A raw
// write's `changed_fields: ['$state']` used to be stripped to "no fields" (clients refetched the
// row only, the pipeline panel never heard the move), and there was no ctx call for aspects.

const h = vi.hoisted(() => ({
  broadcasts: [] as Array<{ collection: string; item: unknown; extra: Record<string, unknown> }>,
  sources: [] as unknown[][],
  fanout: [] as Array<{ list: unknown[]; planned: unknown[] }>,
  catalog: [] as string[]
}))

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/realtime.js', () => ({
  broadcastCollectionUpdate: (
    _io: unknown,
    collection: string,
    item: unknown,
    extra: Record<string, unknown> = {}
  ) => {
    h.broadcasts.push({ collection, item, extra })
  }
}))
vi.mock('../../../services/io-holder.js', () => ({ getIo: () => ({}) }))
vi.mock('../../../services/field-write-sources.js', () => ({
  noteRawWriteSources: async (list: unknown[]) => {
    h.sources.push(list)
  }
}))
vi.mock('../../../services/raw-write-fanout.js', () => ({
  fanOutRawWrites: async (list: unknown[], planned: unknown[]) => {
    h.fanout.push({ list, planned })
  }
}))
vi.mock('../../../services/catalog-impact.js', () => ({
  noteCatalogChange: (c: string) => {
    h.catalog.push(c)
  }
}))

import {
  announceRawWrites,
  cleanFields,
  flushRawWriteQueue,
  planBroadcasts,
  rowsToAnnouncements,
  writesOnly
} from '../../../services/raw-write-announcer.js'
import {
  ASPECT_BULK_CAP,
  announceAspectOnRecords,
  announceRecordAspects,
  isRecordAspect,
  RECORD_ASPECTS,
  type RecordAspect
} from '../../../services/record-events.js'

beforeEach(() => {
  h.broadcasts.length = 0
  h.sources.length = 0
  h.fanout.length = 0
  h.catalog.length = 0
})

describe('S3 — the aspect list is one contract', () => {
  it('the extension kit names exactly the API aspects', () => {
    // Compile-time twin check: both directions must be assignable.
    const a: RecordAspectName[] = [...RECORD_ASPECTS]
    const b: RecordAspect[] = a
    expect(b).toHaveLength(RECORD_ASPECTS.length)
    expect(new Set(RECORD_ASPECTS).size).toBe(RECORD_ASPECTS.length)
  })
  it('isRecordAspect knows the list and nothing else', () => {
    expect(isRecordAspect('$state')).toBe(true)
    expect(isRecordAspect('$proposals')).toBe(true)
    expect(isRecordAspect('$attributes')).toBe(true)
    expect(isRecordAspect('$nope')).toBe(false)
    expect(isRecordAspect('state')).toBe(false)
    expect(isRecordAspect(null)).toBe(false)
  })
})

describe('S3 — raw writes keep known $ aspects', () => {
  it('cleanFields keeps identifiers and known aspects, drops the rest', () => {
    expect(cleanFields(['amount', '$state', '$tasks', '$evil', 'a b', '$state'])).toEqual([
      'amount',
      '$state',
      '$tasks'
    ])
    expect(cleanFields('$state,status')).toEqual(['$state', 'status'])
  })
  it('planBroadcasts carries $state through (one event per id, no action)', () => {
    const out = planBroadcasts([
      { collection: 'workflows', ids: [1, 2], changed_fields: ['$state'] }
    ])
    expect(out).toEqual([
      { collection: 'workflows', item: '1', changed_fields: ['$state'] },
      { collection: 'workflows', item: '2', changed_fields: ['$state'] }
    ])
  })
  it('procedure inbox rows keep $state too', () => {
    expect(
      rowsToAnnouncements([{ collection: 'workflows', item: '7', changed_fields: '$state' }])[0]
        .changed_fields
    ).toEqual(['$state'])
  })
  it('writesOnly drops aspect-only notices and strips aspects from mixed ones', () => {
    expect(
      writesOnly([
        { collection: 'a', ids: [1], changed_fields: ['$state'] },
        { collection: 'b', ids: [1], changed_fields: ['amount', '$related'] },
        { collection: 'c', ids: [1] }
      ])
    ).toEqual([
      { collection: 'b', ids: [1], changed_fields: ['amount'] },
      { collection: 'c', ids: [1] }
    ])
  })
  it('an aspect-only raw announcement broadcasts but is not a field write', async () => {
    await announceRawWrites('workflows', [5], { changed_fields: ['$state'], source: 'x' })
    flushRawWriteQueue()
    expect(h.broadcasts).toEqual([
      {
        collection: 'workflows',
        item: '5',
        extra: { changed_fields: ['$state'], source: 'raw' }
      }
    ])
    // No "set by" source, no outside-write webhooks/flows/GraphQL event, no catalog poke.
    expect(h.sources).toEqual([[]])
    expect(h.fanout).toEqual([{ list: [], planned: [] }])
    expect(h.catalog).toEqual([])
  })
  it('a real field write still fans out', async () => {
    await announceRawWrites('workflows', [5], { action: 'update', changed_fields: ['amount'] })
    flushRawWriteQueue()
    expect(h.fanout[0].list).toHaveLength(1)
    expect(h.catalog).toEqual(['workflows'])
  })
})

describe('S3 — announceRecordAspects (ctx.realtime.announceAspect)', () => {
  it('one notice per record, unknown aspects rejected', () => {
    const r = announceRecordAspects('workflows', ['1', 2, '1', ''], ['$state', '$nope', '$state'])
    expect(r).toEqual({ announced: 2, rejected: ['$nope'] })
    expect(h.broadcasts).toEqual([
      { collection: 'workflows', item: '1', extra: { changed_fields: ['$state'] } },
      { collection: 'workflows', item: '2', extra: { changed_fields: ['$state'] } }
    ])
  })
  it('a single id works', () => {
    expect(announceRecordAspects('workflows', 9, ['$tasks']).announced).toBe(1)
  })
  it('past the cap: one collection-wide notice', () => {
    const ids = Array.from({ length: ASPECT_BULK_CAP + 1 }, (_, i) => i + 1)
    expect(announceRecordAspects('workflows', ids, ['$state']).announced).toBe(1)
    expect(h.broadcasts).toEqual([
      {
        collection: 'workflows',
        item: '*',
        extra: { changed_fields: ['$state'], bulk: ASPECT_BULK_CAP + 1 }
      }
    ])
  })
  it('nothing goes out for no known aspect, no ids or a bad collection name', () => {
    expect(announceRecordAspects('workflows', [1], ['state'])).toEqual({
      announced: 0,
      rejected: ['state']
    })
    expect(announceRecordAspects('workflows', [], ['$state']).announced).toBe(0)
    expect(announceRecordAspects('bad name;', [1], ['$state']).announced).toBe(0)
    expect(h.broadcasts).toEqual([])
  })
})

describe('S11 — announceAspectOnRecords', () => {
  it('one notice per distinct record, rows without a record skipped', () => {
    const n = announceAspectOnRecords(
      [
        { collection: 'workflows', item: '1' },
        { collection: 'workflows', item: '1' },
        { collection: 'pos', item: 4 },
        { collection: null, item: '3' },
        { collection: 'pos', item: null }
      ],
      ['$tasks']
    )
    expect(n).toBe(2)
    expect(h.broadcasts.map((b) => `${b.collection}:${b.item}`)).toEqual(['workflows:1', 'pos:4'])
  })
})
