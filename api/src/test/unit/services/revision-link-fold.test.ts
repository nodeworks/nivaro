import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/collections.js', () => ({ getRelations: vi.fn() }))

import {
  type FoldSave,
  foldLinkHistory,
  type LinkOp,
  ownerSave
} from '../../../services/revision-link-fold.js'

const T = Date.parse('2026-11-18T23:30:22.336Z')
const TIM = 'TIM'

describe('revision link fold', () => {
  it('puts a link write on the save it came with (same person, just before)', () => {
    const saves: FoldSave[] = [
      { index: 0, at: T + 60_000, user: TIM, stored: null },
      { index: 1, at: T, user: TIM, stored: null }
    ]
    expect(ownerSave({ at: T - 53, user: TIM, op: 'add', id: '124' }, saves)?.index).toBe(1)
    // Someone else's link write is not Tim's save.
    expect(ownerSave({ at: T - 53, user: 'NICK', op: 'add', id: '124' }, saves)).toBeNull()
    // Too long before any save.
    expect(ownerSave({ at: T - 40_000, user: TIM, op: 'add', id: '124' }, saves)).toBeNull()
  })

  it('a link-only save reads as a change with the links it left', () => {
    // Newest first: a later save that touched nothing, Tim's Divisions save, an older one.
    const saves: FoldSave[] = [
      { index: 0, at: T + 60_000, user: 'NICK', stored: null },
      { index: 1, at: T, user: TIM, stored: null },
      { index: 2, at: T - 86_400_000, user: TIM, stored: null }
    ]
    const ops: LinkOp[] = [
      { at: T - 53, user: TIM, op: 'add', id: '124' },
      { at: T - 13, user: TIM, op: 'add', id: '125' }
    ]
    const out = foldLinkHistory(saves, ops, ['7', '124', '125'])
    expect(out.get(0)).toMatchObject({ ids: ['124', '125', '7'], changed: false })
    expect(out.get(1)).toMatchObject({
      ids: ['124', '125', '7'],
      changed: true,
      added: ['124', '125'],
      removed: []
    })
    expect(out.get(2)).toMatchObject({ ids: ['7'], changed: false })
  })

  it('a removal brings the link back on older saves; add+remove in one save is no change', () => {
    const saves: FoldSave[] = [
      { index: 0, at: T, user: TIM, stored: null },
      { index: 1, at: T - 3_600_000, user: TIM, stored: null }
    ]
    const ops: LinkOp[] = [
      { at: T - 900, user: TIM, op: 'remove', id: '9' },
      { at: T - 800, user: TIM, op: 'add', id: '10' },
      { at: T - 700, user: TIM, op: 'remove', id: '10' }
    ]
    const out = foldLinkHistory(saves, ops, ['7'])
    expect(out.get(0)).toMatchObject({ ids: ['7'], changed: true, removed: ['9'], added: [] })
    expect(out.get(1)?.ids).toEqual(['7', '9'])
  })

  it('a snapshot that stored the field is trusted and not rewritten', () => {
    const saves: FoldSave[] = [
      { index: 0, at: T, user: TIM, stored: null },
      { index: 1, at: T - 3_600_000, user: TIM, stored: ['3'] },
      { index: 2, at: T - 7_200_000, user: TIM, stored: null }
    ]
    const out = foldLinkHistory(saves, [], ['3', '4'])
    expect(out.has(1)).toBe(false)
    expect(out.get(0)?.ids).toEqual(['3', '4'])
    // The walk restarts from what save 1 stored.
    expect(out.get(2)?.ids).toEqual(['3'])
  })
})
