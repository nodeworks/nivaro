import { describe, expect, it, vi } from 'vitest'

// rt-fix C (admin #9): the console's one live hook also refreshes the partner drill-down and
// the ERP tab (they used to wait for a reload).
const seen = vi.hoisted(() => ({ opts: null as null | { topic: string; keys: unknown[][] } }))
vi.mock('../../../lib/live-counts', () => ({
  useLiveRefresh: (o: { topic: string; keys: unknown[][] }) => {
    seen.opts = o
  },
  useLiveRefetchInterval: () => false
}))

import { useLiveIntegrations } from './api'

describe('useLiveIntegrations', () => {
  it('re-reads the partner drill-down and the ERP tab on an integrations poke', () => {
    useLiveIntegrations()
    expect(seen.opts?.topic).toBe('integrations')
    const heads = seen.opts?.keys.map((k) => k[0])
    for (const h of ['integration-partner', 'erp-submissions', 'erp-submissions-search'])
      expect(heads).toContain(h)
  })
})
