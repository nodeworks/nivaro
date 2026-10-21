import {
  ArrowLeft,
  ClipboardCopy,
  Columns3,
  CopyPlus,
  Group,
  Merge,
  Pin,
  PinOff,
  Shuffle,
  SquareSplitVertical,
  Ungroup
} from 'lucide-react'
import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { toast } from 'sonner'
import { stickyGroupKey } from '../../lib/form-structure'
import {
  type GroupRow,
  isCanvasSlot,
  type LayoutBundle,
  type LayoutOp,
  UNGROUPED_KEY
} from '../../lib/layout-ops'
import { cn, titleCase } from '../../lib/utils'
import { Checkbox } from '../ui/checkbox'
import { Popover, PopoverAnchor, PopoverContent } from '../ui/popover'
import { duplicateKeys, STRUCTURE_MENU_EVENT } from './ArrangeButton'
import type { DesignMark, DesignTarget } from './design-context'
import { readOverrides } from './inspector/model'
import { isTyping } from './is-typing'
import {
  joinBlocked,
  joinPlan,
  joinTarget,
  rowBlocked,
  rowPlan,
  splitBlocked,
  splitPlan
} from './section-structure'
import { effectText, tintCard } from './panel-style'
import {
  convertChoices,
  copyRulesPlan,
  duplicateBlocked,
  duplicatePlan,
  groupName,
  isPinned,
  kindWord,
  pinPlan,
  RULE_LABELS,
  type RuleKey,
  ruleSet,
  rulesOf,
  ruleTargets,
  type StructurePlan,
  unwrapBlocked,
  unwrapPlan,
  wrapPlan
} from './structure-ops'
import type { ApplyOptions } from './useLayoutDraft'

export { ArrangeButton, openStructureMenu } from './ArrangeButton'

// The canvas menu (#2623 #2624 #2625 #2628 #2643 #2696 #2697): right-click (or the
// context-menu key) on a canvas node, or a section's Arrange button in the
// inspector, opens one anchored menu — Duplicate, Wrap / Unwrap, Convert,
// Copy rules, Pin. ⌘D / Ctrl+D duplicates the selection. Every action is one
// draft.apply: one undo step.

/** `targetKey` read back: `group:k`, `field:f:g`, `slot:f:g`, `header:f`. */
export function parseTargetKey(key: string | null): DesignTarget | null {
  if (!key) return null
  const at = key.indexOf(':')
  const kind = key.slice(0, at)
  const rest = key.slice(at + 1)
  if (kind === 'group') return { kind: 'group', key: rest }
  if (kind === 'header') return { kind: 'header', field: rest }
  if (kind !== 'field' && kind !== 'slot') return null
  const cut = rest.lastIndexOf(':')
  const group = rest.slice(cut + 1)
  return { kind, field: rest.slice(0, cut), group_key: group === '' ? null : group }
}

type Measurable = { getBoundingClientRect(): DOMRect }
type View = 'menu' | 'convert' | 'rules'
interface MenuState {
  targets: DesignTarget[]
  anchor: Measurable
  view: View
}

const pointAnchor = (x: number, y: number): Measurable => ({
  getBoundingClientRect: () => new DOMRect(x, y, 0, 0)
})

/** "Pinned" on a pinned section, beside the preview modes' own tags. */
export function usePinMarks(
  bundle: LayoutBundle,
  marks?: (t: DesignTarget) => DesignMark[]
): (t: DesignTarget) => DesignMark[] {
  return useMemo(() => {
    const pinned = new Set(bundle.groups.filter((g) => isPinned(g)).map((g) => g.key))
    const sticky = stickyGroupKey(
      [...bundle.groups].filter((g) => g.parent_key === null).sort((a, b) => a.sort - b.sort)
    )
    return (t: DesignTarget) => {
      const own = marks?.(t) ?? []
      if (t.kind !== 'group') return own
      // #2699: the form's one sticky section says so on the canvas (it does not stick there).
      const withSticky: DesignMark[] =
        t.key === sticky
          ? [
              ...own,
              {
                text: 'Sticks to the top',
                tone: 'slate',
                tip: 'People see this section stay at the top of the form while they scroll the rest (not on phones).'
              }
            ]
          : own
      if (!pinned.has(t.key)) return withSticky
      return [
        ...withSticky,
        {
          text: 'Pinned',
          tone: 'slate',
          icon: 'pin',
          tip: 'Pinned in the editor: it does not drag and takes no drops. The form people see is unchanged.'
        }
      ]
    }
  }, [bundle.groups, marks])
}

