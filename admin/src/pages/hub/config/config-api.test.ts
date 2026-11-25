import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() }
}))

const { CONFIG_COPY_KEYS, configError, refusalItems, shownValue, tableWords } = await import(
  './config-api'
)

const refusal = (code: string, message: string) => ({
  isAxiosError: true,
  response: { status: 409, data: { code, message, error: message } }
})

describe('config promotion copy', () => {
  it('words every refusal the apply and undo answer', () => {
    for (const c of [
      'STALE',
      'PLAN_CHANGED',
      'PLAN_EXPIRED',
      'CONFIRM_REQUIRED',
      'PROD_ONLY_CHANGES',
      'FROZEN',
      'MOVE_OPEN',
      'CONFIG_PROMOTION_RUNNING',
      'LINK_MISSING',
      'NOT_SUPPORTED_ON_DATABASE',
      'NOT_UNDOABLE',
      'ROW_UNMATCHED',
      'REF_UNMAPPED',
      'NOT_NEWEST',
      'INTERRUPTED',
      'UNDO_ADMIN_SESSION_ONLY',
      'CHECKLIST_REQUIRED',
      'OUTSIDE_WINDOW'
    ])
      expect(CONFIG_COPY_KEYS.has(c), c).toBe(true)
  })

  it('a freeze keeps the server’s sentence (it names the window); raw text never shows', () => {
    const d = configError(
      refusal(
        'FROZEN',
        'Promotions are frozen for this app until 2026-11-30 05:00 UTC (Month end).'
      ),
      'x'
    )
    expect(d.title).toBe('Promotions are frozen')
    expect(d.hint).toMatch(/Month end/)
    const raw = configError(
      refusal('APP_UNREACHABLE', 'Error: connect ECONNREFUSED 10.0.0.1:443'),
      'x'
    )
    expect(raw.hint ?? '').not.toMatch(/ECONNREFUSED/)
  })

  it('shows values plainly', () => {
    expect(shownValue(null)).toBe('—')
    expect(shownValue(false)).toBe('false')
    expect(shownValue({ a: 1 })).toBe('{"a":1}')
    expect(tableWords('nivaro_payload_template_versions')).toBe('payload template versions')
  })
})

describe('refusal rows', () => {
  it('lists the rows a plan refusal names, never raw text', () => {
    const err = {
      response: {
        data: {
          code: 'REF_UNMAPPED',
          items: [
            {
              table: 'nivaro_flow_operations',
              key: 'a',
              label: 'Send',
              reason: 'points at “Gone”'
            },
            { table: 'nivaro_roles', key: 'b', label: null, reason: 'Error: SELECT * FROM x' }
          ]
        }
      }
    }
    expect(refusalItems(err)).toEqual([
      { table: 'nivaro_flow_operations', key: 'a', label: 'Send', reason: 'points at “Gone”' }
    ])
    expect(refusalItems(new Error('x'))).toEqual([])
  })
})
