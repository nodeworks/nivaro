// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DependencyDiagramView, impactSentence } from './DependencyDiagram'
import { type LayoutDependencies, requestsByLayout, trimUploadedFile } from './ops-api'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const DATA: LayoutDependencies = {
  layout: { id: 7, collection: 'orders', name: 'Main', slug: 'main', layout_type: 'grouped' },
  groups: [
    { id: 'queues', label: 'Queues' },
    { id: 'files', label: 'Generated files' },
    { id: 'extensions', label: 'Extension code' }
  ],
  nodes: [
    {
      kind: 'queue',
      group: 'queues',
      id: 'q1',
      label: 'Queue “Open orders” opens records with it',
      by: 'slug',
      breaks: ['slug', 'type', 'delete']
    },
    {
      kind: 'generated_files',
      group: 'files',
      id: 7,
      label: '3 generated files',
      by: 'id',
      breaks: ['delete']
    }
  ],
  extensions: { declaring: 0, note: 'Extension code is not checked.' }
}

let root: Root
let host: HTMLDivElement
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('DependencyDiagram (#2613)', () => {
  it('says what a change breaks', () => {
    expect(impactSentence(DATA.nodes, 'rename')).toContain('keeps every one working')
    expect(impactSentence(DATA.nodes, 'slug')).toBe(
      '1 of 2 find it by its link name and stop finding it when the link name changes.'
    )
    expect(impactSentence(DATA.nodes, 'delete')).toBe('2 of 2 stop working when it is deleted.')
    expect(impactSentence([], 'delete')).toBe('Nothing stored here uses this form.')
  })

  it('draws every dependent in its lane and marks what the change breaks', () => {
    act(() => root.render(<DependencyDiagramView data={DATA} change='slug' />))
    const nodes = [...host.querySelectorAll<HTMLElement>('[data-dep-node]')]
    expect(nodes.map((n) => n.dataset.depNode)).toEqual([
      'queue:q1',
      'generated_files:7',
      'ext-unchecked'
    ])
    expect(nodes.map((n) => n.dataset.broken)).toEqual(['true', 'false', 'false'])
    expect(host.querySelector('[data-dep-lane="extensions"]')?.textContent).toContain('not checked')
    expect(host.querySelector('svg')).not.toBeNull()
  })
})

describe('ops-api helpers', () => {
  it('cuts a config snapshot down to the layout tables', () => {
    const snap = {
      format: 1,
      instance: { environment: 'staging' },
      tables: {
        nivaro_collection_layouts: { 1: {} },
        nivaro_field_groups: {},
        nivaro_layout_field_assignments: {},
        nivaro_users: { a: {} }
      }
    }
    const out = trimUploadedFile(JSON.stringify({ data: snap })) as typeof snap
    expect(Object.keys(out.tables).sort()).toEqual([
      'nivaro_collection_layouts',
      'nivaro_field_groups',
      'nivaro_layout_field_assignments'
    ])
    expect(() => trimUploadedFile('nope')).toThrow('not JSON')
  })

  it('counts open suggestions per layout', () => {
    const m = requestsByLayout([{ layout_id: 3 }, { layout_id: 3 }, { layout_id: null }] as never)
    expect(m.get(3)).toBe(2)
    expect(m.get(0)).toBe(1)
  })
})
