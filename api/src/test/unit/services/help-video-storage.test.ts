import { beforeEach, describe, expect, it, vi } from 'vitest'

// Storage housekeeping (#1531): the report from rows, the retention setting,
// the plan (what a sweep removes and why) and the sweep on a mocked database.

const h = vi.hoisted(() => ({
  column: true,
  settingsColumn: true,
  stored: {} as Record<string, unknown>,
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  updates: [] as Array<{ table: string; patch: Record<string, unknown>; whereNull: string[] }>,
  deletes: [] as Array<{ table: string; ids: unknown[] }>,
  deletedFiles: [] as string[],
  settingsRow: { id: 1, help_video_settings: null as string | null }
}))
vi.mock('../../../lib/column-probe.js', () => ({
  hasColumn: async (_t: string, c: string) =>
    c === 'help_video_settings' ? h.settingsColumn : h.column
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => 1) }))
vi.mock('../../../services/io-holder.js', () => ({ getApp: () => ({ log: { warn: vi.fn() } }) }))
vi.mock('../../../services/files.js', () => ({
  deleteFile: vi.fn(async (id: string) => {
    if (id === 'bad') throw new Error('storage down')
    h.deletedFiles.push(id)
  })
}))
vi.mock('../../../db/index.js', () => ({
  db: (table: string) => {
    let inIds: unknown[] = []
    const whereNull: string[] = []
    const rows = () => h.tables[table] ?? []
    const q: Record<string, unknown> = {}
    q.where = () => q
    q.whereIn = (_c: string, ids: unknown[]) => {
      inIds = ids
      return q
    }
    q.whereNull = (c: string) => {
      whereNull.push(c)
      return q
    }
    q.select = async () => {
      if (table === 'nivaro_files')
        return rows().filter((r) => inIds.includes(String(r.id).toUpperCase()))
      return rows()
    }
    q.first = async () => (table === 'nivaro_settings' ? { ...h.settingsRow } : rows()[0])
    q.update = async (patch: Record<string, unknown>) => {
      if (table === 'nivaro_settings') {
        Object.assign(h.settingsRow, patch)
        return 1
      }
      h.updates.push({ table, patch, whereNull })
      return 1
    }
    q.delete = async () => {
      h.deletes.push({ table, ids: inIds })
      return inIds.length
    }
    return q
  }
}))
vi.mock('../../../services/help-video-settings.js', async (orig) => ({
  ...(await orig<object>()),
  loadHelpVideoSettings: async () => ({ migrated: h.settingsColumn, stored: h.stored })
}))

import { logActivity } from '../../../services/activity.js'
import { HelpVideoSettingsError } from '../../../services/help-video-settings.js'
import {
  buildStorageReport,
  decideRemovals,
  formatBytes,
  runStorageSweep,
  type StorageVideo,
  saveRetentionDays,
  serializeRetention,
  storedRetentionDays,
  validateRetentionDays
} from '../../../services/help-video-storage.js'

const MB = 1024 * 1024
const DAY = 86_400_000
const NOW = new Date('2026-10-10T00:00:00Z')
const ago = (days: number) => new Date(NOW.getTime() - days * DAY)

beforeEach(() => {
  h.column = true
  h.settingsColumn = true
  h.stored = {}
  h.tables = {}
  h.updates = []
  h.deletes = []
  h.deletedFiles = []
  h.settingsRow = { id: 1, help_video_settings: null }
  vi.mocked(logActivity).mockClear()
})

describe('the retention setting', () => {
  it('reads null for nothing or a bad value, a whole number of days otherwise', () => {
    expect(storedRetentionDays({})).toBeNull()
    expect(storedRetentionDays({ retention_days: 'x' })).toBeNull()
    expect(storedRetentionDays({ retention_days: 0 })).toBeNull()
    expect(storedRetentionDays({ retention_days: 30 })).toBe(30)
    expect(storedRetentionDays({ retention_days: '45' })).toBe(45)
  })
  it('checks a save strictly', () => {
    expect(validateRetentionDays(null)).toBeNull()
    expect(validateRetentionDays('')).toBeNull()
    expect(validateRetentionDays('30')).toBe(30)
    for (const bad of [0, 2.5, 'abc', 99999, -1]) {
      expect(() => validateRetentionDays(bad)).toThrow(HelpVideoSettingsError)
    }
  })
  it('keeps every other key when written, and stores NULL for nothing', () => {
    expect(serializeRetention({ encoder: { crf: 20 } }, 30)).toBe(
      JSON.stringify({ encoder: { crf: 20 }, retention_days: 30 })
    )
    expect(serializeRetention({ retention_days: 30 }, null)).toBeNull()
    expect(serializeRetention({ house_style: { x: 1 }, retention_days: 30 }, null)).toBe(
      JSON.stringify({ house_style: { x: 1 } })
    )
  })
  it('refuses before migration 410, saves after it', async () => {
    h.settingsColumn = false
    await expect(saveRetentionDays(30)).rejects.toMatchObject({
      code: 'HELP_VIDEO_SETTINGS_MIGRATION_PENDING'
    })
    h.settingsColumn = true
    h.settingsRow.help_video_settings = JSON.stringify({ encoder: { crf: 20 } })
    expect(await saveRetentionDays(14)).toBe(14)
    expect(JSON.parse(String(h.settingsRow.help_video_settings))).toEqual({
      encoder: { crf: 20 },
      retention_days: 14
    })
  })
})

