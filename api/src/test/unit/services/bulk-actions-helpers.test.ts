import { describe, expect, it } from 'vitest'
import { guardPasses, renderTemplate } from '../../../services/action-guards.js'
import {
  accessAllows,
  normalizeAccess,
  normalizeGuard,
  summarize
} from '../../../services/bulk-actions.js'

type Req = Parameters<typeof accessAllows>[1]
const req = (o: { isAdmin?: boolean; role?: string | null }) =>
  ({ isAdmin: o.isAdmin ?? false, user: { role: o.role ?? null } }) as unknown as Req

describe('guardPasses (bulk-action semantics)', () => {
  it('neq true passes for NULL — a record never held is "not on hold"', () => {
    const g = [{ field: 'is_on_hold', op: 'neq', value: true }]
    expect(guardPasses(g, { is_on_hold: null })).toBe(true)
    expect(guardPasses(g, {})).toBe(true)
    expect(guardPasses(g, { is_on_hold: false })).toBe(true)
    expect(guardPasses(g, { is_on_hold: true })).toBe(false)
    expect(guardPasses(g, { is_on_hold: 1 })).toBe(false)
    expect(guardPasses(g, { is_on_hold: 'true' })).toBe(false)
  })
  it('eq true matches the boolean shapes MSSQL/JSON hand back', () => {
    const g = [{ field: 'is_on_hold', op: 'eq', value: true }]
    expect(guardPasses(g, { is_on_hold: true })).toBe(true)
    expect(guardPasses(g, { is_on_hold: 1 })).toBe(true)
    expect(guardPasses(g, { is_on_hold: '1' })).toBe(true)
    expect(guardPasses(g, { is_on_hold: null })).toBe(false)
  })
  it('in / nin split comma lists; null / nnull test emptiness; rules AND', () => {
    expect(guardPasses([{ field: 's', op: 'in', value: 'a, b' }], { s: 'b' })).toBe(true)
    expect(guardPasses([{ field: 's', op: 'nin', value: 'a, b' }], { s: 'b' })).toBe(false)
    expect(guardPasses([{ field: 's', op: 'null' }], { s: '' })).toBe(true)
    expect(guardPasses([{ field: 's', op: 'nnull' }], { s: 0 })).toBe(true)
    expect(
      guardPasses(
        [
          { field: 'a', op: 'eq', value: 1 },
          { field: 'b', op: 'eq', value: 2 }
        ],
        { a: 1, b: 3 }
      )
    ).toBe(false)
    expect(guardPasses(null, { a: 1 })).toBe(true)
    expect(guardPasses([{ field: 'a', op: 'bogus' }], { a: 1 })).toBe(false)
  })
})

describe('renderTemplate', () => {
  it('substitutes {{reason}} and record fields; unknown tokens render empty', () => {
    expect(renderTemplate('{{reason}} / {{name}} / {{nope}}', { reason: 'r', name: 'n' })).toBe(
      'r / n / '
    )
  })
})

describe('normalizeAccess / accessAllows', () => {
  it('defaults to everyone and drops role ids outside roles mode', () => {
    expect(normalizeAccess(null)).toEqual({ mode: 'everyone' })
    expect(normalizeAccess('{"mode":"admin","role_ids":["x"]}')).toEqual({ mode: 'admin' })
    expect(normalizeAccess({ mode: 'roles', role_ids: ['A', 'A', '', 3] })).toEqual({
      mode: 'roles',
      role_ids: ['A']
    })
  })
  it('admins always pass; roles compare case-insensitively', () => {
    expect(accessAllows({ mode: 'admin' }, req({ isAdmin: true }))).toBe(true)
    expect(accessAllows({ mode: 'admin' }, req({ role: 'r1' }))).toBe(false)
    expect(accessAllows({ mode: 'everyone' }, req({ role: null }))).toBe(true)
    expect(accessAllows({ mode: 'roles', role_ids: ['ABC'] }, req({ role: 'abc' }))).toBe(true)
    expect(accessAllows({ mode: 'roles', role_ids: ['ABC'] }, req({ role: 'zzz' }))).toBe(false)
    expect(accessAllows({ mode: 'roles', role_ids: [] }, req({ role: 'abc' }))).toBe(false)
  })
})

describe('normalizeGuard / summarize', () => {
  it('keeps only well-formed rules with known ops', () => {
    expect(
      normalizeGuard('[{"field":"a","op":"eq","value":1},{"field":"","op":"eq"},{"field":"b","op":"zz"}]')
    ).toEqual([{ field: 'a', op: 'eq', value: 1 }])
    expect(normalizeGuard('[]')).toBeNull()
    expect(normalizeGuard('not json')).toBeNull()
  })
  it('describes both kinds for hover text', () => {
    expect(summarize('transition', { transition_label: 'Cancel' })).toBe('Transition: Cancel')
    expect(summarize('update_fields', { set: { is_on_hold: true, note: null } })).toBe(
      'Set is_on_hold = true, note = empty'
    )
  })
})
