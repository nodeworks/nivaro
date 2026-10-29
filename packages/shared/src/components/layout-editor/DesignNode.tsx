import { EyeOff, Link2, Lock, Pin, UserRound } from 'lucide-react'
import {
  type CSSProperties,
  cloneElement,
  Fragment,
  isValidElement,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  type Ref
} from 'react'
import { cn, formatRelative } from '../../lib/utils'
import type { DesignMark, DesignTarget, DiffMark, LayoutDesign } from './design-context'
import { isSelectedIn, targetKey, useLayoutDesign } from './design-context'
import { NO_DND, useDesignDndNode, useDesignDropBody } from './dnd/node'
import { ResizeHandle } from './grid-guides'
import { NoteMarker } from './NoteMarker'
import { FillChip } from './usage/FillChip'

type ChildProps = {
  className?: string
  style?: CSSProperties
  ref?: Ref<unknown>
  children?: ReactNode
}
type Props = Record<string, unknown>

const assignRef = (ref: unknown, el: unknown) => {
  if (typeof ref === 'function') ref(el)
  else if (ref && typeof ref === 'object') (ref as { current: unknown }).current = el
}

/**
 * Merge prop sets left to right: classes join, styles merge, refs and
 * handlers (`on…`) both run — so the dnd props, the shell's own and the
 * child's own (asChild) never override one another.
 */
function mergeProps(...sets: Props[]): Props {
  const out: Props = {}
  for (const set of sets) {
    for (const [k, v] of Object.entries(set)) {
      const cur = out[k]
      if (v === undefined) continue
      if (cur === undefined) out[k] = v
      else if (k === 'className') out[k] = `${cur} ${v}`
      else if (k === 'style') out[k] = { ...(cur as object), ...(v as object) }
      else if (k === 'ref')
        out[k] = (el: unknown) => {
          assignRef(cur, el)
          assignRef(v, el)
        }
      else if (/^on[A-Z]/.test(k) && typeof cur === 'function' && typeof v === 'function')
        out[k] = (...a: unknown[]) => {
          ;(cur as (...x: unknown[]) => void)(...a)
          ;(v as (...x: unknown[]) => void)(...a)
        }
      else out[k] = v
    }
  }
  return out
}

const MARK_TONE: Record<DesignMark['tone'], string> = {
  violet:
    'bg-violet-50 text-violet-800 ring-violet-200 dark:bg-violet-500/15 dark:text-violet-200 dark:ring-violet-500/30',
  emerald:
    'bg-emerald-50 text-emerald-800 ring-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-200 dark:ring-emerald-500/30',
  amber:
    'bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-500/15 dark:text-amber-200 dark:ring-amber-500/30',
  slate:
    'bg-slate-100 text-slate-700 ring-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:ring-slate-700'
}

// One look for every tag on a node; long rule sentences cut off (the tip has them whole).
const MARK_CLS = 'inline-block max-w-[260px] truncate rounded px-1 text-left text-[11px] ring-1'

// Hovering a field that drives others (#2641, explain/driver-hover.ts): what
// it controls gets a dashed amber ring; the field itself a "Controls n" tag
// (bottom right: top left sat on the label, top right is the tag row; an
// opaque fill in dark too, as it sits on the field's border).
const DRIVER_CLS = [
  'data-[rule-dependent]:outline-dashed data-[rule-dependent]:outline-2 data-[rule-dependent]:outline-amber-400 dark:data-[rule-dependent]:outline-amber-400/80',
  'data-[rule-drives]:after:pointer-events-none data-[rule-drives]:after:absolute data-[rule-drives]:after:-bottom-2 data-[rule-drives]:after:right-1 data-[rule-drives]:after:z-10 data-[rule-drives]:after:rounded data-[rule-drives]:after:bg-amber-50 data-[rule-drives]:after:px-1 data-[rule-drives]:after:text-[11px] data-[rule-drives]:after:text-amber-800 data-[rule-drives]:after:ring-1 data-[rule-drives]:after:ring-amber-200 data-[rule-drives]:after:content-[attr(data-rule-drives)] dark:data-[rule-drives]:after:bg-[#413727] dark:data-[rule-drives]:after:text-amber-200 dark:data-[rule-drives]:after:ring-amber-500/30'
].join(' ')