describe('formatBytes', () => {
  it('reads like a person would', () => {
    expect(formatBytes(null)).toBe('unknown size')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(20 * MB)).toBe('20 MB')
  })
})

// A video with a published v3 (its own recording), a draft v4 that shares
// v3's recording, an old v1 with its own recording and render, an old v2 that
// shares v1's recording, and a v0 whose files are gone already.
const VIDEO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
function rows() {
  const videos = [
    {
      id: VIDEO,
      title: 'Approve',
      status: 'published',
      poster_file: 'POSTER-LIB',
      published_version_id: 'V3',
      draft_version_id: 'V4'
    }
  ]
  const versions = [
    {
      id: 'V0',
      video_id: VIDEO,
      version: 0,
      created_at: ago(200),
      source_file: null,
      rendered_file: null,
      captions_file: null,
      poster_file: null,
      render_status: 'none',
      files_removed_at: ago(10)
    },
    {
      id: 'V1',
      video_id: VIDEO,
      version: 1,
      created_at: ago(100),
      source_file: 'SRC1',
      rendered_file: 'REN1',
      captions_file: 'CAP1',
      poster_file: 'POS1',
      render_status: 'ready',
      files_removed_at: null
    },
    {
      id: 'V2',
      video_id: VIDEO,
      version: 2,
      created_at: ago(90),
      source_file: 'SRC1',
      rendered_file: 'REN2',
      captions_file: null,
      poster_file: null,
      render_status: 'ready',
      files_removed_at: null
    },
    {
      id: 'V3',
      video_id: VIDEO,
      version: 3,
      created_at: ago(40),
      source_file: 'SRC3',
      rendered_file: 'REN3',
      captions_file: null,
      poster_file: 'POSTER-LIB',
      render_status: 'ready',
      files_removed_at: null
    },
    {
      id: 'V4',
      video_id: VIDEO,
      version: 4,
      created_at: ago(1),
      source_file: 'SRC3',
      rendered_file: null,
      captions_file: null,
      poster_file: null,
      render_status: 'none',
      files_removed_at: null
    }
  ]
  const sizes = new Map<string, number | null>([
    ['SRC1', 100 * MB],
    ['REN1', 40 * MB],
    ['CAP1', 1000],
    ['POS1', 2000],
    ['REN2', 30 * MB],
    ['SRC3', 120 * MB],
    ['REN3', 50 * MB],
    ['POSTER-LIB', 3000]
  ])
  return { videos, versions, sizes }
}

describe('buildStorageReport', () => {
  it('sizes every file once per video, per role, with totals', () => {
    const { videos, versions, sizes } = rows()
    const r = buildStorageReport(videos, versions, sizes, { migrated: true, retention_days: 30 })
    expect(r.retention_days).toBe(30)
    expect(r.videos).toHaveLength(1)
    const v = r.videos[0]
    expect(v.versions.map((x) => x.version)).toEqual([4, 3, 2, 1, 0])
    expect(v.versions[1]).toMatchObject({ is_published: true, is_draft: false })
    expect(v.versions[0]).toMatchObject({ is_draft: true })
    expect(v.versions[4].files_removed_at).not.toBeNull()
    // SRC1 and SRC3 are shared: counted once each.
    expect(v.by_role.source).toBe(220 * MB)
    expect(v.by_role.rendered).toBe(120 * MB)
    expect(v.by_role.captions).toBe(1000)
    expect(v.by_role.poster).toBe(5000)
    expect(v.bytes).toBe(340 * MB + 6000)
    expect(r.totals).toMatchObject({ bytes: v.bytes, videos: 1, versions: 5, files: 8 })
  })
})

