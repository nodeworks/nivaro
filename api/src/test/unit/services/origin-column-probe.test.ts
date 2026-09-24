import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The migration-340 `origin` column probes (activity + workflow history) are
 * kept per tenant: in cloud mode one tenant may be migrated while another is
 * not, and naming the column on the un-migrated one fails the whole insert.
 */
const tenant: { id: string | undefined } = { id: undefined }
vi.mock('../../../db/tenant-context.js', () => ({ getTenantId: () => tenant.id }))

const hasColumn = vi.fn()
const inserted: Array<Record<string, unknown>> = []
vi.mock('../../../db/index.js', () => {
  const db = Object.assign(
    () => ({
      insert: (row: Record<string, unknown>) => {
        inserted.push(row)
        return { returning: async () => [{ id: 1 }] }
      }
    }),
    { schema: { hasColumn: (...a: unknown[]) => hasColumn(...a) } }
  )
  return { db }
})

import { logActivity } from '../../../services/activity.js'
import { originFields } from '../../../services/note-authorship.js'

beforeEach(() => {
  hasColumn.mockReset()
  inserted.length = 0
})

describe('originFields (workflow history)', () => {
  it('probes each tenant separately', async () => {
    tenant.id = 'h-a'
    hasColumn.mockResolvedValue(true)
    expect(await originFields('nivaro_workflow_history', 'machine')).toEqual({ origin: 'machine' })
    tenant.id = 'h-b'
    hasColumn.mockResolvedValue(false)
    expect(await originFields('nivaro_workflow_history', 'machine')).toEqual({})
    tenant.id = 'h-a'
    expect(await originFields('nivaro_workflow_history', 'machine')).toEqual({ origin: 'machine' })
    expect(hasColumn).toHaveBeenCalledTimes(2)
  })
})

describe('logActivity origin column', () => {
  it('probes each tenant separately', async () => {
    tenant.id = 'a-a'
    hasColumn.mockResolvedValue(true)
    await logActivity({ action: 'x', user: null, origin: 'machine' })
    tenant.id = 'a-b'
    hasColumn.mockResolvedValue(false)
    await logActivity({ action: 'x', user: null, origin: 'machine' })
    expect(inserted[0].origin).toBe('machine')
    expect('origin' in inserted[1]).toBe(false)
    expect(hasColumn).toHaveBeenCalledTimes(2)
  })
})
