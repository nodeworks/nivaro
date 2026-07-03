import { describe, expect, it, vi } from 'vitest'
import { chunkArray, selectInChunks } from '../../../services/db-batch.js'

describe('chunkArray', () => {
  it('splits an array into chunks of the given size', () => {
    expect(chunkArray([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
  })

  it('returns a single chunk when items fit under the size', () => {
    expect(chunkArray([1, 2], 10)).toEqual([[1, 2]])
  })

  it('returns an empty array for empty input', () => {
    expect(chunkArray([], 5)).toEqual([])
  })

  it('throws for a non-positive chunk size', () => {
    expect(() => chunkArray([1], 0)).toThrow()
  })
})

describe('selectInChunks', () => {
  it('returns an empty array without calling queryFn when ids is empty', async () => {
    const queryFn = vi.fn()
    const result = await selectInChunks([], 2, queryFn)
    expect(result).toEqual([])
    expect(queryFn).not.toHaveBeenCalled()
  })

  it('calls queryFn once per chunk and merges the results in order', async () => {
    const queryFn = vi.fn(async (chunk: number[]) => chunk.map((n) => ({ id: n })))
    const result = await selectInChunks([1, 2, 3, 4, 5], 2, queryFn)
    expect(queryFn).toHaveBeenCalledTimes(3)
    expect(queryFn).toHaveBeenNthCalledWith(1, [1, 2])
    expect(queryFn).toHaveBeenNthCalledWith(2, [3, 4])
    expect(queryFn).toHaveBeenNthCalledWith(3, [5])
    expect(result).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }])
  })

  it('does not chunk when all ids fit in a single chunk', async () => {
    const queryFn = vi.fn(async (chunk: number[]) => chunk)
    await selectInChunks([1, 2], 2000, queryFn)
    expect(queryFn).toHaveBeenCalledTimes(1)
  })
})
