import { beforeEach, describe, expect, it, vi } from 'vitest'

// One users row, no activity rows: suspensionReason falls back to what the columns say.
let userRow: Record<string, unknown> | undefined
vi.mock('../db/index.js', () => {
  const chain = (table: string) => {
    const b: Record<string, unknown> = {}
    for (const m of ['where', 'leftJoin', 'whereIn', 'orderBy', 'limit']) b[m] = () => b
    b.first = async () => (table === 'nivaro_users' ? userRow : undefined)
    b.select = async () => []
    return b
  }
  return { db: (table: string) => chain(table) }
})

import { suspensionReason } from './account-status.js'

describe('suspensionReason fallbacks (no activity row)', () => {
  beforeEach(() => {
    userRow = undefined
  })

  it('a legacy-anonymised account is a legacy redaction, not "not found in the directory"', async () => {
    userRow = {
      id: 'A',
      status: 'suspended',
      is_redacted: false,
      redacted_at: null,
      directory_status: 'missing',
      first_name: 'Redacted',
      email: 'Redacted_A@redact.example.com'
    }
    const r = await suspensionReason('A')
    expect(r?.source).toBe('legacy-redaction')
    expect(r?.at).toBeNull()
  })

  it('a directory verdict carries no date: the last directory CHECK is not when they were suspended', async () => {
    userRow = {
      id: 'B',
      status: 'suspended',
      is_redacted: false,
      redacted_at: null,
      directory_status: 'disabled',
      first_name: 'Joe',
      email: 'joe@example.com'
    }
    const r = await suspensionReason('B')
    expect(r?.source).toBe('directory')
    expect(r?.at).toBeNull()
  })

  it('a redacted account keeps its real redaction date', async () => {
    const when = new Date('2026-10-01T12:00:00Z')
    userRow = {
      id: 'C',
      status: 'suspended',
      is_redacted: true,
      redacted_at: when,
      directory_status: null,
      first_name: 'Redacted',
      email: 'Redacted_C@redact.example.com'
    }
    const r = await suspensionReason('C')
    expect(r?.source).toBe('retention')
    expect(r?.at).toBe(when.toISOString())
  })
})
