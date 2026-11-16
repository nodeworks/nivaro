import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { MapSpec } from '../api'
import { lookupsFrom } from './FieldMap'
import { itemPath, PAYLOAD_WALK, RecordFieldSection } from './PathPicker'
import { FieldMapEnvContext } from './ui'

// The shared relation picker, stood in by a button that "picks" CIFA → Task → Name (the drill
// the real one offers through cifa_items.task) and records how far it was told to walk.
const seen = vi.hoisted(() => ({ props: [] as Array<Record<string, unknown>> }))
vi.mock('@nivaro/shared', () => ({
  CollectionFieldPicker: (p: {
    collection: string
    placeholder?: string
    walk?: unknown
    onChange: (picked: { path: string[]; pathLabels: string[]; fieldType: string }) => void
  }) => {
    seen.props.push(p)
    return (
      <button
        type='button'
        onClick={() =>
          p.onChange({
            path: ['cifa', 'task', 'name'],
            pathLabels: ['Cifa', 'Task', 'Name'],
            fieldType: 'string'
          })
        }
      >
        {p.placeholder} ({p.collection})
      </button>
    )
  }
}))

const env = {
  collection: 'inventory_requests',
  lookups: [{ key: 'materials', collection: 'inventory_request_materials' }],
  secretNames: [],
  partner: 'Fusion',
  secretsHref: null
}

function renderSection(value: string, onChange: (p: string) => void) {
  return render(
    <FieldMapEnvContext.Provider value={env}>
      <RecordFieldSection
        value={value}
        onChange={onChange}
        scope={{ alias: 'material', collection: 'inventory_request_materials' }}
      />
    </FieldMapEnvContext.Provider>
  )
}

describe('From each <item> picker', () => {
  it('writes the path the evaluator reads: alias + the picked links', () => {
    expect(itemPath('material', ['cifa', 'task', 'name'])).toBe('material.cifa.task.name')
    const onChange = vi.fn()
    seen.props = []
    renderSection('', onChange)
    fireEvent.click(screen.getByText(/Pick a field of the material/))
    expect(onChange).toHaveBeenCalledWith('material.cifa.task.name')
    // Both pickers walk only what a render follows: many-to-one links, three deep.
    expect(seen.props.map((p) => p.collection)).toEqual([
      'inventory_request_materials',
      'inventory_requests'
    ])
    for (const p of seen.props) expect(p.walk).toEqual(PAYLOAD_WALK)
    expect(PAYLOAD_WALK).toEqual({ m2oOnly: true, maxHops: 3 })
  })

  it('keeps a typed path for odd cases', () => {
    const onChange = vi.fn()
    renderSection('material.cifa_data.task.name', onChange)
    fireEvent.click(screen.getByRole('button', { name: /Type a path/ }))
    const input = screen.getByLabelText('Field of each material') as HTMLInputElement
    expect(input.value).toBe('cifa_data.task.name')
    fireEvent.change(input, { target: { value: 'cifa_data.task.expenditure_type' } })
    expect(onChange).toHaveBeenLastCalledWith('material.cifa_data.task.expenditure_type')
    fireEvent.click(screen.getByRole('button', { name: /^Pick a field$/ }))
    expect(screen.queryByLabelText('Field of each material')).toBeNull()
  })
})

describe('lookupsFrom', () => {
  it("gives a transition context key its rows' collection (the action wins a clash)", () => {
    const spec: MapSpec = { v: 1, fields: [] }
    expect(
      lookupsFrom({ materials: { collection: 'old_materials' } }, ['materials', 'pos'], spec, {
        materials: 'inventory_request_materials',
        pos: ''
      })
    ).toEqual([
      { key: 'materials', collection: 'inventory_request_materials' },
      { key: 'pos', collection: undefined }
    ])
  })
})