// Without a provider-measured spot: a full-width line just above / below.
const FALLBACK_INDICATOR: Record<'before' | 'after', CSSProperties> = {
  before: { top: -5, left: 0, right: 0, height: 3 },
  after: { bottom: -5, left: 0, right: 0, height: 3 }
}

export interface DesignNodeOptions {
  /** Inline content (inside a p/span): the shell is a span, not a div. */
  inline?: boolean
  /** Put the shell's attributes on the single child element instead of
   *  wrapping it — grid cells keep their col-span, header tiles their place
   *  in the measured row. */
  asChild?: boolean
  /** A click selects AND reaches the element (tab buttons switch tabs). */
  pass?: boolean
}

export function DesignNode({
  target,
  children,
  inline,
  asChild,
  pass,
  ...rest
}: DesignNodeOptions & {
  target: DesignTarget
  children: ReactNode
  /** Anything else (e.g. HeaderTiles' data-header-cell) lands on the element. */
  [attr: `data-${string}` | `aria-${string}`]: unknown
}) {
  const design = useLayoutDesign()
  const parent = design?.inheritedFrom(target) ?? null
  // The folded copy of a header tile (HeaderTiles) selects but never drags:
  // one draggable per target. A folded tile in the row is out of sight: no
  // drop target.
  const copy = rest['data-design-copy'] !== undefined
  const folded = rest['data-header-folded'] !== undefined
  // A removed node shown by a comparison is a ghost: it is not on the layout.
  const diff = design?.diffMark?.(target) ?? null
  const ghost = diff?.kind === 'removed'
  const locked = !design || !!parent || copy || ghost || !!design.locked?.(target)
  // Always called, design or not: the hooks never change between renders.
  const nd = useDesignDndNode(design?.dnd ?? NO_DND, target, { disabled: locked, noDrop: folded })
  if (!design) return <>{children}</>

  const key = targetKey(target)
  const selected = isSelectedIn(design, target)
  const mark = design.roleMark?.(target) ?? null
  const extra = design.marks?.(target) ?? []
  const overlay = design.overlay?.(target) ?? null
  const unsaved = design.unsaved?.(target) ?? false
  const peers = design.peers?.(target) ?? []
  const highlight = extra.some((m) => m.highlight)
  const note = design.note?.(target) ?? null
  const noteMarker = note ? <NoteMarker note={note} /> : null
  const dragProps = (locked ? {} : nd.props) as Props
  const dragging = nd.dragging
  const slot = locked ? null : nd.slot

  const child = asChild && isValidElement(children) ? (children as ReactElement<ChildProps>) : null
  const childCls = child?.props.className ?? ''
  // A child that positions itself (an absolutely placed step, a tile) keeps
  // its own position — `relative` would override it.
  const positioned = /(^|\s)(absolute|fixed|sticky|relative)(\s|$)/.test(childCls)
  const cls = cn(
    !positioned && 'relative',
    'cursor-pointer rounded-md outline-offset-2',
    !child && (inline ? 'inline-block' : 'block'),
    selected
      ? 'outline outline-2 outline-nvr-cyan'
      : peers.length > 0
        ? `outline outline-2 ${peers[0].outline}`
        : highlight
          ? 'outline-dashed outline-2 outline-violet-400 dark:outline-violet-400/70'
          : 'hover:outline hover:outline-1 hover:outline-slate-300 dark:hover:outline-slate-600',
    overlay?.className,
    'focus-visible:outline focus-visible:outline-2 focus-visible:outline-nvr-cyan',
    DRIVER_CLS,
    // The section's "Changed by" shows while the pointer is over it.
    '[&:hover>[data-design-last-change]]:visible',
    dragging && 'opacity-40',
    // Hidden for the previewed role: faint, its tags not.
    mark?.kind === 'hidden' && '[&>:not([data-design-badges])]:opacity-40',
    diff && DIFF_RING[diff.kind],
    ghost && 'cursor-default [&>:not([data-design-badges])]:opacity-40'
  )

  // Capture phase, so nothing inside (inputs, buttons, links) acts on the
  // click: the innermost shell under the pointer selects and swallows it.
  // Outer shells step aside. Elements marked data-design-pass (tab buttons,
  // a section's collapse chevron) still get the click after selection.
  const onClickCapture = (e: MouseEvent<HTMLElement>) => {
    const t = e.target as Element
    if (t.closest('[data-design-target]') !== e.currentTarget) return
    if (ghost) {
      e.preventDefault()
      e.stopPropagation()
      return
    }
    // Shift / ⌘ / Ctrl-click adds to the selection (several fields at once).
    if (e.shiftKey || e.metaKey || e.ctrlKey) design.onSelect(target, { additive: true })
    else design.onSelect(target)
    const through = t.closest('[data-design-pass]')
    if (through && e.currentTarget.contains(through)) return
    e.preventDefault()
    e.stopPropagation()
  }
  // Enter selects from the keyboard too (Space is dnd-kit's pick-up key);
  // only on the node itself, never on a control inside it. A node that IS a
  // native button (a tab or step, asChild) keeps Enter's native click: the
  // click path above selects it and, through data-design-pass, switches to it.
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'Enter' || e.target !== e.currentTarget || ghost) return
    if (e.currentTarget.tagName === 'BUTTON') return
    e.preventDefault()
    if (e.shiftKey) design.onSelect(target, { additive: true })
    else design.onSelect(target)
  }
  // A step or tab button: a chip above it would sit on the step labels.
  const tabLike =
    rest['data-design-tab'] !== undefined ||
    (child?.props as Props | undefined)?.['data-design-tab'] !== undefined
  const own: Props = {
    'data-design-target': key,
    'data-selected': selected ? 'true' : undefined,
    'data-design-pass': pass ? '' : undefined,
    'data-drop-slot': slot ?? undefined,
    'data-role-mark': mark?.kind,
    'data-unsaved': unsaved ? '' : undefined,
    'data-diff': diff?.kind,
    // Locked nodes get no dnd attributes; they still take focus to be selected.
    // So do nodes drag and drop leaves out (a pinned section, #2628).
    ...(locked || !('tabIndex' in dragProps) ? { role: 'button', tabIndex: 0 } : {}),
    ...(tabLike && parent ? { 'data-tip': `From ${parent}` } : {}),
    className: cls,
    onClickCapture,
    onKeyDown
  }
  const MarkIcon = mark?.kind === 'hidden' ? EyeOff : Lock
  const fill =
    target.kind === 'field' || target.kind === 'header'
      ? (design.fillRate?.(target.field) ?? null)
      : null
  // Who last changed a section (#2611): only on the selected section, or while
  // the pointer is over it — never a line on every section.
  const last = target.kind === 'group' && !tabLike ? (design.lastChange?.(target) ?? null) : null
  const lastText = last
    ? [last.by ? `by ${last.by}` : null, last.at ? formatRelative(last.at) : null]
        .filter(Boolean)
        .join(' · ') || null
    : null
  const lastTag =
    lastText && !diff ? (
      <span
        data-design-last-change=''
        className={cn(
          'pointer-events-none absolute -bottom-2 right-1 z-10 rounded bg-white px-1 text-[10.5px] text-slate-500 dark:bg-card dark:text-muted-foreground',
          !selected && 'invisible'
        )}
      >
        Changed {lastText}
      </span>
    ) : null
  // Every tag the node has, ranked; two show, the rest wait behind "+n".
  const chips: BadgeChip[] = []
  if (diff) chips.push({ rank: 0, text: diffText(diff), node: <DiffTag diff={diff} /> })
  if (mark)
    chips.push({
      rank: 1,
      text: `${mark.kind === 'hidden' ? 'Hidden' : 'Read-only'} for ${mark.role}`,
      node: (
        <span
          data-design-role-tag={mark.kind}
          className='inline-flex items-center gap-0.5 rounded bg-amber-50 px-1 text-[11px] text-amber-800 ring-1 ring-amber-200 dark:bg-amber-500/15 dark:text-amber-200 dark:ring-amber-500/30'
        >
          <MarkIcon aria-hidden className='h-3 w-3' />
          {mark.kind === 'hidden' ? 'Hidden' : 'Read-only'} for {mark.role}
        </span>
      )
    })
  if (overlay)
    chips.push({
      rank: 1,
      text: 'Who sees it',
      node: (
        <span data-design-pass='' className='pointer-events-auto'>
          {overlay.chip}
        </span>
      )
    })
  extra.forEach((m, i) => {
    const cls = cn(
      MARK_CLS,
      m.icon && 'inline-flex items-center gap-0.5',
      m.onClick || m.tip ? 'pointer-events-auto' : null,
      m.onClick && 'hover:brightness-95',
      MARK_TONE[m.tone]
    )
    const inner = (
      <>
        {m.icon === 'pin' && <Pin aria-hidden className='h-3 w-3' />}
        {m.icon === 'person' && <UserRound aria-hidden className='h-3 w-3' />}
        {m.icon === 'link' && <Link2 aria-hidden className='h-3 w-3' />}
        {m.text}
      </>
    )
    chips.push({
      rank: markRank(m),
      text: m.text,
      node: m.onClick ? (
        <button
          // biome-ignore lint/suspicious/noArrayIndexKey: two tags may read the same
          key={`${i}:${m.text}`}
          type='button'
          data-design-mark=''
          data-design-pass=''
          data-tip={m.tip}
          onClick={m.onClick}
          className={cls}
        >
          {inner}
        </button>
      ) : (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: two tags may read the same
          key={`${i}:${m.text}`}
          data-design-mark=''
          data-tip={m.tip}
          className={cls}
        >
          {inner}
        </span>
      )
    })
  })
  if (parent)
    chips.push({
      rank: 5,
      text: `from ${parent}`,
      node: (
        <span className='rounded bg-slate-100 px-1 text-[11px] text-slate-600 dark:bg-slate-800 dark:text-slate-300'>
          from {parent}
        </span>
      )
    })
  const { shown, rest: moreTags } = rankChips(chips)
  const tags = extra.length > 0 || overlay != null || peers.length > 0
  // Steps clip to their arrow shape, so a chip above one is cut off (and one
  // wider than the step spills over its neighbours): a step or tab gets a dot
  // above its label instead, every tag in its tip.
  const tabTags = tabLike && !diff ? [...chips.map((c) => c.text), ...peers.map((p) => p.name)] : []
  if (tabTags.length > 0)
    own['data-tip'] = parent && !mark && !tags ? `From ${parent}` : tabTags.join(' · ')
  const badge =
    tabLike && diff ? (
      <span data-design-badges='' className='pointer-events-none absolute -top-2 right-0 z-10'>
        <DiffTag diff={diff} />
      </span>
    ) : tabTags.length > 0 ? (
      <span
        data-design-badges=''
        className={cn(
          'pointer-events-none absolute left-1/2 top-1 z-10 h-1.5 w-1.5 -translate-x-1/2 rounded-full',
          parent && !mark && !tags
            ? 'bg-slate-500 dark:bg-slate-400'
            : 'bg-violet-500 dark:bg-violet-400'
        )}
      >
        <span className='sr-only'>{tabTags.join(' · ')}</span>
      </span>
    ) : chips.length > 0 || peers.length > 0 || fill != null ? (
      <span
        data-design-badges=''
        className='pointer-events-none absolute -top-2 right-1 z-10 flex items-center gap-1'
      >
        {fill != null && <FillChip pct={fill} />}
        {shown.map((c, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: ranked tags of one node, rebuilt each render
          <Fragment key={i}>{c.node}</Fragment>
        ))}
        {moreTags.length > 0 && (
          <span
            data-design-more-tags={moreTags.length}
            data-tip={moreTags.map((c) => c.text).join(' · ')}
            className='pointer-events-auto rounded bg-slate-100 px-1 text-[11px] font-medium text-slate-600 ring-1 ring-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700'
          >
            +{moreTags.length}
          </span>
        )}
        {peers.map((p) => (
          <span
            key={p.id}
            data-design-peer={p.id}
            data-tip={p.name}
            className={cn(
              'pointer-events-auto inline-flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-semibold ring-1',
              p.chip
            )}
          >
            {initialsOf(p.name)}
          </span>
        ))}
      </span>
    ) : null
  // Unsaved change (#2629): a dot on the node's corner until Save.
  const dot = unsaved ? (
    <span
      data-unsaved-dot=''
      className={cn(
        'pointer-events-none absolute z-10 h-2 w-2 rounded-full bg-nvr-cyan ring-2 ring-white dark:ring-slate-900',
        // A step clips its corners away: the dot sits inside, before the arrow.
        tabLike ? 'right-4 top-1' : '-left-1 -top-1'
      )}
    >
      <span className='sr-only'>unsaved change</span>
    </span>
  ) : null
  // The insertion line: absolutely placed inside the node, so showing it
  // never moves anything (a border would grow the node and make the drop
  // target jitter under the pointer).
  const indicator = slot ? (
    <span
      aria-hidden
      data-design-drop-indicator={slot}
      className='pointer-events-none absolute z-30 rounded-full bg-nvr-cyan shadow-[0_0_0_2px_#fff] dark:shadow-[0_0_0_2px_#0f172a]'
      style={nd.indicator ?? FALLBACK_INDICATOR[slot]}
    />
  ) : null

  // #2701: a selected field or in-section panel drags its width from its right edge.
  const resize =
    selected &&
    !locked &&
    design.resizeWidth &&
    (target.kind === 'field' || target.kind === 'slot') &&
    target.group_key !== null ? (
      <ResizeHandle onCommit={(span) => design.resizeWidth?.(target, span)} />
    ) : null

  if (child) {
    const { children: inner, ...childOwn } = child.props as Props & { children?: ReactNode }
    return cloneElement(
      child,
      // The child's own classes, style, ref and handlers are kept and merged.
      mergeProps(childOwn, rest as Props, dragProps, own) as ChildProps,
      badge || lastTag || indicator || dot || noteMarker || resize ? (
        <>
          {dot}
          {badge}
          {lastTag}
          {noteMarker}
          {indicator}
          {resize}
          {inner}
        </>
      ) : (
        inner
      )
    )
  }
  const Tag = inline ? 'span' : 'div'
  return (
    <Tag {...mergeProps(rest as Props, dragProps, own)}>
      {dot}
      {badge}
      {lastTag}
      {noteMarker}
      {indicator}
      {resize}
      {children}
    </Tag>
  )
}

