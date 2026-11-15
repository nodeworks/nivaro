import { Decoration, type Editor, Extension } from '@tiptap/react'
import type { PMTransaction } from './collab'

/**
 * Other people's cursors in a co-edited field (realtime round 3, item 8): a thin caret in
 * their colour with their first name on a small flag above it, and their selection tinted.
 * Positions live in this editor's document and move with every change (mapped through each
 * transaction), so a cursor stays where its owner is typing while others type too.
 *
 * Writers only: readers who may not change the field never receive cursors (the server keeps
 * them to the field's write room).
 */

export interface CoeditCursor {
  id: string
  name: string
  color: string
  anchor: number
  head: number
}

const META = 'nvrCoeditCursors'

interface CursorStorage {
  cursors: CoeditCursor[]
}

/**
 * Replace the cursors shown (the session calls this; positions are in the current document).
 * `wake` = the cursor that just moved: its name flag shows again, then fades after a moment so
 * an idle cursor is a thin line only.
 */
export function setCoeditCursors(editor: Editor, cursors: CoeditCursor[], wake?: string): void {
  const storage = (editor.storage as unknown as Record<string, CursorStorage | undefined>)
    .coeditCursors
  if (!storage || editor.isDestroyed) return
  storage.cursors = cursors
  editor.view.dispatch(editor.state.tr.setMeta(META, true).setMeta('addToHistory', false))
  if (!wake) return
  for (const el of editor.view.dom.querySelectorAll<HTMLElement>('.nvr-coedit-caret')) {
    if (el.dataset.coedit !== wake) continue
    // Restart the flag's show-then-fade animation.
    el.classList.remove('nvr-coedit-wake')
    void el.offsetWidth
    el.classList.add('nvr-coedit-wake')
  }
}

/** "Ana Pérez" → "Ana". */
export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name
}

function caret(id: string, name: string, color: string): HTMLElement {
  const el = document.createElement('span')
  el.className = 'nvr-coedit-caret nvr-coedit-wake'
  el.dataset.coedit = id
  el.style.setProperty('--nvr-coedit', color)
  el.setAttribute('aria-hidden', 'true')
  const flag = document.createElement('span')
  flag.className = 'nvr-coedit-flag'
  flag.textContent = firstName(name)
  el.appendChild(flag)
  return el
}

export const CoeditCursors = Extension.create<Record<string, never>, CursorStorage>({
  name: 'coeditCursors',
  addStorage() {
    return { cursors: [] }
  },
  addDecorations() {
    const storage = this.storage
    return {
      // Positions follow every change; the set is rebuilt when they could have moved.
      shouldUpdate: ({ tr }: { tr: PMTransaction }) => {
        if (tr.docChanged && storage.cursors.length) {
          storage.cursors = storage.cursors.map((c) => ({
            ...c,
            anchor: tr.mapping.map(c.anchor, -1),
            head: tr.mapping.map(c.head, 1)
          }))
        }
        return tr.docChanged || !!tr.getMeta(META)
      },
      create: ({ state }) => {
        const size = state.doc.content.size
        const out: Decoration[] = []
        for (const c of storage.cursors) {
          const head = Math.max(0, Math.min(size, c.head))
          const anchor = Math.max(0, Math.min(size, c.anchor))
          const from = Math.min(head, anchor)
          const to = Math.max(head, anchor)
          if (to > from)
            out.push(
              Decoration.Inline(from, to, {
                class: 'nvr-coedit-sel',
                style: `--nvr-coedit: ${c.color}`
              })
            )
          out.push(
            Decoration.Widget(head, () => caret(c.id, c.name, c.color), {
              key: `nvr-coedit-${c.id}-${c.color}-${firstName(c.name)}`,
              side: 1,
              ignoreSelection: true
            })
          )
        }
        return out
      }
    }
  }
})

/** The cursor marks' look (in the editor's own style block; light and dark). */
export const COEDIT_CURSOR_CSS = `
.nvr-coedit-caret {
  position: relative; display: inline-block; width: 0; height: 1.15em;
  margin: 0 -1px; border-left: 2px solid var(--nvr-coedit); vertical-align: text-bottom;
  pointer-events: none; user-select: none;
}
.nvr-coedit-flag {
  position: absolute; left: -2px; bottom: 100%; margin-bottom: 1px;
  padding: 0 5px; border-radius: 3px 3px 3px 0; white-space: nowrap;
  background: var(--nvr-coedit); color: #fff;
  font-family: inherit; font-size: 10px; font-weight: 600; line-height: 15px;
  letter-spacing: 0.01em; opacity: 0;
  box-shadow: 0 1px 2px rgb(15 23 42 / 0.18);
}
/* The name shows while the cursor moves, then fades: an idle cursor is a thin line. */
.nvr-coedit-wake .nvr-coedit-flag { animation: nvr-coedit-flag 3.2s cubic-bezier(0.22, 1, 0.36, 1) both; }
@keyframes nvr-coedit-flag { 0%, 70% { opacity: 1; } 100% { opacity: 0; } }
.nvr-coedit-sel { background-color: color-mix(in srgb, var(--nvr-coedit) 20%, transparent); }
.dark .nvr-coedit-sel { background-color: color-mix(in srgb, var(--nvr-coedit) 36%, transparent); }
@media (prefers-reduced-motion: reduce) {
  .nvr-coedit-flag, .nvr-coedit-wake .nvr-coedit-flag { animation: none; opacity: 1; }
}
`