export interface StructureActionsProps {
  bundle: LayoutBundle | null
  selection: DesignTarget[]
  apply: (ops: LayoutOp[], opts?: ApplyOptions) => void
  onSelection: (next: DesignTarget[]) => void
  /** The editor's body: right-clicks and Arrange buttons inside it open the menu. */
  rootRef: RefObject<HTMLElement | null>
}

/**
 * Mounted once by the editor: the ⌘D keys, the canvas context menu and the
 * menu the inspector's Arrange buttons open.
 */
export function StructureActions({
  bundle,
  selection,
  apply,
  onSelection,
  rootRef
}: StructureActionsProps) {
  const [menu, setMenu] = useState<MenuState | null>(null)
  const live = useRef({ bundle, selection, apply, onSelection })
  live.current = { bundle, selection, apply, onSelection }

  const run = useCallback((plan: StructurePlan, opts: { toastNotes?: boolean } = {}) => {
    if (!plan.ok) {
      toast(plan.reason)
      return false
    }
    live.current.apply(plan.ops, { label: plan.label })
    if (plan.select) live.current.onSelection([plan.select])
    if (opts.toastNotes && plan.notes.length)
      toast.success(plan.label, { description: plan.notes.join('. ') })
    setMenu(null)
    return true
  }, [])

  // ⌘D / Ctrl+D: duplicate the one selected section. Never while typing or with a menu open.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'd') return
      const { bundle: b, selection: sel } = live.current
      if (!b || sel.length === 0 || isTyping(e.target) || e.defaultPrevented) return
      if (document.querySelector('[data-radix-popper-content-wrapper], [role="menu"]')) return
      e.preventDefault()
      if (sel.length > 1) {
        toast('Duplicate works on one section at a time')
        return
      }
      run(duplicatePlan(b, sel[0]), { toastNotes: true })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [run])

  // Right-click (or the context-menu key) on a canvas node, and Arrange buttons.
  useEffect(() => {
    const inside = (el: Element | null) => !!el && !!rootRef.current?.contains(el)
    const onContext = (e: MouseEvent) => {
      const el = (e.target as Element | null)?.closest?.('[data-design-target]') ?? null
      if (!inside(el) || !el?.closest('[data-design-canvas]') || !live.current.bundle) return
      const t = parseTargetKey(el.getAttribute('data-design-target'))
      if (!t) return
      e.preventDefault()
      const sel = live.current.selection
      const key = el.getAttribute('data-design-target')
      const inSelection = sel.some((s) => targetKeyOf(s) === key)
      const targets = inSelection && sel.length > 1 ? sel : [t]
      if (!inSelection || sel.length <= 1) live.current.onSelection([t])
      // The keyboard's context-menu key has no pointer position: anchor on the node.
      const keyboard = e.button !== 2 && e.clientX === 0 && e.clientY === 0
      setMenu({
        targets,
        anchor: keyboard ? (el as HTMLElement) : pointAnchor(e.clientX, e.clientY),
        view: 'menu'
      })
    }
    const onOpen = (e: Event) => {
      const el = e.target as HTMLElement
      if (!inside(el)) return
      const detail = (e as CustomEvent<{ targets: DesignTarget[]; view?: View }>).detail
      setMenu({ targets: detail.targets, anchor: el, view: detail.view ?? 'menu' })
    }
    document.addEventListener('contextmenu', onContext, true)
    document.addEventListener(STRUCTURE_MENU_EVENT, onOpen)
    return () => {
      document.removeEventListener('contextmenu', onContext, true)
      document.removeEventListener(STRUCTURE_MENU_EVENT, onOpen)
    }
  }, [rootRef])

  const anchorRef = useMemo(() => ({ current: menu?.anchor ?? null }), [menu])
  if (!menu || !bundle) return null
  return (
    <Popover open onOpenChange={(open) => !open && setMenu(null)}>
      <PopoverAnchor virtualRef={anchorRef as { current: Measurable }} />
      <PopoverContent
        align='start'
        className='w-[300px] p-1.5'
        data-structure-menu={menu.view}
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          ;(e.currentTarget as HTMLElement | null)
            ?.querySelector<HTMLElement>(
              '[role="menuitem"]:not([aria-disabled="true"]), input, button'
            )
            ?.focus()
        }}
      >
        {menu.view === 'convert' && menu.targets[0]?.kind === 'group' ? (
          <ConvertView
            bundle={bundle}
            groupKey={menu.targets[0].key}
            onBack={() => setMenu({ ...menu, view: 'menu' })}
            run={run}
          />
        ) : menu.view === 'rules' && menu.targets[0]?.kind === 'group' ? (
          <RulesView
            bundle={bundle}
            groupKey={menu.targets[0].key}
            onBack={() => setMenu({ ...menu, view: 'menu' })}
            run={run}
          />
        ) : (
          <MenuView
            bundle={bundle}
            targets={menu.targets}
            run={run}
            onView={(view) => setMenu({ ...menu, view })}
          />
        )}
      </PopoverContent>
    </Popover>
  )
}

