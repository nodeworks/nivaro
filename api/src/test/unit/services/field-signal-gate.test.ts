import { describe, expect, it, vi } from 'vitest'
import { cleanSignalField, fieldSignalSockets } from '../../../services/field-signal-gate.js'

describe('cleanSignalField', () => {
  it('keeps plain field names only', () => {
    expect(cleanSignalField('amount')).toBe('amount')
    expect(cleanSignalField('po_number_2')).toBe('po_number_2')
    expect(cleanSignalField('a.b')).toBeNull()
    expect(cleanSignalField('1x')).toBeNull()
    expect(cleanSignalField('')).toBeNull()
    expect(cleanSignalField(42)).toBeNull()
    expect(cleanSignalField('x'.repeat(65))).toBeNull()
  })
})

describe('fieldSignalSockets — who hears "Beth is replying" on a field thread', () => {
  const viewers = [
    { socket: 's-beth', id: 'beth' },
    { socket: 's-kim-1', id: 'KIM' },
    { socket: 's-kim-2', id: 'kim' },
    { socket: 's-lee', id: 'lee' },
    { socket: 's-lee', id: 'lee' }
  ]

  it('reaches only the people who may read the field, never the sender', async () => {
    const mayRead = vi.fn(async (id: string) => id.toLowerCase() !== 'lee')
    const out = await fieldSignalSockets(viewers, 's-beth', mayRead)
    expect(out).toEqual(['s-kim-1', 's-kim-2'])
  })

  it('asks once per person, whatever the number of their tabs', async () => {
    const mayRead = vi.fn(async () => true)
    await fieldSignalSockets(viewers, 's-beth', mayRead)
    expect(mayRead).toHaveBeenCalledTimes(2)
  })

  it('a person whose access cannot be judged hears nothing', async () => {
    const out = await fieldSignalSockets(viewers, 's-beth', async (id) => {
      if (id === 'lee') throw new Error('db down')
      return false
    })
    expect(out).toEqual([])
  })
})