/**
 * Wrap `node` in a DesignNode when a design context is active, else return it
 * untouched — no extra component in the normal render path. The node's key
 * moves to the shell so mapped lists keep their identity.
 */
export function designWrap(
  design: LayoutDesign | null,
  target: DesignTarget,
  node: ReactNode,
  opts: DesignNodeOptions = {}
): ReactNode {
  if (!design || node == null || node === false) return node
  const k = isValidElement(node) ? (node.key ?? undefined) : undefined
  return (
    <DesignNode key={k} target={target} {...opts}>
      {node}
    </DesignNode>
  )
}

/** `designWrap` bound to the ambient design context (null outside the canvas). */
export function useDesignWrap() {
  const design = useLayoutDesign()
  return (target: DesignTarget, node: ReactNode, opts?: DesignNodeOptions) =>
    designWrap(design, target, node, opts)
}

/**
 * Makes the element it sits in (a tab, step or container-tab pane) a drop
 * target for `groupKey`'s fields, and draws the drop line there. Renders a
 * hidden span until a drop line shows.
 */
export function DesignDropBody({ groupKey }: { groupKey: string }) {
  const { ref, slot, indicator } = useDesignDropBody(groupKey)
  return (
    <span
      ref={ref}
      aria-hidden
      hidden={!slot}
      data-design-drop-body={groupKey}
      data-design-drop-indicator={slot ?? undefined}
      className='pointer-events-none absolute z-30 rounded-full bg-nvr-cyan shadow-[0_0_0_2px_#fff] dark:shadow-[0_0_0_2px_#0f172a]'
      style={slot ? (indicator ?? FALLBACK_INDICATOR[slot]) : undefined}
    />
  )
}

