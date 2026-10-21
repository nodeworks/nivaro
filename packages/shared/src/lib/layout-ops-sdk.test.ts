import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// The SDK mirrors the layout-ops types and patch-key lists (it takes no runtime
// dependency on @nivaro/shared). Compared as text, so a type edited on one
// side only fails here. Commands are loaded by variable path: the SDK source
// sits outside this package's tsc rootDir.
const here = (rel: string) => new URL(rel, import.meta.url)
const sharedSrc = readFileSync(here('./layout-ops.ts'), 'utf8')
const sdkSrc = readFileSync(here('../../../sdk/src/commands/layout-editor.ts'), 'utf8')

function sharedBlock(): string {
  const start = sharedSrc.indexOf('export type PlacementKey')
  // Through the end of LAYOUT_PATCH_KEYS, whichever key is last.
  const keys = sharedSrc.indexOf('export const LAYOUT_PATCH_KEYS', start)
  const endMarker = '\n] as const\n'
  const end = sharedSrc.indexOf(endMarker, keys) + endMarker.length
  return sharedSrc.slice(start, end)
}

function sdkBlock(): string {
  const start =
    sdkSrc.indexOf('// BEGIN layout-ops mirror\n') + '// BEGIN layout-ops mirror\n'.length
  const end = sdkSrc.indexOf('// END layout-ops mirror')
  return sdkSrc.slice(start, end).replace(/\n+$/, '\n')
}

describe('SDK layout-ops mirror', () => {
  it('finds both blocks', () => {
    expect(sharedBlock()).toContain('export type LayoutOp =')
    expect(sdkBlock()).toContain('export type LayoutOp =')
  })

  it('is byte-identical to packages/shared/src/lib/layout-ops.ts', () => {
    expect(sdkBlock()).toBe(sharedBlock())
  })
})

type Cmd = { _method: string; _path: string; _params?: unknown; _body?: unknown }
type Fn = (...args: never[]) => Cmd

async function load(file: string): Promise<Record<string, Fn>> {
  const path = `../../../sdk/src/commands/${file}`
  return (await import(/* @vite-ignore */ path)) as Record<string, Fn>
}
const run = (fn: unknown, ...args: unknown[]): Cmd => (fn as (...a: unknown[]) => Cmd)(...args)
const shape = (c: Cmd) => ({ m: c._method, p: c._path, q: c._params, b: c._body })

