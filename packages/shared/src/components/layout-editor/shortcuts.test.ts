import { describe, expect, it } from 'vitest'
import { keyLabels, registerShortcut, SHORTCUT_AREAS, shortcutGroups } from './shortcuts'

describe('shortcuts registry', () => {
  it('lists the editor’s keys grouped by area, in area order', () => {
    const groups = shortcutGroups()
    expect(groups.map((g) => g.area)).toEqual(
      SHORTCUT_AREAS.filter((a) => groups.some((g) => g.area === a))
    )
    const ids = groups.flatMap((g) => g.items.map((s) => s.id))
    for (const id of [
      'undo',
      'redo',
      'save',
      'alt-move',
      'keyboard-drag',
      'find',
      'palette',
      'duplicate'
    ])
      expect(ids).toContain(id)
  })

  it('registerShortcut appends a new row and replaces one with the same id', () => {
    registerShortcut({ id: 'zz-test', area: 'View', keys: [['mod', 'j']], label: 'Test' })
    registerShortcut({ id: 'zz-test', area: 'View', keys: [['mod', 'j']], label: 'Test again' })
    const view = shortcutGroups().find((g) => g.area === 'View')?.items ?? []
    expect(view.filter((s) => s.id === 'zz-test').map((s) => s.label)).toEqual(['Test again'])
  })

  it('shows Mac symbols on a Mac and words elsewhere', () => {
    expect(keyLabels(['shift', 'mod', 'z'], true)).toEqual(['⇧', '⌘', 'Z'])
    expect(keyLabels(['shift', 'mod', 'z'], false)).toEqual(['Shift', 'Ctrl', 'Z'])
    expect(keyLabels(['alt', '↑'], false)).toEqual(['Alt', '↑'])
  })
})
