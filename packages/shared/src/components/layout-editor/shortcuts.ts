// Every keyboard shortcut the layout editor answers to, in one list (#2626):
// the shortcut sheet (press ?) reads it, and a feature that adds a key adds
// its row here with registerShortcut — so the sheet never goes out of date.
//
// Keys are written Mac-style: `mod` is ⌘ on a Mac and Ctrl elsewhere,
// `shift` ⇧, `alt` ⌥ / Alt. keyLabels() turns them into what to show.

export type ShortcutArea = 'Editing' | 'Moving' | 'Finding' | 'Saving' | 'View'

export interface Shortcut {
  id: string
  area: ShortcutArea
  /** Each entry is one way to press it: ['mod', 'z']. */
  keys: string[][]
  /** What it does, in plain words. */
  label: string
}

export const SHORTCUT_AREAS: ShortcutArea[] = ['Editing', 'Moving', 'Finding', 'Saving', 'View']

const shortcuts: Shortcut[] = [
  { id: 'undo', area: 'Editing', keys: [['mod', 'z']], label: 'Undo' },
  {
    id: 'redo',
    area: 'Editing',
    keys: [
      ['shift', 'mod', 'z'],
      ['ctrl', 'y']
    ],
    label: 'Redo'
  },
  { id: 'duplicate', area: 'Editing', keys: [['mod', 'd']], label: 'Duplicate the selection' },
  {
    id: 'select-more',
    area: 'Editing',
    keys: [
      ['shift', 'click'],
      ['mod', 'click']
    ],
    label: 'Select several fields'
  },
  {
    id: 'alt-move',
    area: 'Moving',
    keys: [
      ['alt', '↑'],
      ['alt', '↓']
    ],
    label: 'Move the selection up or down one place'
  },
  {
    id: 'alt-move-across',
    area: 'Moving',
    keys: [
      ['alt', '←'],
      ['alt', '→']
    ],
    label: 'Move a field to the previous or next section; a tab or step left or right'
  },
  {
    id: 'keyboard-drag',
    area: 'Moving',
    keys: [['space']],
    label: 'Pick up the focused field or section, arrows to move it, Space to drop'
  },
  { id: 'cancel-drag', area: 'Moving', keys: [['esc']], label: 'Cancel a drag' },
  { id: 'find', area: 'Finding', keys: [['mod', 'f']], label: 'Find a field on the form' },
  { id: 'palette', area: 'Finding', keys: [['mod', 'k']], label: 'Open the command palette' },
  { id: 'save', area: 'Saving', keys: [['mod', 's']], label: 'Save changes' },
  { id: 'shortcuts', area: 'View', keys: [['?']], label: 'Show these shortcuts' },
  {
    id: 'close',
    area: 'View',
    keys: [['esc']],
    label: 'Close the editor (record page), or the open popover'
  }
]

/** Add (or replace, by id) a shortcut row. Features call this at module load. */
export function registerShortcut(s: Shortcut): void {
  const at = shortcuts.findIndex((x) => x.id === s.id)
  if (at >= 0) shortcuts[at] = s
  else shortcuts.push(s)
}

/** Every shortcut, grouped by area in SHORTCUT_AREAS order; empty areas are left out. */
export function shortcutGroups(): Array<{ area: ShortcutArea; items: Shortcut[] }> {
  return SHORTCUT_AREAS.map((area) => ({
    area,
    items: shortcuts.filter((s) => s.area === area)
  })).filter((g) => g.items.length > 0)
}

export function isMacLike(): boolean {
  if (typeof navigator === 'undefined') return true
  const p =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.platform ??
    navigator.userAgent
  return /mac|iphone|ipad|ipod/i.test(p ?? '')
}

const MAC_KEYS: Record<string, string> = {
  mod: '⌘',
  shift: '⇧',
  alt: '⌥',
  ctrl: 'Ctrl',
  esc: 'Esc',
  space: 'Space',
  click: 'click'
}
const PC_KEYS: Record<string, string> = { ...MAC_KEYS, mod: 'Ctrl', shift: 'Shift', alt: 'Alt' }

/** One way of pressing a shortcut as the keys to show: ['⌘', 'Z'] or ['Ctrl', 'Z']. */
export function keyLabels(keys: string[], mac = isMacLike()): string[] {
  const names = mac ? MAC_KEYS : PC_KEYS
  return keys.map((k) => names[k] ?? (k.length === 1 ? k.toUpperCase() : k))
}
