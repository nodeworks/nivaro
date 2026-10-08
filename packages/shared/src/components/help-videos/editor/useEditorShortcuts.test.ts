// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type EditorShortcutActions, useEditorShortcuts } from './useEditorShortcuts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function Probe({ active, actions }: { active: boolean; actions: EditorShortcutActions }) {
  useEditorShortcuts(active, actions)
  return null
}
const actions = (over: Partial<EditorShortcutActions> = {}): EditorShortcutActions => ({
  undo: vi.fn(),
  redo: vi.fn(),
  split: vi.fn(),
  deletePiece: vi.fn(),
  addChapter: vi.fn(),
  stopDrawing: vi.fn(),
  toggleShortcuts: vi.fn(),
  pieceSelected: false,
  ...over
})
const press = (key: string, init: KeyboardEventInit = {}) =>
  window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }))

afterEach(() => vi.restoreAllMocks())

describe('useEditorShortcuts', () => {
  it('subscribes once and always calls the latest actions', async () => {
    const add = vi.spyOn(window, 'addEventListener')
    const root = createRoot(document.createElement('div'))
    let last = actions()
    for (let i = 0; i < 30; i++) {
      last = actions()
      await act(async () => root.render(createElement(Probe, { active: true, actions: last })))
    }
    expect(add.mock.calls.filter(([t]) => t === 'keydown')).toHaveLength(1)
    press('s')
    expect(last.split).toHaveBeenCalledTimes(1)
    press('z', { ctrlKey: true })
    press('z', { ctrlKey: true, shiftKey: true })
    expect(last.undo).toHaveBeenCalledTimes(1)
    expect(last.redo).toHaveBeenCalledTimes(1)
    await act(async () => root.unmount())
  })

  it('does nothing off the Edit tab, and Delete only with a piece selected', async () => {
    const root = createRoot(document.createElement('div'))
    const a = actions()
    await act(async () => root.render(createElement(Probe, { active: false, actions: a })))
    press('s')
    expect(a.split).not.toHaveBeenCalled()
    await act(async () => root.render(createElement(Probe, { active: true, actions: a })))
    press('Delete')
    expect(a.deletePiece).not.toHaveBeenCalled()
    const b = actions({ pieceSelected: true })
    await act(async () => root.render(createElement(Probe, { active: true, actions: b })))
    press('Delete')
    expect(b.deletePiece).toHaveBeenCalledTimes(1)
    await act(async () => root.unmount())
  })

  it('adds a chapter with M, stops drawing with Escape, lists the keys with ?', async () => {
    const root = createRoot(document.createElement('div'))
    const a = actions()
    await act(async () => root.render(createElement(Probe, { active: true, actions: a })))
    press('m')
    press('M', { shiftKey: true })
    press('m', { metaKey: true })
    expect(a.addChapter).toHaveBeenCalledTimes(2)
    press('Escape')
    expect(a.stopDrawing).toHaveBeenCalledTimes(1)
    press('?', { shiftKey: true })
    expect(a.toggleShortcuts).toHaveBeenCalledTimes(1)
    // Never while typing.
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', bubbles: true }))
    expect(a.addChapter).toHaveBeenCalledTimes(2)
    input.remove()
    await act(async () => root.unmount())
  })
})
