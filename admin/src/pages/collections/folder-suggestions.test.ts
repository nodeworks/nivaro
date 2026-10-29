import { describe, expect, it } from 'vitest'
import { suggestFolders } from './folder-suggestions'
import type { Collection, FolderOption } from './types'

let id = 0
const col = (collection: string, group: string | null = null): Collection => ({
  id: ++id,
  collection,
  display_name: null,
  icon: null,
  color: null,
  note: null,
  hidden: false,
  singleton: false,
  display_template: null,
  sort: null,
  group
})
const folder = (key: string, label: string): FolderOption => ({ key, label, color: null })

describe('suggestFolders', () => {
  const folders = [folder('wf', 'Workflow'), folder('inv', 'Inventory')]
  const rows = [col('wf'), col('inv'), col('workflows', 'wf'), col('inventory_request', 'inv')]

  it('rule b: prefix of a collection already in a folder, single is enough', () => {
    const loose = [col('inventory_request_files')]
    const r = suggestFolders(loose, folders, [...rows, ...loose])
    expect(r).toHaveLength(1)
    expect(r[0].folder.key).toBe('inv')
    expect(r[0].collections).toEqual(['inventory_request_files'])
    expect(r[0].reason).toBe('Starts with inventory_request_ (in Inventory)')
  })

  it('rule b tolerates plural folder members (workflows -> workflow_line_items)', () => {
    const loose = [col('workflow_line_items')]
    const r = suggestFolders(loose, folders, [...rows, ...loose])
    expect(r[0].folder.key).toBe('wf')
    expect(r[0].reason).toContain('workflows_')
  })

  it('rule a: label or key token match needs two collections', () => {
    const one = [col('inventory_audit')]
    expect(suggestFolders(one, folders, [...rows, ...one])).toEqual([])
    const two = [col('inventory_audit'), col('inventories_old')]
    const r = suggestFolders(two, folders, [...rows, ...two])
    expect(r).toHaveLength(1)
    expect(r[0].collections).toEqual(['inventories_old', 'inventory_audit'])
  })

  it('is case-insensitive and plural tolerant for folders', () => {
    const f = [folder('Workflows', 'Flows')]
    const loose = [col('workflow_a'), col('WORKFLOW_B')]
    const r = suggestFolders(loose, f, [col('Workflows'), ...loose])
    expect(r[0].collections).toHaveLength(2)
  })

  it('longest member prefix wins', () => {
    const f = [folder('a', 'Alpha'), folder('b', 'Beta')]
    const all = [col('a'), col('b'), col('order', 'a'), col('order_line', 'b')]
    const loose = [col('order_line_notes')]
    const r = suggestFolders(loose, f, [...all, ...loose])
    expect(r[0].folder.key).toBe('b')
  })

  it('member match beats label match', () => {
    const f = [folder('a', 'Alpha'), folder('b', 'Beta')]
    const all = [col('a'), col('b'), col('alpha_thing', 'b')]
    const loose = [col('alpha_thing_x')]
    expect(suggestFolders(loose, f, [...all, ...loose])[0].folder.key).toBe('b')
  })

  it('does not suggest folder rows, unrelated names, or substring-only matches', () => {
    const loose = [col('inv'), col('invoice_a'), col('invoice_b'), col('users')]
    expect(suggestFolders(loose, folders, [...rows, ...loose])).toEqual([])
  })

  it('sorts by size desc then label and is deterministic', () => {
    const loose = [
      col('inventory_request_a'),
      col('workflows_x'),
      col('workflow_y'),
      col('workflow_z')
    ]
    const all = [...rows, ...loose]
    const r = suggestFolders(loose, folders, all)
    expect(r.map((s) => s.folder.key)).toEqual(['wf', 'inv'])
    expect(r[0].collections).toHaveLength(3)
    expect(suggestFolders([...loose].reverse(), folders, all)).toEqual(r)
  })

  it('empty inputs', () => {
    expect(suggestFolders([], [], [])).toEqual([])
    expect(suggestFolders([col('x_y')], [], [])).toEqual([])
  })
})
