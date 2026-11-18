import { describe, expect, it, vi } from 'vitest'

vi.mock('../../db/index.js', () => ({ db: { schema: { hasColumn: vi.fn(async () => true) } } }))
vi.mock('../../db/tenant-context.js', () => ({ getTenantId: () => null }))

import { trackerBadgeOf } from './comment-badge.js'

describe('trackerBadgeOf', () => {
  it('reads the GitLab author from stored meta, never the ids', () => {
    expect(trackerBadgeOf('{"tracker":{"link":7,"note_id":91,"author":" Kim Lee "}}')).toEqual({
      provider: 'gitlab',
      author: 'Kim Lee'
    })
    expect(trackerBadgeOf({ tracker: { link: 7 } })).toEqual({ provider: 'gitlab', author: null })
  })

  it('is null for ordinary comments and junk', () => {
    expect(trackerBadgeOf(null)).toBeNull()
    expect(trackerBadgeOf('')).toBeNull()
    expect(trackerBadgeOf('not json')).toBeNull()
    expect(trackerBadgeOf('{"other":1}')).toBeNull()
    expect(trackerBadgeOf('{"tracker":[1]}')).toBeNull()
  })

  // final review X3: ticket threads and record comments answer {provider, author} only
  it('the ticket thread and the record comment list build the badge with trackerBadgeOf', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    for (const f of ['../../routes/support.ts', '../../routes/comments.ts']) {
      const src = readFileSync(join(import.meta.dirname, f), 'utf8')
      expect(src, f).toMatch(/tracker: (?:c\.deleted_at \? null : )?trackerBadgeOf\(c\.meta\)/)
      expect(src, f).not.toMatch(/note_id/)
    }
  })
})
