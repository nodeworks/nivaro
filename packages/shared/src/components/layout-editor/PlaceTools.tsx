import { ClipboardCopy, ClipboardPaste, Paintbrush, Undo2 } from 'lucide-react'
import {
  createContext,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { toast } from 'sonner'
import type { LayoutBundle, LayoutOp } from '../../lib/layout-ops'
import { cn, titleCase } from '../../lib/utils'
import { type DesignTarget, targetKey } from './design-context'
import { looksLikeFieldList, placeListPlan } from './field-list'
import { type Look, lookFrom, paintBlocked, paintPlan } from './format-painter'
import { isTyping } from './is-typing'
import {
  CLIP_STORAGE_KEY,
  type LayoutClip,
  makeClip,
  parseClip,
  pastePlan,
  serializeClip
} from './place-clip'
import { revertPlan } from './revert-element'
import { MenuItem, type StructureMenuExtra } from './StructureMenu'
import { isMacLike, registerShortcut } from './shortcuts'
import type { StructurePlan } from './structure-ops'
import type { ApplyOptions } from './useLayoutDraft'

// The placing tools mounted once by the editor (#3179 #3197 #3201 #3202):
// ⌘C / ⌘V a field or section between forms of a collection, a pasted list of
// field names placed in order, the format painter, and "put back as saved"
// on one field or section — on the keyboard, in the canvas menu and (put
// back) in the inspector. Every change is one draft.apply: one undo step.

registerShortcut({
  id: 'copy-piece',
  area: 'Editing',
  keys: [['mod', 'c']],
  label: 'Copy the selected field or section (paste it on any form of this collection)'
})
registerShortcut({
  id: 'paste-piece',
  area: 'Editing',
  keys: [['mod', 'v']],
  label: 'Paste after the selection: a copied field or section, or a list of field names'
})
registerShortcut({
  id: 'copy-look',
  area: 'Editing',
  keys: [['alt', 'mod', 'c']],
  label: 'Copy the selected field’s look and rules'
})
registerShortcut({
  id: 'paste-look',
  area: 'Editing',
  keys: [['alt', 'mod', 'v']],
  label: 'Paint that look onto the selected fields'
})

export interface FieldMeta {
  field: string
  label?: string | null
  type?: string | null
  interface?: string | null
}

export interface PlaceToolsArgs {
  bundle: LayoutBundle | null
  /** The last saved form (the server's copy). */
  savedBundle: LayoutBundle | null
  collection: string
  layoutId: number
  layoutName: string
  fields: FieldMeta[]
  selection: DesignTarget[]
  apply: (ops: LayoutOp[], opts?: ApplyOptions) => void
  onSelection: (next: DesignTarget[]) => void
  rootRef: RefObject<HTMLElement | null>
}

export interface PlaceTools {
  /** The canvas menu rows (StructureActions' extraItems). */
  menuItems: (ctx: StructureMenuExtra) => ReactNode
  /** Put `t` back as saved (or as it was when the form was opened). */
  revertFor: (t: DesignTarget | null) => StructurePlan
  /** Apply a plan: one undo step, select what it says, toast its notes. */
  run: (plan: StructurePlan, opts?: { toastNotes?: boolean }) => boolean
}

const PlaceToolsContext = createContext<PlaceTools | null>(null)
export const PlaceToolsProvider = PlaceToolsContext.Provider
export const usePlaceToolsContext = () => useContext(PlaceToolsContext)

const menuOpen = () =>
  !!document.querySelector('[data-radix-popper-content-wrapper], [role="menu"]')

const keys = (k: string) => (isMacLike() ? `⌘${k}` : `Ctrl+${k}`)
const altKeys = (k: string) => (isMacLike() ? `⌥⌘${k}` : `Ctrl+Alt+${k}`)

function storeClip(clip: LayoutClip) {
  try {
    localStorage.setItem(CLIP_STORAGE_KEY, serializeClip(clip))
  } catch {
    // Private windows and blocked storage: the system clipboard still has it.
  }
}

function storedClip(): LayoutClip | null {
  try {
    return parseClip(localStorage.getItem(CLIP_STORAGE_KEY))
  } catch {
    return null
  }
}

export function usePlaceTools(args: PlaceToolsArgs): PlaceTools {
  const live = useRef(args)
  live.current = args
  const [look, setLook] = useState<(Look & { name: string }) | null>(null)
  const lookRef = useRef(look)
  lookRef.current = look

  // The form as this session first saw it, per layout: the baseline when the
  // saved copy is the same as the draft (autosave on).
  const opened = useRef<Record<number, LayoutBundle>>({})
  const firstSeen = args.savedBundle ?? args.bundle
  if (firstSeen && !opened.current[args.layoutId]) opened.current[args.layoutId] = firstSeen

  const fieldLabel = useCallback((f: string) => {
    const row = live.current.fields.find((x) => x.field === f)
    return row?.label || titleCase(f)
  }, [])
  const sameKind = useCallback((a: string, b: string) => {
    const fs = live.current.fields
    const x = fs.find((r) => r.field === a)
    const y = fs.find((r) => r.field === b)
    return (
      !!x && !!y && (x.type ?? '') === (y.type ?? '') && (x.interface ?? '') === (y.interface ?? '')
    )
  }, [])

  const run = useCallback((plan: StructurePlan, opts: { toastNotes?: boolean } = {}) => {
    if (!plan.ok) {
      toast(plan.reason)
      return false
    }
    live.current.apply(plan.ops, { label: plan.label })
    if (plan.select) live.current.onSelection([plan.select])
    if (opts.toastNotes !== false)
      toast.success(
        plan.label,
        plan.notes.length ? { description: plan.notes.join('. ') } : undefined
      )
    return true
  }, [])

  const copy = useCallback(
    (targets: DesignTarget[]): LayoutClip | null => {
      const { bundle, collection, layoutId, layoutName } = live.current
      if (!bundle) return null
      const made = makeClip(bundle, targets, { collection, layoutId, layoutName, fieldLabel })
      if (!made.ok) {
        toast(made.reason)
        return null
      }
      storeClip(made.clip)
      toast.success(`Copied ${made.clip.label}`, {
        description: `Paste with ${keys('V')} on this form or another ${titleCase(collection)} form`
      })
      return made.clip
    },
    [fieldLabel]
  )

  const paste = useCallback(
    (text: string | null) => {
      const { bundle, collection, fields, selection } = live.current
      if (!bundle) return false
      const selected = selection.length ? selection[selection.length - 1] : null
      const clip = parseClip(text) ?? (text?.trim() ? null : storedClip())
      if (clip) {
        const known = fields.length ? new Set(fields.map((f) => f.field)) : null
        return run(
          pastePlan(bundle, clip, { collection, knownFields: known, selected, fieldLabel })
        )
      }
      if (text && looksLikeFieldList(text)) {
        const to = selected?.kind === 'header' ? 'header' : 'form'
        return run(placeListPlan(bundle, text, fields, selected, to))
      }
      if (!text?.trim()) toast('Nothing to paste: copy a field or section first')
      return false
    },
    [run, fieldLabel]
  )

  const copyLook = useCallback(
    (t: DesignTarget | null) => {
      const { bundle } = live.current
      const blocked = paintBlocked(t)
      const got = !blocked && bundle && t ? lookFrom(bundle, t) : null
      if (!got || !t || t.kind === 'group') {
        toast(blocked ?? 'Select a field first')
        return
      }
      setLook({ ...got, name: fieldLabel(t.field) })
      toast.success(`Copied the look of ${fieldLabel(t.field)}`, {
        description: `Select other fields and press ${altKeys('V')}, or right-click them`
      })
    },
    [fieldLabel]
  )

  const paintOnto = useCallback(
    (from: Look, targets: DesignTarget[]) => {
      const { bundle } = live.current
      if (!bundle) return false
      return run(paintPlan(bundle, from, targets, { sameKind, fieldLabel }))
    },
    [run, sameKind, fieldLabel]
  )

  const revertFor = useCallback(
    (t: DesignTarget | null): StructurePlan => {
      const { bundle, savedBundle, layoutId } = live.current
      if (!bundle) return { ok: false, reason: 'The form is still loading' }
      const saved = revertPlan(bundle, savedBundle, t, { fieldLabel, baseline: 'saved' })
      if (saved.ok) return saved
      const first = opened.current[layoutId]
      if (first && first !== savedBundle) {
        const back = revertPlan(bundle, first, t, { fieldLabel, baseline: 'opened' })
        if (back.ok) return back
      }
      return saved
    },
    [fieldLabel]
  )

  // ⌘C / ⌘V: the system clipboard events, so a paste needs no permission prompt. Text
  // selected on the page, typing and open menus keep their own copy and paste.
  useEffect(() => {
    const ours = (e: Event) => {
      const root = live.current.rootRef.current
      if (!root?.isConnected || isTyping(e.target) || menuOpen()) return false
      const t = e.target as Node | null
      return !t || t === document.body || t === document.documentElement || root.contains(t)
    }
    const onCopy = (e: ClipboardEvent) => {
      if (!ours(e) || live.current.selection.length === 0) return
      const sel = window.getSelection?.()
      if (sel && !sel.isCollapsed && sel.toString().trim()) return
      const clip = copy(live.current.selection)
      if (!clip) return
      e.preventDefault()
      e.clipboardData?.setData('text/plain', serializeClip(clip))
    }
    const onPaste = (e: ClipboardEvent) => {
      if (!ours(e)) return
      const text = e.clipboardData?.getData('text/plain') ?? null
      const clip = parseClip(text) ?? (text?.trim() ? null : storedClip())
      if (!clip && !(text && looksLikeFieldList(text))) return
      e.preventDefault()
      paste(text)
    }
    document.addEventListener('copy', onCopy)
    document.addEventListener('paste', onPaste)
    return () => {
      document.removeEventListener('copy', onCopy)
      document.removeEventListener('paste', onPaste)
    }
  }, [copy, paste])

  // ⌥⌘C / ⌥⌘V (Ctrl+Alt elsewhere): the format painter. `code`, as ⌥ changes the key's letter.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !e.altKey || e.shiftKey || e.defaultPrevented) return
      if (e.code !== 'KeyC' && e.code !== 'KeyV') return
      const root = live.current.rootRef.current
      if (!root?.isConnected || isTyping(e.target) || menuOpen()) return
      const sel = live.current.selection
      e.preventDefault()
      if (e.code === 'KeyC') {
        if (sel.length !== 1) {
          toast('Select one field to copy its look')
          return
        }
        copyLook(sel[0])
        return
      }
      const from = lookRef.current
      if (!from) {
        toast(`Copy a field’s look first (${altKeys('C')})`)
        return
      }
      paintOnto(from, sel)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [copyLook, paintOnto])

  const menuItems = useCallback(
    (ctx: StructureMenuExtra): ReactNode => (
      <PlaceMenuRows
        ctx={ctx}
        tools={{ copy, paste, copyLook, paintOnto, revertFor }}
        look={lookRef.current}
        bundle={live.current.bundle}
        fieldLabel={fieldLabel}
      />
    ),
    [copy, paste, copyLook, paintOnto, revertFor, fieldLabel]
  )

  return useMemo(() => ({ menuItems, revertFor, run }), [menuItems, revertFor, run])
}

