import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn(() => ({ first: async () => undefined })) }))

import { normalizeTarget, resolveTargetUrl } from '../../../services/notification-target.js'

describe('a bulk-change notice opens the collection list on exactly those records', () => {
  it('a collection target carries its query', async () => {
    const spec = normalizeTarget({
      kind: 'record',
      collection: 'workflows',
      query: 'ids=1,2,3',
      action: 'open'
    })
    expect(spec?.query).toBe('ids=1,2,3')
    const url = await resolveTargetUrl(spec, { app: 'admin' })
    expect(url).toMatch(/\/collections\/workflows\?ids=1,2,3$/)
  })

  it('without a query it is still the plain list', async () => {
    const url = await resolveTargetUrl(
      normalizeTarget({ kind: 'record', collection: 'workflows', query: null }),
      { app: 'admin' }
    )
    expect(url).toMatch(/\/collections\/workflows$/)
  })
})