/** A field's label on this form, for a new row's label: its override, else its name. */
const labelIn = (bundle: LayoutBundle) => (field: string) => {
  const p = bundle.placements.find((x) => x.field === field)
  const ov = readOverrides(p).label
  return (typeof ov === 'string' && ov) || p?.label_override || titleCase(field)
}

function targetKeyOf(t: DesignTarget): string {
  if (t.kind === 'group') return `group:${t.key}`
  if (t.kind === 'header') return `header:${t.field}`
  return `${t.kind}:${t.field}:${t.group_key ?? ''}`
}

const itemCls =
  'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12.5px] text-slate-700 outline-none transition-colors hover:bg-muted focus-visible:bg-muted dark:text-foreground aria-disabled:cursor-not-allowed aria-disabled:opacity-45 aria-disabled:hover:bg-transparent'

function MenuItem({
  icon,
  children,
  hint,
  blocked,
  onPick,
  ...rest
}: {
  icon: ReactNode
  children: ReactNode
  hint?: string
  /** Why it cannot run: shown as the row's tip; the row does nothing. */
  blocked?: string | null
  onPick: () => void
  [attr: `data-${string}`]: unknown
}) {
  return (
    <button
      type='button'
      role='menuitem'
      aria-disabled={blocked ? true : undefined}
      data-tip={blocked ?? undefined}
      onClick={() => {
        if (!blocked) onPick()
      }}
      className={itemCls}
      {...rest}
    >
      <span className='flex h-4 w-4 shrink-0 items-center justify-center text-slate-500 dark:text-muted-foreground [&_svg]:h-3.5 [&_svg]:w-3.5'>
        {icon}
      </span>
      <span className='min-w-0 flex-1 truncate'>{children}</span>
      {hint && (
        <kbd className='shrink-0 font-sans text-[11px] text-slate-400 dark:text-muted-foreground'>
          {hint}
        </kbd>
      )}
    </button>
  )
}

/** Up / Down move between rows, Home / End jump (the menu's own keyboard). */
function menuKeys(e: KeyboardEvent<HTMLElement>) {
  const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End']
  if (!keys.includes(e.key)) return
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]'))
  if (items.length === 0) return
  e.preventDefault()
  const i = items.indexOf(document.activeElement as HTMLElement)
  const to =
    e.key === 'Home'
      ? 0
      : e.key === 'End'
        ? items.length - 1
        : (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
  items[to]?.focus()
}

