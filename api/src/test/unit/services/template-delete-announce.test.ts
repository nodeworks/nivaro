import { afterEach, describe, expect, it, vi } from 'vitest'
import { announceRawWrites } from '../../../services/raw-write-announcer.js'
import { announceTemplateGone } from '../../../services/state-moved.js'

// rt-fix C / L3: deleting a pipeline template takes every record's step away — one `$state`
// notice per collection, then the queue rows re-sync in the background.
vi.mock('../../../services/raw-write-announcer.js', () => ({ announceRawWrites: vi.fn() }))
const queue = vi.hoisted(() => ({ synced: [] as string[] }))
vi.mock('../../../services/queue-materialization.js', () => ({
  syncMaterializedQueueItem: async (c: string, id: string) => {
    queue.synced.push(`${c}:${id}`)
  }
}))

afterEach(() => {
  queue.synced.length = 0
  vi.clearAllMocks()
})

describe('announceTemplateGone', () => {
  it('folds the records into one $state notice per collection and re-syncs their queue rows', async () => {
    announceTemplateGone(
      [
        { collection: 'workflows', item: '1' },
        { collection: 'workflows', item: '2' },
        { collection: 'inventory_request', item: '9' }
      ],
      'tpl-1'
    )
    await vi.waitFor(() => expect(announceRawWrites).toHaveBeenCalledTimes(2))
    const calls = vi.mocked(announceRawWrites).mock.calls
    const wf = calls.find((c) => c[0] === 'workflows')
    expect(wf?.[1]).toEqual(['1', '2'])
    expect(wf?.[2]).toMatchObject({ source: 'template-delete:tpl-1', noticeOnly: true })
    expect((wf?.[2] as { changed_fields: string[] }).changed_fields).toContain('$state')
    await vi.waitFor(() => expect(queue.synced).toHaveLength(3))
  })

  it('does nothing for a template that ran on no records', () => {
    announceTemplateGone([], 'tpl-2')
    expect(announceRawWrites).not.toHaveBeenCalled()
  })
})
