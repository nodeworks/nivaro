import { describe, expect, it, vi } from 'vitest'

vi.mock('../../db/index.js', () => ({ db: vi.fn() }))

const { validateLookups } = await import('./queries.js')

describe('validateLookups expand', () => {
  const lookup = (expand: unknown) => ({
    materials: { collection: 'inventory_request_materials', expand }
  })

  it('accepts a nested expand up to three levels', () => {
    const ok = validateLookups(
      lookup({
        cifa: {
          collection: 'cifa_items',
          fields: ['cifa_number'],
          expand: {
            task: {
              collection: 'tasks',
              fields: ['name'],
              expand: { parent: { collection: 'tasks', fields: ['name'] } }
            }
          }
        }
      })
    )
    expect(ok.ok).toBe(true)
  })

  it('refuses a fourth level, system tables at any level and unknown settings', () => {
    const deep = validateLookups(
      lookup({
        a: {
          collection: 'x',
          fields: ['f'],
          expand: {
            b: {
              collection: 'y',
              fields: ['f'],
              expand: {
                c: {
                  collection: 'z',
                  fields: ['f'],
                  expand: { d: { collection: 'w', fields: ['f'] } }
                }
              }
            }
          }
        }
      })
    )
    expect(deep.ok).toBe(false)
    if (!deep.ok)
      expect(deep.errors).toContain(
        'materials.expand.a.expand.b.expand.c.expand: expansions go at most 3 levels deep'
      )
    const sys = validateLookups(
      lookup({
        cifa: {
          collection: 'cifa_items',
          fields: ['task'],
          expand: { task: { collection: 'nivaro_settings', fields: ['x'], sort: 'id' } }
        }
      })
    )
    expect(sys.ok).toBe(false)
    if (!sys.ok) {
      expect(sys.errors.some((e) => e.includes('nivaro_settings'))).toBe(true)
      expect(sys.errors).toContain(
        'materials.expand.cifa.expand.task.sort is not an expand setting'
      )
    }
  })
})