/** An empty section/tab/step body on the canvas: somewhere to drop fields. */
export function DesignDropZone() {
  return (
    <div
      data-design-drop-zone=''
      className='flex h-16 items-center justify-center rounded-lg border border-dashed border-slate-300 text-[12px] text-slate-400 dark:border-slate-600 dark:text-slate-500'
    >
      Drop fields here
    </div>
  )
}

/** Tags a node shows before the rest fold into "+n". */
export const MAX_NODE_TAGS = 2

interface BadgeChip {
  /** 0 first: comparison, preview (role mark, preview modes), rule loop, rule
   *  and state tags, AI findings, "from <parent>". */
  rank: number
  /** For the "+n" tip. */
  text: string
  node: ReactNode
}

/** Where a tag ranks (DesignMark.kind). */
export function markRank(m: Pick<DesignMark, 'kind' | 'highlight'>): number {
  if (m.kind === 'preview') return 1
  if (m.kind === 'ai') return 4
  if (m.kind === 'loop' || m.kind === 'personal' || m.highlight) return 2
  return 3
}

/** The tags that show and the ones behind "+n", best ranked first (stable). */
export function rankChips<T extends { rank: number }>(
  chips: T[],
  max = MAX_NODE_TAGS
): { shown: T[]; rest: T[] } {
  const sorted = chips
    .map((c, i) => ({ c, i }))
    .sort((a, b) => a.c.rank - b.c.rank || a.i - b.i)
    .map((x) => x.c)
  return { shown: sorted.slice(0, max), rest: sorted.slice(max) }
}

