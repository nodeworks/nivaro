import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

const { db } = await import('../../../db/index.js')
const { cleanComment, previewLinkByToken, renderFormPreviewHtml } = await import(
  '../../../services/layout-preview.js'
)

describe('previewLinkByToken', () => {
  const token = 'a'.repeat(48)
  const withRow = (row: Record<string, unknown>) =>
    vi.mocked(db).mockImplementation((() => ({
      where: () => ({ first: () => Promise.resolve(row) })
    })) as never)
  const base = {
    id: 'l1',
    token,
    item: '__form_preview__',
    layout_id: 5,
    collection: 'orders',
    is_active: 1,
    created_by: 'c1'
  }
  it('accepts an active link whose expiry is ahead', async () => {
    withRow({ ...base, expires_at: '2099-01-01T00:00:00Z' })
    expect(await previewLinkByToken(token)).toMatchObject({ id: 'l1', layout_id: 5 })
  })
  it('refuses a link without an expiry, an expired one and a revoked one', async () => {
    withRow({ ...base, expires_at: null })
    expect(await previewLinkByToken(token)).toBeNull()
    withRow({ ...base, expires_at: '2001-01-01T00:00:00Z' })
    expect(await previewLinkByToken(token)).toBeNull()
    withRow({ ...base, expires_at: 'not a date' })
    expect(await previewLinkByToken(token)).toBeNull()
    withRow({ ...base, expires_at: '2099-01-01T00:00:00Z', is_active: 0 })
    expect(await previewLinkByToken(token)).toBeNull()
  })
})

describe('cleanComment', () => {
  const paths = ['title', 'due']
  it('accepts a field on the form or the whole form', () => {
    expect(cleanComment({ field: 'due', name: ' Bo ', text: ' Too early ' }, paths)).toEqual({
      field: 'due',
      name: 'Bo',
      text: 'Too early'
    })
    expect(cleanComment({ field: '', name: 'Bo', text: 'ok' }, paths)).toMatchObject({
      field: null
    })
  })
  it('refuses empty text, missing names, long input and fields not on the form', () => {
    expect(cleanComment({ name: 'Bo', text: '' }, paths)).toHaveProperty('error')
    expect(cleanComment({ text: 'hi' }, paths)).toHaveProperty('error')
    expect(cleanComment({ name: 'Bo', text: 'x'.repeat(2001) }, paths)).toHaveProperty('error')
    expect(cleanComment({ name: 'x'.repeat(81), text: 'hi' }, paths)).toHaveProperty('error')
    expect(cleanComment({ field: 'salary', name: 'Bo', text: 'hi' }, paths)).toHaveProperty('error')
  })
})

describe('renderFormPreviewHtml', () => {
  it('renders sections, fields and comments with everything escaped', () => {
    const html = renderFormPreviewHtml({
      title: 'Orders',
      layoutName: '<b>PO</b>',
      structure: {
        tab_mode: 'tabs',
        field_paths: ['title', 'kind'],
        sections: [
          {
            label: 'Main',
            fields: [
              {
                path: 'title',
                label: 'Title',
                db_type: 'string',
                required: true,
                placeholder: null,
                choices: null,
                visibility: null
              },
              {
                path: 'kind',
                label: 'Kind',
                db_type: 'string',
                required: false,
                placeholder: null,
                choices: [{ value: 'a', text: 'Alpha' }],
                visibility: null
              }
            ]
          }
        ]
      },
      comments: [
        {
          id: 'ab',
          layout_id: 1,
          link_id: 'l',
          field: 'title',
          name: '<img src=x onerror=alert(1)>',
          text: 'Rename "this"',
          at: '2026-10-20T10:00:00Z'
        }
      ],
      token: 'abc123',
      expiresAt: '2026-11-01T00:00:00Z',
      nonce: 'n0nce'
    })
    expect(html).toContain('<script nonce="n0nce">')
    expect(html).toContain('&lt;b&gt;PO&lt;/b&gt;')
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('Rename &quot;this&quot;')
    expect(html).toContain('One of: Alpha')
    expect(html).toContain('data-field="title"')
    expect(html).toContain('<h2>Main</h2>')
  })
})