describe('decideRemovals', () => {
  const report = () => {
    const { videos, versions, sizes } = rows()
    return buildStorageReport(videos, versions, sizes, { migrated: true, retention_days: 30 })
      .videos
  }
  it('removes nothing while retention is off', () => {
    const plan = decideRemovals(report(), { retention_days: null, now: NOW })
    expect(plan.removals).toEqual([])
    expect(plan.kept).toEqual([])
  })
  it('keeps the published cut, the draft and removed versions, removes old ones and says why', () => {
    const plan = decideRemovals(report(), { retention_days: 30, now: NOW })
    // Largest first; v1 and v2 share a recording that no staying version
    // uses, so it goes once, with the older one.
    expect(plan.removals.map((r) => r.version)).toEqual([1, 2])
    expect(plan.removals[0]).toMatchObject({
      video_id: VIDEO,
      title: 'Approve',
      version_id: 'v1',
      age_days: 100,
      bytes: 140 * MB + 3000,
      why: 'superseded 100 days ago (retention 30 days)'
    })
    expect(plan.removals[0].files.map((f) => f.role)).toEqual([
      'source',
      'rendered',
      'captions',
      'poster'
    ])
    expect(plan.removals[1]).toMatchObject({ version_id: 'v2', bytes: 30 * MB, age_days: 90 })
    expect(plan.removals[1].files.map((f) => f.id)).toEqual(['ren2'])
    expect(plan.bytes).toBe(170 * MB + 3000)
    expect(plan.files).toBe(5)
    const why = Object.fromEntries(plan.kept.map((k) => [k.version, k.why]))
    expect(why).toEqual({
      0: 'files already removed',
      3: 'the published version',
      4: 'the current draft'
    })
  })
  it('skips a version whose render is queued or running', () => {
    const vids = report()
    const v1 = vids[0].versions.find((v) => v.version === 1) as StorageVideo['versions'][number]
    v1.render_status = 'queued'
    const plan = decideRemovals(vids, { retention_days: 30, now: NOW })
    // v1 stays, so the recording v2 shares with it stays too: v2 is left whole.
    expect(plan.removals).toEqual([])
    expect(plan.kept.find((k) => k.version === 1)?.why).toBe('a render is queued or running')
    expect(plan.kept.find((k) => k.version === 2)?.why).toBe(
      'its recording is still used by a version that stays'
    )
  })
  it('never removes a file a kept version still names, even from a removable version', () => {
    const vids = report()
    // v2 keeps v1's recording alive: make v2 young so it stays, then v1 stays too.
    const v2 = vids[0].versions.find((v) => v.version === 2) as StorageVideo['versions'][number]
    v2.created_at = ago(2).toISOString()
    const plan = decideRemovals(vids, { retention_days: 30, now: NOW })
    expect(plan.removals).toEqual([])
    expect(plan.kept.find((k) => k.version === 1)?.why).toBe(
      'its recording is still used by a version that stays'
    )
  })
})

describe('runStorageSweep', () => {
  function seed(opts: { retention?: number | null } = {}) {
    const { videos, versions, sizes } = rows()
    h.tables.nivaro_help_videos = videos
    h.tables.nivaro_help_video_versions = versions
    h.tables.nivaro_files = [...sizes].map(([id, filesize]) => ({ id, filesize }))
    h.stored =
      opts.retention === undefined ? { retention_days: 30 } : { retention_days: opts.retention }
  }

  it('does nothing before migration 415 or while retention is off', async () => {
    seed()
    h.column = false
    expect((await runStorageSweep()).summary).toMatch(/migration 415/)
    h.column = true
    seed({ retention: null })
    expect((await runStorageSweep()).summary).toMatch(/retention is off/)
    expect(h.updates).toEqual([])
    expect(h.deletedFiles).toEqual([])
  })

  it('nulls the version, drops upload rows, deletes through the files service and logs each file', async () => {
    seed()
    const r = await runStorageSweep()
    expect(r).toMatchObject({ retention_days: 30, versions: 2, files: 5, failed: 0 })
    expect(r.bytes).toBe(170 * MB + 3000)
    expect(h.updates).toHaveLength(2)
    expect(h.updates[0].whereNull).toEqual(['files_removed_at'])
    expect(h.updates[0].patch).toMatchObject({
      source_file: null,
      rendered_file: null,
      captions_file: null,
      poster_file: null,
      rendered_hash: null,
      render_status: 'none'
    })
    expect(h.updates[0].patch.files_removed_at).toBeInstanceOf(Date)
    expect(h.deletes).toEqual([
      { table: 'nivaro_help_video_uploads', ids: ['src1', 'ren1', 'cap1', 'pos1'] },
      { table: 'nivaro_help_video_uploads', ids: ['ren2'] }
    ])
    expect(h.deletedFiles).toEqual(['src1', 'ren1', 'cap1', 'pos1', 'ren2'])
    const actions = vi.mocked(logActivity).mock.calls.map((c) => c[0])
    expect(actions.filter((a) => a.action === 'help-video-retention')).toHaveLength(5)
    expect(actions.find((a) => a.action === 'help-video-retention')).toMatchObject({
      collection: 'nivaro_help_videos',
      item: VIDEO,
      origin: 'machine'
    })
    expect(String(actions[0].comment)).toMatch(
      /^v1 · source \(100 MB\) removed by retention \(30 days\)$/
    )
    const summary = actions.find((a) => a.action === 'help-video-retention-sweep')
    expect(summary?.comment).toBe(r.summary)
    expect(r.summary).toBe(
      'removed 5 files (170 MB) from 2 versions of 1 videos; retention 30 days'
    )
  })

  it('names the administrator who pressed Run now, and counts a file that would not delete', async () => {
    seed()
    const versions = h.tables.nivaro_help_video_versions
    const v1 = versions.find((v) => v.id === 'V1') as Record<string, unknown>
    v1.captions_file = 'bad'
    const r = await runStorageSweep({ user: { id: 'ADMIN' } as never })
    expect(r).toMatchObject({ files: 4, failed: 1 })
    expect(r.summary).toContain('1 files could not be deleted')
    const first = vi.mocked(logActivity).mock.calls[0][0]
    expect(first).toMatchObject({ user: 'ADMIN' })
    expect(first.origin).toBeUndefined()
  })
})
