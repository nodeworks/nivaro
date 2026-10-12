// AI tool results label linked records AS THE ASKER: a link the asker cannot
// read keeps its bare id, people get names only (never an email).
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import { type LinkLabelDeps, linkLabelsAsUser } from '../../../services/ai-link-labels.js'
import type { User } from '../../../types.js'

afterEach(() => vi.clearAllMocks())

const ASKER = { id: 'ASKER', role: 'R' } as unknown as User

const VENDORS: Record<string, Record<string, unknown>> = {
  '1': { id: 1, name: 'ACME', code: 'A1', secret_rate: 99 },
  '2': { id: 2, name: 'Globex', code: 'G2', secret_rate: 12 }
}

function deps(over: Partial<LinkLabelDeps> = {}): LinkLabelDeps {
  return {
    canRead: async () => true,
    allowedFields: async () => null,
    template: async () => null,
    columns: async () => ['id', 'name', 'code', 'secret_rate', 'parent'],
    read: vi.fn(async (_u: User, _c: string, ids: string[], fields: string[]) =>
      ids
        .filter((id) => VENDORS[id])
        .map((id) => Object.fromEntries(fields.map((f) => [f, VENDORS[id][f]])))
    ),
    people: async () => [],
    ...over
  }
}

const byTarget = (c: string, ids: string[]) => new Map([[c, new Set(ids)]])

describe('linkLabelsAsUser', () => {
  it('labels what the asker can read, through readItems as the asker', async () => {
    const d = deps()
    const labels = await linkLabelsAsUser(ASKER, byTarget('vendors', ['1', '2']), d)
    expect(labels).toEqual({ 'vendors:1': 'ACME', 'vendors:2': 'Globex' })
    expect(d.read).toHaveBeenCalledWith(ASKER, 'vendors', ['1', '2'], ['id', 'name'])
  })

  it('no read permission on the target: no label, no read at all', async () => {
    const d = deps({ canRead: async () => false })
    expect(await linkLabelsAsUser(ASKER, byTarget('vendors', ['1']), d)).toEqual({})
    expect(d.read).not.toHaveBeenCalled()
  })

  it('a linked row hidden by row rules or scopes keeps its bare id', async () => {
    // readItems as the asker returns only row 1 — row 2 is outside their RLS.
    const d = deps({
      read: async (_u, _c, _ids, fields) => [
        Object.fromEntries(fields.map((f) => [f, VENDORS['1'][f]]))
      ]
    })
    expect(await linkLabelsAsUser(ASKER, byTarget('vendors', ['1', '2']), d)).toEqual({
      'vendors:1': 'ACME'
    })
  })

  it('a display template only reads plain columns the asker may read', async () => {
    const d = deps({
      template: async () => '{{name}} ({{secret_rate}}) {{parent.name}}',
      allowedFields: async () => ['id', 'name', 'parent']
    })
    const labels = await linkLabelsAsUser(ASKER, byTarget('vendors', ['1']), d)
    expect(d.read).toHaveBeenCalledWith(ASKER, 'vendors', ['1'], ['id', 'name'])
    expect(labels['vendors:1']).toContain('ACME')
    expect(labels['vendors:1']).not.toContain('99')
  })

  it('no readable label column: no label', async () => {
    const d = deps({ allowedFields: async () => ['id', 'code'] })
    expect(await linkLabelsAsUser(ASKER, byTarget('vendors', ['1']), d)).toEqual({})
  })

  it('people: names only, never an email, never a redacted account', async () => {
    const d = deps({
      people: async () => [
        { id: 'u1', first_name: 'Ana', last_name: 'Lee', is_redacted: false },
        { id: 'u2', first_name: null, last_name: null, is_redacted: null },
        { id: 'u3', first_name: 'Gone', last_name: 'Person', is_redacted: true }
      ]
    })
    const labels = await linkLabelsAsUser(ASKER, byTarget('nivaro_users', ['u1', 'u2', 'u3']), d)
    expect(labels).toEqual({ 'nivaro_users:U1': 'Ana Lee' })
    expect(JSON.stringify(labels)).not.toContain('@')
  })

  it('a failing read leaves the ids bare instead of throwing', async () => {
    const d = deps({
      read: async () => {
        throw new Error('No read access')
      }
    })
    expect(await linkLabelsAsUser(ASKER, byTarget('vendors', ['1']), d)).toEqual({})
  })
})
