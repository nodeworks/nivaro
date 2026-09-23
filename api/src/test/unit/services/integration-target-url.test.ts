import { describe, expect, it, vi } from 'vitest'

// app-links reads settings for a portal registration; with none, every kind
// falls back to its admin route, which is what this file is about.
vi.mock('../../../db/index.js', () => ({ db: vi.fn(() => ({ first: async () => undefined })) }))

import { resolveTargetUrl } from '../../../services/notification-target.js'

describe('an integration obligation notification points somewhere that opens', () => {
  it('opens the record when the obligation is about a real one', async () => {
    const url = await resolveTargetUrl(
      { kind: 'integration', collection: 'workflows', id: '371396', action: 'review' },
      { app: 'admin' }
    )
    expect(url).toMatch(/\/collections\/workflows\/371396$/)
  })

  it('opens the board when the "record" is a bucket key in a nivaro_ table', async () => {
    // linx.inbound's shape: the API log is not a registered collection and
    // the item is `/graphql@2026-09-23T14`, so a record URL cannot resolve.
    const url = await resolveTargetUrl(
      {
        kind: 'integration',
        collection: 'nivaro_api_logs',
        id: '/graphql@2026-09-23T14',
        action: 'review'
      },
      { app: 'admin' }
    )
    expect(url).toMatch(/\/integration-health$/)
  })

  it('opens the board when the target names no record at all', async () => {
    const url = await resolveTargetUrl({ kind: 'integration', action: 'review' }, { app: 'admin' })
    expect(url).toMatch(/\/integration-health$/)
  })
})