function MenuView({
  bundle,
  targets,
  run,
  onView
}: {
  bundle: LayoutBundle
  targets: DesignTarget[]
  run: (plan: StructurePlan, opts?: { toastNotes?: boolean }) => boolean
  onView: (v: View) => void
}) {
  const one = targets.length === 1 ? targets[0] : null
  const group =
    one?.kind === 'group' && one.key !== UNGROUPED_KEY
      ? (bundle.groups.find((g) => g.key === one.key) ?? null)
      : null
  const fieldTargets = targets.filter(
    (t) => (t.kind === 'field' || t.kind === 'slot') && !isCanvasSlot(t)
  )
  const wrap = fieldTargets.length ? wrapPlan(bundle, fieldTargets) : null
  const dupBlocked = one
    ? duplicateBlocked(bundle, one)
    : 'Duplicate works on one section at a time'
  const title = group
    ? `${groupName(group)} · ${kindWord(bundle, group)}`
    : fieldTargets.length > 1
      ? `${fieldTargets.length} selected`
      : null

  return (
    <div role='menu' aria-label='Arrange' onKeyDown={menuKeys} className='flex flex-col'>
      {title && <p className={cn(effectText, 'truncate px-2 pb-1 pt-0.5')}>{title}</p>}
      <MenuItem
        icon={<CopyPlus />}
        hint={duplicateKeys()}
        blocked={dupBlocked}
        data-structure-action='duplicate'
        onPick={() => run(duplicatePlan(bundle, one), { toastNotes: true })}
      >
        Duplicate
      </MenuItem>
      {wrap && (
        <MenuItem
          icon={<Group />}
          blocked={wrap.ok ? null : wrap.reason}
          data-structure-action='wrap'
          onPick={() => run(wrap)}
        >
          {wrap.ok ? wrap.label.replace(/^Wrap \d+ fields?/, 'Wrap') : 'Wrap in a new section'}
        </MenuItem>
      )}
      {one && (one.kind === 'field' || one.kind === 'slot') && one.group_key !== null && (
        <MenuItem
          icon={<SquareSplitVertical />}
          blocked={splitBlocked(bundle, one)}
          data-structure-action='split'
          onPick={() => run(splitPlan(bundle, one), { toastNotes: true })}
        >
          Split the section here
        </MenuItem>
      )}
      {fieldTargets.length > 1 && (
        <MenuItem
          icon={<Columns3 />}
          blocked={rowBlocked(bundle, fieldTargets)}
          data-structure-action='row'
          onPick={() => run(rowPlan(bundle, fieldTargets, labelIn(bundle)), { toastNotes: true })}
        >
          Put side by side under one label
        </MenuItem>
      )}
      {group && (
        <>
          <MenuItem
            icon={<Merge />}
            blocked={joinBlocked(bundle, group.key)}
            data-structure-action='join'
            onPick={() => run(joinPlan(bundle, group.key), { toastNotes: true })}
          >
            {(() => {
              const next = joinTarget(bundle, group.key)
              return next ? `Join with ${groupName(next)}` : 'Join with the next section'
            })()}
          </MenuItem>
          <MenuItem
            icon={<Ungroup />}
            blocked={unwrapBlocked(bundle, group.key)}
            data-structure-action='unwrap'
            onPick={() => run(unwrapPlan(bundle, group.key), { toastNotes: true })}
          >
            Unwrap: keep its fields, drop the {kindWord(bundle, group)}
          </MenuItem>
          <MenuItem
            icon={<Shuffle />}
            blocked={
              convertChoices(bundle, group.key).length
                ? null
                : 'Only sections, tabs, steps and their holders convert'
            }
            data-structure-action='convert'
            onPick={() => onView('convert')}
          >
            Convert to…
          </MenuItem>
          <MenuItem
            icon={<ClipboardCopy />}
            blocked={
              rulesOf(group).length ? null : 'Only sections, tabs and steps have these rules'
            }
            data-structure-action='rules'
            onPick={() => onView('rules')}
          >
            Copy rules to other sections…
          </MenuItem>
          <MenuItem
            icon={isPinned(group) ? <PinOff /> : <Pin />}
            data-structure-action='pin'
            onPick={() => run(pinPlan(bundle, group.key, !isPinned(group)))}
          >
            {isPinned(group) ? 'Unpin' : 'Pin in the editor (no dragging)'}
          </MenuItem>
        </>
      )}
      {!group && fieldTargets.length === 0 && (
        <p className={cn(effectText, 'px-2 py-1')}>
          Select a section or fields to duplicate, wrap or convert.
        </p>
      )}
    </div>
  )
}