/** "Ben Ode" → "BO" (a peer's avatar on the node). */
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  return (
    parts
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? '')
      .join('') || '?'
  )
}

function diffText(diff: DiffMark): string {
  const t = DIFF_TAG[diff.kind].text
  if (diff.kind === 'moved' && diff.detail) return `Moved ${diff.detail}`
  return diff.kind === 'changed' && diff.detail ? `${t}: ${diff.detail}` : t
}

// The comparison's rings sit outside the node (box-shadow): selection keeps its outline.
const DIFF_RING: Record<DiffMark['kind'], string> = {
  added: 'ring-2 ring-emerald-500/70 dark:ring-emerald-400/60',
  moved: 'ring-2 ring-amber-500/70 dark:ring-amber-400/60',
  changed: 'ring-1 ring-violet-500/60 dark:ring-violet-400/50',
  removed: 'ring-1 ring-rose-400/70 dark:ring-rose-400/50'
}

const DIFF_TAG: Record<DiffMark['kind'], { text: string; cls: string }> = {
  added: {
    text: 'Added',
    cls: 'bg-emerald-50 text-emerald-800 ring-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-200 dark:ring-emerald-500/30'
  },
  moved: {
    text: 'Moved',
    cls: 'bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-500/15 dark:text-amber-200 dark:ring-amber-500/30'
  },
  changed: {
    text: 'Changed',
    cls: 'bg-violet-50 text-violet-800 ring-violet-200 dark:bg-violet-500/15 dark:text-violet-200 dark:ring-violet-500/30'
  },
  removed: {
    text: 'Removed',
    cls: 'bg-rose-50 text-rose-800 ring-rose-200 line-through dark:bg-rose-500/15 dark:text-rose-200 dark:ring-rose-500/30'
  }
}

/** A comparison's tag on a node: Added, Moved from Basics, Changed (what, in the tip), Removed. */
function DiffTag({ diff }: { diff: DiffMark }) {
  const t = DIFF_TAG[diff.kind]
  return (
    <span
      data-design-diff-tag={diff.kind}
      className={cn('inline-flex items-center rounded px-1 text-[11px] ring-1', t.cls)}
    >
      {diff.kind === 'moved' && diff.detail ? `Moved ${diff.detail}` : t.text}
      {diff.kind === 'changed' && diff.detail && (
        <span className='ml-1 max-w-[160px] truncate opacity-80'>{diff.detail}</span>
      )}
    </span>
  )
}
