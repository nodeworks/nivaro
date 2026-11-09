import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import { activityPredicate } from '../../../services/activity-sentence.js'
import {
  downloadApp,
  downloadKind,
  downloadReportCsv,
  parseDownloadComment,
  peopleOf
} from '../../../services/file-downloads.js'

const req = (headers: Record<string, string> = {}, query: Record<string, string> = {}) =>
  ({ headers, query }) as never

describe('downloadKind', () => {
  it('counts a download and a top-level open', () => {
    expect(downloadKind(req({}, { download: '1' }))).toBe('download')
    expect(downloadKind(req({ 'sec-fetch-dest': 'document' }))).toBe('open')
    expect(downloadKind(req())).toBe('open')
  })

  it('skips files a page embeds', () => {
    expect(downloadKind(req({ 'sec-fetch-dest': 'image' }))).toBeNull()
    expect(downloadKind(req({ 'sec-fetch-dest': 'style' }))).toBeNull()
  })

  it('counts the first piece of a streamed file only', () => {
    expect(downloadKind(req({ range: 'bytes=0-' }))).toBe('open')
    expect(downloadKind(req({ range: 'bytes=65536-131071' }))).toBeNull()
  })
})

describe('downloadApp', () => {
  it('prefers the app header', () => {
    expect(downloadApp(req({ 'x-nivaro-app': 'Admin' }), 'https://admin.example.com')).toBe('admin')
  })

  it('reads the referring page: admin, another front end by host, or direct', () => {
    const admin = 'https://admin.example.com'
    expect(downloadApp(req({ referer: 'https://admin.example.com/x' }), admin)).toBe('admin')
    expect(downloadApp(req({ referer: 'https://app.example.com/r/1' }), admin)).toBe(
      'app.example.com'
    )
    expect(downloadApp(req(), admin)).toBe('direct')
    expect(downloadApp(req({ referer: 'not a url' }), admin)).toBe('direct')
  })
})

describe('parseDownloadComment', () => {
  it('reads the stored JSON and refuses anything else', () => {
    expect(
      parseDownloadComment('{"file":"F1","name":"a.pdf","app":"admin","kind":"open"}')
    ).toEqual({ file: 'F1', name: 'a.pdf', app: 'admin', kind: 'open' })
    expect(parseDownloadComment('plain text')).toBeNull()
    expect(parseDownloadComment('{"name":"no id"}')).toBeNull()
    expect(parseDownloadComment(null)).toBeNull()
  })
})

describe('peopleOf', () => {
  it('folds rows per person, newest first', () => {
    const row = (user: string, at: string) =>
      ({ user, at, file: 'F', name: null, app: 'admin', kind: 'download' }) as never
    const names = new Map([
      ['U1', 'Pat Lee'],
      ['U2', 'Sam Ortiz']
    ])
    const out = peopleOf(
      [
        row('u1', '2026-11-01T00:00:00Z'),
        row('u2', '2026-11-03T00:00:00Z'),
        row('U1', '2026-11-02T00:00:00Z')
      ],
      names
    )
    expect(out.map((p) => [p.name, p.count, p.last])).toEqual([
      ['Sam Ortiz', 1, '2026-11-03T00:00:00Z'],
      ['Pat Lee', 2, '2026-11-02T00:00:00Z']
    ])
  })
})

describe('downloadReportCsv', () => {
  it('writes one line per download and neutralises formula cells', () => {
    const csv = downloadReportCsv({
      rows: [
        {
          activity_id: 1,
          user: 'U1',
          person: 'Pat Lee',
          at: '2026-11-08T12:00:00.000Z',
          collection: 'workflows',
          item: '7',
          file: 'F1',
          name: '=cmd.xlsx',
          app: 'admin',
          kind: 'download'
        }
      ],
      by_file: [],
      by_person: [],
      by_record: [],
      truncated: false
    })
    const lines = csv.trim().split('\r\n')
    expect(lines).toHaveLength(2)
    expect(lines[1]).toBe(
      "2026-11-08T12:00:00.000Z,Pat Lee,'=cmd.xlsx,F1,workflows,7,admin,download"
    )
  })
})

describe('activity sentence', () => {
  it('reads a download on a record and an open of a file on no record', () => {
    expect(
      activityPredicate({
        action: 'file-download',
        collection: 'workflows',
        item: '7',
        comment: '{"file":"F1","name":"quote.pdf","app":"admin","kind":"download"}'
      } as never)
    ).toMatch(/^downloaded “quote\.pdf” on /)
    expect(
      activityPredicate({
        action: 'file-download',
        collection: 'nivaro_files',
        item: 'F1',
        comment: '{"file":"F1","name":"a.txt","app":"admin","kind":"open"}'
      } as never)
    ).toBe('opened “a.txt”')
  })
})