function PlaceMenuRows({
  ctx,
  tools,
  look,
  bundle,
  fieldLabel
}: {
  ctx: StructureMenuExtra
  tools: {
    copy: (t: DesignTarget[]) => LayoutClip | null
    paste: (text: string | null) => boolean
    copyLook: (t: DesignTarget | null) => void
    paintOnto: (from: Look, t: DesignTarget[]) => boolean
    revertFor: (t: DesignTarget | null) => StructurePlan
  }
  look: (Look & { name: string }) | null
  bundle: LayoutBundle | null
  fieldLabel: (f: string) => string
}) {
  const { targets, origin, close, run } = ctx
  const one = targets.length === 1 ? targets[0] : null
  const fieldTargets = targets.filter((t) => t.kind !== 'group' && !t.field.startsWith('__'))
  const revert = one ? tools.revertFor(one) : null
  const others =
    origin && origin.kind !== 'group'
      ? fieldTargets.filter((t) => t !== origin && !sameTarget(t, origin))
      : []
  const originLook = origin && others.length && bundle ? lookFrom(bundle, origin) : null
  const lookTargets = look
    ? fieldTargets.filter(
        (t) => !(t.kind !== 'group' && t.field === look.field && groupOf(t) === look.group_key)
      )
    : []
  const canCopy = targets.some((t) => t.kind !== 'group') || one?.kind === 'group'
  return (
    <>
      <hr className='my-1 h-px border-0 bg-slate-100 dark:bg-border' />
      {canCopy && (
        <MenuItem
          icon={<ClipboardCopy />}
          hint={keys('C')}
          data-place-action='copy'
          onPick={() => {
            const clip = tools.copy(targets)
            if (clip) {
              try {
                void navigator.clipboard?.writeText(serializeClip(clip)).catch(() => {})
              } catch {
                // The stored copy is enough for a paste in this browser.
              }
            }
            close()
          }}
        >
          {one?.kind === 'group'
            ? 'Copy this section'
            : targets.length > 1
              ? `Copy ${targets.length} fields`
              : 'Copy'}
        </MenuItem>
      )}
      <MenuItem
        icon={<ClipboardPaste />}
        hint={keys('V')}
        data-place-action='paste'
        onPick={() => {
          close()
          const read = navigator.clipboard?.readText?.bind(navigator.clipboard)
          if (!read) {
            tools.paste(null)
            return
          }
          read()
            .then((text) => tools.paste(parseClip(text) || looksLikeFieldList(text) ? text : null))
            .catch(() => tools.paste(null))
        }}
      >
        Paste after this
      </MenuItem>
      {one && one.kind !== 'group' && !one.field.startsWith('__') && (
        <MenuItem
          icon={<Paintbrush />}
          hint={altKeys('C')}
          data-place-action='copy-look'
          onPick={() => {
            tools.copyLook(one)
            close()
          }}
        >
          Copy look and rules
        </MenuItem>
      )}
      {originLook && origin && origin.kind !== 'group' && (
        <MenuItem
          icon={<Paintbrush />}
          data-place-action='paint-from-origin'
          onPick={() => {
            if (tools.paintOnto(originLook, others)) close()
          }}
        >
          Give the other {others.length === 1 ? 'field' : `${others.length} fields`} the look of{' '}
          {fieldLabel(origin.field)}
        </MenuItem>
      )}
      {look && lookTargets.length > 0 && (
        <MenuItem
          icon={<Paintbrush />}
          hint={altKeys('V')}
          data-place-action='paint'
          onPick={() => {
            if (tools.paintOnto(look, lookTargets)) close()
          }}
        >
          Paint the look of {look.name} onto{' '}
          {lookTargets.length === 1 ? 'this' : `these ${lookTargets.length}`}
        </MenuItem>
      )}
      {one && revert && (
        <MenuItem
          icon={<Undo2 />}
          blocked={revert.ok ? null : revert.reason}
          data-place-action='revert'
          onPick={() => {
            if (revert.ok) run(revert, { toastNotes: true })
          }}
        >
          {revert.ok ? revert.label : 'Put back as saved'}
        </MenuItem>
      )}
    </>
  )
}