function ViewHeader({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className='flex items-center gap-1.5 px-1 pb-1.5'>
      <button
        type='button'
        aria-label='Back'
        onClick={onBack}
        className='inline-flex h-6 w-6 items-center justify-center rounded text-slate-500 hover:bg-muted hover:text-slate-900 dark:text-muted-foreground dark:hover:text-foreground'
      >
        <ArrowLeft className='h-3.5 w-3.5' />
      </button>
      <p className='min-w-0 flex-1 truncate text-[13px] font-semibold text-slate-900 dark:text-foreground'>
        {title}
      </p>
    </div>
  )
}

const applyCls =
  'inline-flex h-7 shrink-0 items-center rounded-md bg-nvr-cyan px-3 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:pointer-events-none disabled:opacity-40'

function Notes({ notes }: { notes: string[] }) {
  if (notes.length === 0) return null
  return (
    <ul className='mt-1 list-disc space-y-0.5 pl-4 text-[12px] leading-snug text-slate-600 dark:text-muted-foreground'>
      {notes.map((n) => (
        <li key={n}>{n}</li>
      ))}
    </ul>
  )
}

/** Convert (#2625): every way the group can turn, with what each would change. */
function ConvertView({
  bundle,
  groupKey,
  onBack,
  run
}: {
  bundle: LayoutBundle
  groupKey: string
  onBack: () => void
  run: (plan: StructurePlan) => boolean
}) {
  const group = bundle.groups.find((g) => g.key === groupKey)
  const choices = useMemo(() => convertChoices(bundle, groupKey), [bundle, groupKey])
  if (!group) return <ViewHeader title='That section is no longer here' onBack={onBack} />
  return (
    <div data-structure-convert='' className='flex flex-col'>
      <ViewHeader title={`Convert ${groupName(group)}`} onBack={onBack} />
      <div className='space-y-1.5'>
        {choices.map((c) => (
          <div key={c.to} data-convert-choice={c.to} className={cn(tintCard, 'p-2.5')}>
            <div className='flex items-center gap-2'>
              <p className='min-w-0 flex-1 text-[12.5px] font-medium text-slate-900 dark:text-foreground'>
                {c.title}
              </p>
              <button
                type='button'
                disabled={!c.plan.ok}
                onClick={() => run(c.plan)}
                className={applyCls}
              >
                Convert
              </button>
            </div>
            {c.plan.ok ? (
              <Notes notes={c.plan.notes} />
            ) : (
              <p className='mt-1 text-[12px] leading-snug text-amber-700 dark:text-amber-300'>
                {c.plan.reason}
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

const ruleValue = (g: GroupRow, k: RuleKey): string => {
  if (!ruleSet(g, k)) return 'none: clears it'
  try {
    const n = (JSON.parse(String(g[k])) as unknown[]).length
    return k === 'visible_when'
      ? `${n} condition${n === 1 ? '' : 's'}`
      : `${n} role${n === 1 ? '' : 's'}`
  } catch {
    return 'set'
  }
}

const checkCls =
  'h-4 w-4 rounded border-slate-300 data-[state=checked]:border-nvr-cyan data-[state=checked]:bg-nvr-cyan data-[state=checked]:text-white dark:border-slate-600 [&_svg]:h-3 [&_svg]:w-3'

/** Copy rules (#2643): pick the rules and the sections; preview; one batch. */
function RulesView({
  bundle,
  groupKey,
  onBack,
  run
}: {
  bundle: LayoutBundle
  groupKey: string
  onBack: () => void
  run: (plan: StructurePlan) => boolean
}) {
  const group = bundle.groups.find((g) => g.key === groupKey)
  const available = group ? rulesOf(group) : []
  const [rules, setRules] = useState<RuleKey[]>(() => {
    const set = group ? available.filter((k) => ruleSet(group, k)) : []
    return set.length ? set : available
  })
  const targets = useMemo(() => ruleTargets(bundle, groupKey), [bundle, groupKey])
  const [picked, setPicked] = useState<string[]>([])
  const plan = useMemo(
    () => copyRulesPlan(bundle, groupKey, picked, rules),
    [bundle, groupKey, picked, rules]
  )
  if (!group) return <ViewHeader title='That section is no longer here' onBack={onBack} />
  const toggle = <T,>(list: T[], v: T) =>
    list.includes(v) ? list.filter((x) => x !== v) : [...list, v]
  const all = picked.length === targets.length && targets.length > 0
  return (
    <div data-structure-rules='' className='flex flex-col'>
      <ViewHeader title={`Copy the rules of ${groupName(group)}`} onBack={onBack} />
      <fieldset className='m-0 min-w-0 border-0 p-0 px-1'>
        <legend className='pb-1 text-[12px] font-medium text-slate-700 dark:text-foreground'>
          Rules
        </legend>
        {available.map((k) => (
          // biome-ignore lint/a11y/noLabelWithoutControl: the Radix checkbox is the control
          <label key={k} className='flex items-center gap-2 py-0.5 text-[12.5px]'>
            <Checkbox
              checked={rules.includes(k)}
              onCheckedChange={() => setRules((r) => toggle(r, k))}
              className={checkCls}
            />
            <span className='min-w-0 flex-1 truncate text-slate-800 dark:text-foreground'>
              {RULE_LABELS[k]}
            </span>
            <span className='shrink-0 text-[11.5px] text-slate-500 dark:text-muted-foreground'>
              {ruleValue(group, k)}
            </span>
          </label>
        ))}
      </fieldset>
      <fieldset className='m-0 mt-2 min-w-0 border-0 p-0 px-1'>
        <div className='flex items-center pb-1'>
          <legend className='flex-1 text-[12px] font-medium text-slate-700 dark:text-foreground'>
            Onto
          </legend>
          <button
            type='button'
            onClick={() => setPicked(all ? [] : targets.map((t) => t.key))}
            className='text-[12px] font-medium text-sky-700 hover:underline dark:text-nvr-cyan'
          >
            {all ? 'None' : 'All'}
          </button>
        </div>
        <div className='max-h-[200px] overflow-y-auto'>
          {targets.length === 0 && <p className={effectText}>No other sections on this form.</p>}
          {targets.map((t) => (
            // biome-ignore lint/a11y/noLabelWithoutControl: the Radix checkbox is the control
            <label
              key={t.key}
              data-rules-target={t.key}
              className='flex items-center gap-2 py-0.5 text-[12.5px]'
            >
              <Checkbox
                checked={picked.includes(t.key)}
                onCheckedChange={() => setPicked((p) => toggle(p, t.key))}
                className={checkCls}
              />
              <span className='min-w-0 flex-1 truncate text-slate-800 dark:text-foreground'>
                {groupName(t)}
              </span>
              <span className='shrink-0 text-[11.5px] text-slate-500 dark:text-muted-foreground'>
                {kindWord(bundle, t)}
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className='mt-2 border-t border-slate-100 px-1 pt-2 dark:border-border'>
        {plan.ok ? (
          <Notes notes={plan.notes} />
        ) : (
          picked.length > 0 && <p className={effectText}>{plan.reason}</p>
        )}
        <div className='mt-2 flex justify-end'>
          <button
            type='button'
            disabled={!plan.ok}
            data-rules-apply=''
            onClick={() => run(plan)}
            className={applyCls}
          >
            {plan.ok ? `Copy to ${plan.ops.length}` : 'Copy'}
          </button>
        </div>
      </div>
    </div>
  )
}
