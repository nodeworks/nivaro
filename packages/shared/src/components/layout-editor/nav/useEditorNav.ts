import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { LayoutBundle } from '../../../lib/layout-ops'
import {
  type DesignTarget,
  type FoldSignal,
  type RevealSignal,
  type SelectOptions,
  targetKey
} from '../design-context'
import { isTyping } from '../is-typing'
import type { DescribeField } from '../overview/describe-conditions'
import type { FindHit } from './find'
import { buildOutline } from './tree'
import { useCanvasZoom, useViewPref } from './view-prefs'

// The editor's way-finding state (#2620 find, #2621 outline, #2622
// breadcrumb, #2626 shortcut sheet, #2627 compact + expand / collapse all)
// and the two keys that open it: ⌘F / Ctrl+F and ?.

/** Wait for a canvas node to paint (a step or tab switch, a section unfolding). */
function whenOnCanvas(
  key: string,
  tries: number,
  found: (el: HTMLElement) => void,
  missing: (n: number) => void
) {
  let n = 0
  const look = () => {
    const el = document.querySelector<HTMLElement>(
      `[data-layout-editor] [data-editor-canvas] [data-design-target="${CSS.escape(key)}"]`
    )
    if (el) return found(el)
    n++
    missing(n)
    if (n < tries) window.setTimeout(look, 120)
  }
  requestAnimationFrame(look)
}

export function useEditorNav({
  bodyRef,
  bundle,
  parent,
  fields,
  onSelect,
  showHidden,
  setShowHidden,
  canvasShown
}: {
  bodyRef: RefObject<HTMLElement | null>
  bundle: LayoutBundle | null
  parent: LayoutBundle | null
  fields: DescribeField[]
  onSelect: (t: DesignTarget, opts?: SelectOptions) => void
  showHidden: boolean
  setShowHidden: (on: boolean) => void
  /** False while the placements table stands in for the canvas. */
  canvasShown: boolean
}) {
  const [fold, setFold] = useState<FoldSignal | null>(null)
  const [reveal, setReveal] = useState<RevealSignal | null>(null)
  const [findOpen, setFindOpen] = useState(false)
  const [findSeq, setFindSeq] = useState(0)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [outlineOpen, setOutlineOpen] = useViewPref('outline')
  const [compact, setCompact] = useViewPref('compact')
  // #3188: the canvas zoom slider, kept per person beside compact.
  const [zoom, setZoom] = useCanvasZoom()
  const seq = useRef(0)
  const showHiddenRef = useRef(showHidden)
  showHiddenRef.current = showHidden

  const labels = useMemo(() => {
    const m = new Map(fields.map((f) => [f.field, f.label ?? null]))
    return (f: string) => m.get(f)
  }, [fields])
  const nodes = useMemo(
    () => (bundle ? buildOutline(bundle, parent, labels) : []),
    [bundle, parent, labels]
  )

  /**
   * Select `t` and bring it into view: the step or tab holding it opens, its
   * section unfolds, the canvas scrolls to it. Something the form would not
   * show (hidden, or hidden by a rule) turns on Show hidden.
   */
  const selectAndReveal = useCallback(
    (t: DesignTarget, opts?: SelectOptions & { focus?: boolean }) => {
      onSelect(t, opts)
      seq.current += 1
      setReveal({ target: t, seq: seq.current })
      if (!canvasShown) return
      // Only a field (or a panel in a section) can be missing because it is hidden.
      const mayHide =
        (t.kind === 'field' || (t.kind === 'slot' && t.group_key !== null)) &&
        t.field !== '__subtitle__'
      let askedHidden = false
      whenOnCanvas(
        targetKey(t),
        14,
        (el) => {
          el.scrollIntoView?.({ block: 'center' })
          if (opts?.focus) el.focus({ preventScroll: true })
        },
        (n) => {
          if (n === 4 && mayHide && !showHiddenRef.current && !askedHidden) {
            askedHidden = true
            setShowHidden(true)
            toast.info('Show hidden is on: what you picked is hidden on this form')
          }
        }
      )
    },
    [onSelect, setShowHidden, canvasShown]
  )

  // A picked match takes focus to the canvas: closing Find must not pull it back.
  const picked = useRef(false)
  const onFindCloseFocus = useCallback((e: Event) => {
    if (!picked.current) return
    picked.current = false
    e.preventDefault()
  }, [])
  const pickHit = useCallback(
    (hit: FindHit) => {
      if (!hit.node.target) return
      picked.current = true
      setFindOpen(false)
      selectAndReveal(hit.node.target, { focus: true })
    },
    [selectAndReveal]
  )

  const foldAll = useCallback((open: boolean) => {
    seq.current += 1
    setFold({ open, seq: seq.current })
  }, [])

  // ⌘F / Ctrl+F opens Find — only for the editor: focus on the page itself,
  // inside the editor, or in one of its popovers. ? opens the shortcut sheet
  // (never while typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Keys sent to window itself (tests, some hosts) count as the page.
      const target = e.target instanceof HTMLElement ? e.target : null
      const inEditor =
        !target ||
        target === document.body ||
        target === document.documentElement ||
        !!bodyRef.current?.contains(target) ||
        !!target.closest?.('[data-radix-popper-content-wrapper]')
      if (!inEditor || e.defaultPrevented) return
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        setShortcutsOpen(false)
        setFindOpen(true)
        setFindSeq((n) => n + 1)
        return
      }
      if (e.key === '?' && !e.metaKey && !e.ctrlKey && !e.altKey && !isTyping(target)) {
        e.preventDefault()
        setFindOpen(false)
        setShortcutsOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [bodyRef])

  return {
    nodes,
    fold,
    reveal,
    selectAndReveal,
    expandAll: () => foldAll(true),
    collapseAll: () => foldAll(false),
    find: {
      open: findOpen,
      onOpenChange: setFindOpen,
      nodes,
      onPick: pickHit,
      focusSeq: findSeq,
      onCloseAutoFocus: onFindCloseFocus
    },
    shortcuts: { open: shortcutsOpen, onOpenChange: setShortcutsOpen },
    outlineOpen,
    setOutlineOpen,
    compact,
    setCompact,
    zoom,
    setZoom
  }
}