describe('SDK layout editor commands', () => {
  it('maps each command to method, path, query and body', async () => {
    const le = await load('layout-editor')
    const ops = [{ op: 'remove', at: { field: 'a', group_key: null } }]
    expect(shape(run(le.readLayoutOverview, 'posts'))).toEqual({
      m: 'GET',
      p: '/collection-layouts/overview',
      q: { collection: 'posts' },
      b: undefined
    })
    expect(shape(run(le.explainLayout, { collection: 'posts', item: 4, role_id: 'r1' }))).toEqual({
      m: 'GET',
      p: '/collection-layouts/explain',
      q: { collection: 'posts', item: 4, role_id: 'r1' },
      b: undefined
    })
    expect(shape(run(le.readLayoutBundle, 7))).toMatchObject({
      m: 'GET',
      p: '/collection-layouts/7/bundle'
    })
    expect(shape(run(le.submitLayoutOps, 7, { ops, base_rev: 'abc', note: 'n' }))).toEqual({
      m: 'POST',
      p: '/collection-layouts/7/ops',
      q: undefined,
      b: { ops, base_rev: 'abc', note: 'n' }
    })
    expect(shape(run(le.readLayoutVersion, 7, 3))).toMatchObject({
      m: 'GET',
      p: '/collection-layouts/7/versions/3'
    })
    expect(shape(run(le.diffLayoutVersion, 7, 'newest'))).toMatchObject({
      p: '/collection-layouts/7/versions/newest/diff',
      q: undefined
    })
    expect(shape(run(le.diffLayoutVersion, 7, 3, 'current'))).toMatchObject({
      q: { against: 'current' }
    })
    expect(shape(run(le.readLayoutDrift))).toMatchObject({ p: '/collection-layouts/drift' })
    expect(shape(run(le.projectFieldConfig, 'posts', [{ field: 'a', col_span: 2 }]))).toEqual({
      m: 'POST',
      p: '/field-config/posts/project',
      q: undefined,
      b: { assignments: [{ field: 'a', col_span: 2 }] }
    })
    expect(shape(run(le.listInternalWidgetPlacements, 9))).toMatchObject({
      m: 'GET',
      p: '/widgets-internal/9/placements'
    })
  })

  it('maps the picker-exclusion commands', async () => {
    const le = await load('layout-editor')
    expect(shape(run(le.readPickerExclusion, 'posts', 5))).toMatchObject({
      m: 'GET',
      p: '/picker-exclusions/status/posts/5'
    })
    expect(shape(run(le.readPickerExclusions, 'posts', [1, 2]))).toMatchObject({
      m: 'POST',
      p: '/picker-exclusions/batch-status',
      b: { collection: 'posts', ids: [1, 2] }
    })
    const body = { collection: 'posts', item_id: 5, layout: 'intake' }
    expect(shape(run(le.excludeFromPickers, body))).toMatchObject({
      m: 'POST',
      p: '/picker-exclusions',
      b: body
    })
    expect(shape(run(le.includeInPickers, body))).toMatchObject({
      m: 'DELETE',
      p: '/picker-exclusions',
      b: body
    })
    expect(
      shape(run(le.bulkPickerExclusion, { collection: 'posts', ids: [1], exclude: true }))
    ).toMatchObject({ m: 'POST', p: '/picker-exclusions/bulk' })
  })

  it('carries the new layout options on create, clone, active and update', async () => {
    const dx = await load('devex')
    expect(
      shape(
        run(dx.createCollectionLayout, 'posts', 'Intake', {
          layout_type: 'grouped',
          seed_fields: true
        })
      )
    ).toMatchObject({
      m: 'POST',
      p: '/collection-layouts',
      b: { collection: 'posts', name: 'Intake', layout_type: 'grouped', seed_fields: true }
    })
    expect(shape(run(dx.createCollectionLayout, 'posts', 'Intake')).b).toEqual({
      collection: 'posts',
      name: 'Intake'
    })
    expect(shape(run(dx.cloneLayout, 3, 'Copy', { layout_type: 'summary' }))).toMatchObject({
      p: '/collection-layouts/3/clone',
      b: { name: 'Copy', layout_type: 'summary' }
    })
    expect(shape(run(dx.cloneLayout, 3, 'Copy')).b).toEqual({ name: 'Copy' })
    expect(shape(run(dx.readActiveLayout, 'posts', { slug: 'intake', item: 4 }))).toMatchObject({
      p: '/collection-layouts/active',
      q: { collection: 'posts', slug: 'intake', item: 4 }
    })
    expect(shape(run(dx.readActiveLayout, 'posts')).q).toEqual({ collection: 'posts' })
    expect(shape(run(dx.updateCollectionLayout, 3, { disable_clone: true }))).toMatchObject({
      m: 'PATCH',
      p: '/collection-layouts/3',
      b: { disable_clone: true }
    })
    expect(shape(run(dx.restoreLayoutVersion, 3, 2))).toMatchObject({
      m: 'POST',
      p: '/collection-layouts/3/versions/2/restore'
    })
  })

  it('passes layout through scheduled changes and a layout id through field config', async () => {
    const ct = await load('content')
    const body = {
      collection: 'posts',
      item_id: '5',
      change_type: 'field_update',
      changes: { a: 1 },
      scheduled_at: '2026-11-01T00:00:00Z',
      layout: 'intake'
    }
    expect(shape(run(ct.createScheduledChange, body))).toMatchObject({
      m: 'POST',
      p: '/scheduled-changes',
      b: body
    })
    expect(shape(run(ct.readFieldConfig, 'posts', { layout_id: 3 }))).toMatchObject({
      p: '/field-config/posts',
      q: { layout_id: 3 }
    })
  })
})
