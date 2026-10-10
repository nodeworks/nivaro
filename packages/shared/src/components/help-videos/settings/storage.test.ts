import { describe, expect, it } from 'vitest'
import type { StorageVideo } from './api'
import {
  formatBytes,
  nextStorageSort,
  parseRetentionInput,
  sortStorageRows,
  storageRows
} from './storage'

const MB = 1024 * 1024
const file = (role: 'source' | 'rendered' | 'captions' | 'poster', bytes: number | null) => ({
  role,
  id: `${role}-${bytes}`,
  bytes
})

const videos: StorageVideo[] = [
  {
    id: 'a',
    title: 'Approve',
    status: 'published',
    poster: file('poster', 10),
    bytes: 0,
    by_role: { source: 0, rendered: 0, captions: 0, poster: 0 },
    versions: [
      {
        id: 'a2',
        version: 2,
        created_at: '2026-10-02T00:00:00.000Z',
        is_published: true,
        is_draft: false,
        render_status: 'ready',
        files_removed_at: null,
        files: [file('source', 50 * MB), file('rendered', 20 * MB), file('captions', 1000)],
        bytes: 0
      },
      {
        id: 'a1',
        version: 1,
        created_at: '2026-09-01T00:00:00.000Z',
        is_published: false,
        is_draft: false,
        render_status: 'none',
        files_removed_at: '2026-10-01T00:00:00.000Z',
        files: [],
        bytes: 0
      }
    ]
  },
  {
    id: 'b',
    title: 'Blur',
    status: 'draft',
    poster: null,
    bytes: 0,
    by_role: { source: 0, rendered: 0, captions: 0, poster: 0 },
    versions: [
      {
        id: 'b1',
        version: 1,
        created_at: '2026-10-05T00:00:00.000Z',
        is_published: false,
        is_draft: true,
        render_status: 'none',
        files_removed_at: null,
        files: [file('source', 5 * MB), file('poster', null)],
        bytes: 0
      }
    ]
  }
]

describe('formatBytes', () => {
  it('reads like a person would', () => {
    expect(formatBytes(null)).toBe('—')
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(900)).toBe('900 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(20 * MB)).toBe('20 MB')
    expect(formatBytes(3.2 * 1024 * MB)).toBe('3.2 GB')
  })
})

describe('storageRows', () => {
  it('makes one row per version and folds the library poster into the published row', () => {
    const rows = storageRows(videos)
    expect(rows.map((r) => [r.title, r.version, r.state])).toEqual([
      ['Approve', 2, 'published'],
      ['Approve', 1, 'removed'],
      ['Blur', 1, 'draft']
    ])
    expect(rows[0]).toMatchObject({
      source: 50 * MB,
      rendered: 20 * MB,
      captions: 1000,
      poster: 10,
      bytes: 70 * MB + 1010
    })
    // A missing files row counts nothing.
    expect(rows[2]).toMatchObject({ source: 5 * MB, poster: 0, bytes: 5 * MB })
  })
})

describe('sortStorageRows', () => {
  it('sorts by size, title and state either way', () => {
    const rows = storageRows(videos)
    expect(sortStorageRows(rows, { key: 'bytes', dir: 'desc' }).map((r) => r.version_id)).toEqual([
      'a2',
      'b1',
      'a1'
    ])
    expect(sortStorageRows(rows, { key: 'bytes', dir: 'asc' }).map((r) => r.version_id)).toEqual([
      'a1',
      'b1',
      'a2'
    ])
    expect(sortStorageRows(rows, { key: 'title', dir: 'asc' }).map((r) => r.version_id)).toEqual([
      'a1',
      'a2',
      'b1'
    ])
    expect(sortStorageRows(rows, { key: 'state', dir: 'asc' }).map((r) => r.state)).toEqual([
      'published',
      'draft',
      'removed'
    ])
    expect(
      sortStorageRows(rows, { key: 'created_at', dir: 'desc' }).map((r) => r.version_id)
    ).toEqual(['b1', 'a2', 'a1'])
  })
  it('does not change the rows it was given', () => {
    const rows = storageRows(videos)
    const before = rows.map((r) => r.version_id)
    sortStorageRows(rows, { key: 'bytes', dir: 'asc' })
    expect(rows.map((r) => r.version_id)).toEqual(before)
  })
})

describe('nextStorageSort', () => {
  it('starts sizes and dates large-first, names a-first, and flips on a second press', () => {
    const start = { key: 'bytes', dir: 'desc' } as const
    expect(nextStorageSort(start, 'source')).toEqual({ key: 'source', dir: 'desc' })
    expect(nextStorageSort(start, 'created_at')).toEqual({ key: 'created_at', dir: 'desc' })
    expect(nextStorageSort(start, 'title')).toEqual({ key: 'title', dir: 'asc' })
    expect(nextStorageSort(start, 'bytes')).toEqual({ key: 'bytes', dir: 'asc' })
  })
})

describe('parseRetentionInput', () => {
  const limits = { retention_min_days: 1, retention_max_days: 3650 }
  it('blank keeps everything, a whole number of days saves, anything else is named', () => {
    expect(parseRetentionInput('', limits)).toEqual({ ok: true, days: null })
    expect(parseRetentionInput(' 30 ', limits)).toEqual({ ok: true, days: 30 })
    expect(parseRetentionInput('0', limits).ok).toBe(false)
    expect(parseRetentionInput('2.5', limits).ok).toBe(false)
    expect(parseRetentionInput('9999', limits).ok).toBe(false)
    expect(parseRetentionInput('abc', limits).ok).toBe(false)
  })
})
