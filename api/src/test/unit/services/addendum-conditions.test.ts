import { describe, expect, it, vi } from 'vitest'

// An addendum's transition rules read its parent record. Before it is approved
// the parent still holds the OLD figures, so "PO amount = requisition amount"
// matched the original PO the moment an addendum reached Waiting on PO and the
// addendum completed at once (TP26-79847, 2026-11-11). The rules must see the
// parent as the addendum proposes it.

const parent = { id: 371403, project: 7895, requisition_amount: 2595 }

vi.mock('../../../db/index.js', () => ({
  db: Object.assign(
    vi.fn(() => ({
      where: () => ({ first: async () => ({ ...parent }) })
    })),
    { raw: () => '' }
  )
}))

vi.mock('../../../services/pipeline-subject.js', () => ({
  ADDENDUM_COLLECTION: 'nivaro_addendums',
  resolvePipelineSubject: async (collection: string, itemId: string) =>
    collection === 'nivaro_addendums'
      ? { collection: 'workflows', itemId: '371403' }
      : { collection, itemId }
}))

const overlay = vi.fn(async (_c: string, item: Record<string, unknown>, _id: string) => ({
  item: { ...item, requisition_amount: 0 },
  childRowsOverride: {},
  title: 'Requested wrong vendor'
}))
vi.mock('../../../services/addendum-render.js', () => ({
  buildAddendumRenderOverlay: overlay
}))

const applyKeys = new Set(['workflow_lines'])
vi.mock('../../../services/addendum-approve.js', () => ({
  addendumApplyKeys: async () => applyKeys
}))

import { fetchRecordForConditions } from '../../../services/workflow-conditions.js'

describe('fetchRecordForConditions — addendums', () => {
  it("reads the parent with the addendum's proposed figures", async () => {
    const rec = await fetchRecordForConditions('nivaro_addendums', 'A2EDFAAF')
    expect(rec.requisition_amount).toBe(0)
    expect(rec.project).toBe(7895)
    // Only the keys approval would apply are overlaid (data is author-writable).
    expect(overlay).toHaveBeenCalledWith(
      'workflows',
      expect.objectContaining({ id: 371403 }),
      'A2EDFAAF',
      applyKeys
    )
  })

  it('never lets the overlay change the record id', async () => {
    overlay.mockResolvedValueOnce({
      item: { ...parent, id: 1, requisition_amount: 0 },
      childRowsOverride: {},
      title: null
    } as never)
    const rec = await fetchRecordForConditions('nivaro_addendums', 'A2EDFAAF')
    expect(rec.id).toBe(371403)
  })

  it('keeps the stored parent when the overlay has nothing to say', async () => {
    overlay.mockResolvedValueOnce(null as never)
    const rec = await fetchRecordForConditions('nivaro_addendums', 'A2EDFAAF')
    expect(rec.requisition_amount).toBe(2595)
  })

  it('never overlays a plain record', async () => {
    overlay.mockClear()
    const rec = await fetchRecordForConditions('workflows', '371403')
    expect(rec.requisition_amount).toBe(2595)
    expect(overlay).not.toHaveBeenCalled()
  })
})