const groupOf = (t: DesignTarget) =>
  t.kind === 'group' ? null : t.kind === 'header' ? '__header__' : t.group_key

function sameTarget(a: DesignTarget, b: DesignTarget) {
  if (a.kind === 'group' || b.kind === 'group')
    return a.kind === b.kind && a.kind === 'group' && b.kind === 'group' && a.key === b.key
  return a.kind === b.kind && a.field === b.field && groupOf(a) === groupOf(b)
}

/**
 * The inspector's "Put back as saved" (#3197): shown only while the field or
 * section differs from the saved form (or from how this session opened it).
 */
export function RevertInline({
  target,
  bundle,
  className
}: {
  target: DesignTarget
  /** The draft the inspector shows: the plan is worked out again when it changes. */
  bundle: LayoutBundle
  className?: string
}) {
  const tools = usePlaceToolsContext()
  const key = targetKey(target)
  // biome-ignore lint/correctness/useExhaustiveDependencies: key stands for target; bundle re-runs it
  const plan = useMemo(() => tools?.revertFor(target) ?? null, [tools, bundle, key])
  if (!plan?.ok) return null
  return (
    <button
      type='button'
      data-revert-element=''
      data-tip={
        plan.notes[0] ?? 'Only this changes; the rest of the form stays as it is. Undo with ⌘Z.'
      }
      onClick={() => tools?.run(plan)}
      className={cn(
        'inline-flex h-7 max-w-full items-center gap-1.5 rounded-md border border-slate-200 px-2 text-[12px] font-medium text-slate-700 transition-colors hover:bg-slate-50 dark:border-border dark:text-foreground dark:hover:bg-muted',
        className
      )}
    >
      <Undo2 className='h-3.5 w-3.5 shrink-0 text-slate-500 dark:text-muted-foreground' />
      <span className='truncate'>{plan.label}</span>
    </button>
  )
}
