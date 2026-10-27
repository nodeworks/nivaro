import { describe, expect, it, vi } from 'vitest'

// Security audit 2026-10-27: a channel's pinned links take http(s) or an
// in-app path with ONE leading slash; `//host` is another site.

vi.mock('../../../config.js', () => ({ config: { PUBLIC_URL: 'https://n.test' } }))
vi.mock('../../../db/index.js', () => ({ db: Object.assign(() => ({}), { raw: () => '' }) }))

import { cleanChannelLinks } from '../../../services/chat.js'

describe('cleanChannelLinks', () => {
  it('keeps http(s) links and in-app paths', () => {
    expect(
      cleanChannelLinks([
        { label: 'Docs', url: 'https://example.com/docs' },
        { label: 'Queue', url: '/queues/3?tab=mine' }
      ])
    ).toEqual([
      { label: 'Docs', url: 'https://example.com/docs' },
      { label: 'Queue', url: '/queues/3?tab=mine' }
    ])
  })

  it('refuses scheme-relative and script links', () => {
    for (const url of ['//evil.example', '//evil.example/path', 'javascript:alert(1)', '/\\evil'])
      expect(cleanChannelLinks([{ label: 'x', url }]), url).toBeNull()
  })
})
