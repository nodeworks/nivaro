import { describe, expect, it } from 'vitest'
import { type FileUsageSources, foldFileUses } from '../../../services/file-usage.js'

const RECORD = { collection: 'orders', item: '42' }
const FILE_A = '0A1B2C3D-0000-4000-8000-0000000000AA'
const FILE_B = '0a1b2c3d-0000-4000-8000-0000000000bb'
const FILE_C = '0a1b2c3d-0000-4000-8000-0000000000cc'

function sources(over: Partial<FileUsageSources> = {}): FileUsageSources {
  return {
    files: [
      {
        id: FILE_A,
        filename_download: 'quote-final.pdf',
        generated_by_layout: 7,
        uploaded_on: '2026-09-01T10:00:00.000Z',
        layout_name: 'Quote PDF'
      },
      {
        id: FILE_B,
        filename_download: 'photo.jpg',
        generated_by_layout: null,
        uploaded_on: '2026-09-02T10:00:00.000Z',
        layout_name: null
      },
      {
        id: FILE_C,
        filename_download: 'unused.txt',
        generated_by_layout: null,
        uploaded_on: null,
        layout_name: null
      }
    ],
    addendums: [
      {
        id: 'ADD-1',
        title: 'Scope change',
        status: 'approved',
        attachments: JSON.stringify([FILE_A.toLowerCase()]),
        created_at: '2026-09-03T10:00:00.000Z'
      },
      {
        id: 'ADD-2',
        title: 'Broken',
        status: 'draft',
        attachments: '{not json',
        created_at: '2026-09-03T11:00:00.000Z'
      }
    ],
    submissions: [
      {
        id: 1,
        api_name: 'Partner API',
        payload: JSON.stringify({
          endpoint_path: '/api/orders',
          body: { attachmentName: 'photo.jpg', attachmentContent: '<base64 omitted — 1 bytes>' }
        }),
        status: 'accepted',
        created_at: '2026-09-04T10:00:00.000Z'
      },
      {
        id: 2,
        api_name: null,
        payload: JSON.stringify({ endpoint_path: '/api/docs', body: { file: FILE_A } }),
        status: 'failed',
        created_at: '2026-09-05T10:00:00.000Z'
      }
    ],
    mails: [
      {
        id: 10,
        to: 'a@example.com, b@example.com',
        subject: 'Your quote',
        body: `<a href="/api/files/${FILE_A}?download=1">quote-final.pdf</a>`,
        status: 'sent',
        created_at: '2026-09-06T10:00:00.000Z'
      },
      {
        id: 11,
        to: 'c@example.com',
        subject: 'Site photo',
        body: '<p>Attached: photo.jpg</p>',
        status: 'sent',
        created_at: '2026-09-07T10:00:00.000Z'
      }
    ],
    ...over
  }
}

describe('foldFileUses', () => {
  it('answers every requested id, an empty list when nothing carried the file', () => {
    const out = foldFileUses([FILE_A, FILE_B, FILE_C], sources(), RECORD)
    expect(Object.keys(out).sort()).toEqual([FILE_A, FILE_B, FILE_C].sort())
    expect(out[FILE_C]).toEqual([])
  })

  it('folds the four sources for a file matched by its uuid, newest first', () => {
    const out = foldFileUses([FILE_A], sources(), RECORD)
    const kinds = out[FILE_A].map((u) => u.kind)
    expect(kinds).toEqual(['email', 'push', 'addendum', 'generated'])
    expect(out[FILE_A].every((u) => u.match === 'id')).toBe(true)

    const [email, push, addendum, generated] = out[FILE_A]
    expect(email.label).toBe('Emailed to 2 recipients — Your quote')
    expect(email.href).toBe('/mail-log?id=10')
    expect(push.label).toBe('Sent to an external API — /api/docs')
    expect(push.href).toBe('/erp-submissions?collection=orders&item=42')
    expect(push.detail).toBe('failed')
    expect(addendum.label).toBe('Addendum "Scope change" (approved)')
    expect(addendum.addendum_id).toBe('ADD-1')
    expect(generated.label).toBe('Generated from layout "Quote PDF"')
    expect(generated.at).toBe('2026-09-01T10:00:00.000Z')
  })

  it('matches a push payload and an email body by download name, marked by name', () => {
    const out = foldFileUses([FILE_B], sources(), RECORD)
    expect(out[FILE_B].map((u) => [u.kind, u.match])).toEqual([
      ['email', 'name'],
      ['push', 'name']
    ])
    expect(out[FILE_B][0].label).toBe('Emailed to 1 recipient — Site photo')
    expect(out[FILE_B][1].label).toBe('Sent to Partner API — /api/orders')
  })

  it('ignores an addendum whose attachments JSON does not parse', () => {
    const out = foldFileUses([FILE_A], sources(), RECORD)
    expect(out[FILE_A].filter((u) => u.kind === 'addendum')).toHaveLength(1)
  })

  it('compares uuids case-insensitively', () => {
    const out = foldFileUses([FILE_A.toLowerCase()], sources(), RECORD)
    expect(out[FILE_A.toLowerCase()].some((u) => u.kind === 'addendum')).toBe(true)
    expect(out[FILE_A.toLowerCase()].some((u) => u.kind === 'generated')).toBe(true)
  })

  it('falls back to the layout number when the layout row is gone', () => {
    const src = sources()
    src.files[0].layout_name = null
    const out = foldFileUses([FILE_A], src, RECORD)
    expect(out[FILE_A].find((u) => u.kind === 'generated')?.label).toBe(
      'Generated from layout "#7"'
    )
  })

  it('never matches an empty name against every body', () => {
    const src = sources()
    src.files[1].filename_download = null
    const out = foldFileUses([FILE_B], src, RECORD)
    expect(out[FILE_B]).toEqual([])
  })
})
