import { afterEach, describe, expect, it, vi } from 'vitest'

// db is already mocked via setup.ts — import it so we can spy on it
import { db } from '../../../db/index.js'
import { logActivity } from '../../../services/activity.js'

describe('logActivity', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('calls db insert with the correct fields', async () => {
    // Arrange — make the table stub return a row with an id
    const insertStub = vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([{ id: 42 }]),
    })
    vi.mocked(db as unknown as (t: string) => unknown).mockReturnValue({
      insert: insertStub,
    } as unknown as ReturnType<typeof db>)

    // Act
    const id = await logActivity({ action: 'create', user: 'user-1', collection: 'articles', item: '99' })

    // Assert
    expect(id).toBe(42)
    expect(insertStub).toHaveBeenCalledOnce()
    const payload = insertStub.mock.calls[0][0] as Record<string, unknown>
    expect(payload.action).toBe('create')
    expect(payload.user).toBe('user-1')
    expect(payload.collection).toBe('articles')
    expect(payload.item).toBe('99')
    expect(payload.timestamp).toBeInstanceOf(Date)
  })

  it('returns null when user is not provided', async () => {
    const insertStub = vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([{ id: 1 }]),
    })
    vi.mocked(db as unknown as (t: string) => unknown).mockReturnValue({
      insert: insertStub,
    } as unknown as ReturnType<typeof db>)

    const id = await logActivity({ action: 'delete', user: null })

    expect(id).toBe(1)
    const payload = insertStub.mock.calls[0][0] as Record<string, unknown>
    expect(payload.user).toBeNull()
    expect(payload.collection).toBeNull()
    expect(payload.item).toBeNull()
  })

  it('returns null and does not throw when the DB insert fails', async () => {
    vi.mocked(db as unknown as (t: string) => unknown).mockReturnValue({
      insert: vi.fn().mockReturnValue({
        returning: vi.fn().mockRejectedValue(new Error('DB connection lost')),
      }),
    } as unknown as ReturnType<typeof db>)

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const id = await logActivity({ action: 'update', user: 'user-1' })

    expect(id).toBeNull()
    expect(consoleSpy).toHaveBeenCalledOnce()
    consoleSpy.mockRestore()
  })

  it('includes ip and user_agent from req when provided', async () => {
    const insertStub = vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([{ id: 5 }]),
    })
    vi.mocked(db as unknown as (t: string) => unknown).mockReturnValue({
      insert: insertStub,
    } as unknown as ReturnType<typeof db>)

    const fakeReq = {
      ip: '127.0.0.1',
      headers: { 'user-agent': 'TestAgent/1.0' },
    }

    await logActivity({
      action: 'read',
      user: 'user-2',
      req: fakeReq as Parameters<typeof logActivity>[0]['req'],
    })

    const payload = insertStub.mock.calls[0][0] as Record<string, unknown>
    expect(payload.ip).toBe('127.0.0.1')
    expect(payload.user_agent).toBe('TestAgent/1.0')
  })
})
