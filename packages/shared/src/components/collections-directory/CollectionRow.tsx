import {
  AlertTriangle,
  Code2,
  Download,
  EyeOff,
  LayoutTemplate,
  Link2,
  type LucideIcon,
  Pencil,
  Pin,
  Square,
  Star,
  Workflow
} from 'lucide-react'
import {
  type AnchorHTMLAttributes,
  type FocusEvent,
  forwardRef,
  type MouseEvent,
  type ReactNode,
  useState
} from 'react'
import { useNavigation } from '../../context'
import { cn, formatDateTime, formatNumber, resolveCollectionIcon, titleCase } from '../../lib/utils'
import { Checkbox } from '../ui/checkbox'
import { CollectionHoverCard, useHoverIntent } from './CollectionHoverCard'
import { CollectionRowMenu } from './CollectionRowMenu'
import { recordCollectionOpen } from './directory-data'
import type {
  DirectoryCollection as Collection,
  CollectionStat,
  Density,
  FolderOption,
  HeavyListFlag,
  RowMenuLink
} from './types'

/** The admin's route for a collection's records — the default when the host gives none. */
export const defaultCollectionPath = (collection: string) =>
  `/collections/${encodeURIComponent(collection)}`

/**
 * An in-app link through the host's navigation: a plain left click navigates in place;
 * a modified or middle click, or a click the caller already handled, keeps the browser's own
 * behaviour (new tab, nothing).
 */
export const HostLink = forwardRef<
  HTMLAnchorElement,
  AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }
>(function HostLink({ to, onClick, ...rest }, ref) {
  const { navigate } = useNavigation()
  return (
    <a
      ref={ref}
      href={to}
      {...rest}
      onClick={(e: MouseEvent<HTMLAnchorElement>) => {
        onClick?.(e)
        if (e.defaultPrevented) return
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
        e.preventDefault()
        navigate(to)
      }}
    />
  )
})

const MAX_BADGES = 3

// ─── Avatar ───────────────────────────────────────────────────────────────────

export function CollectionAvatar({
  color,
  name,
  icon,
  size = 'md'
}: {
  color?: string | null
  name: string
  icon?: string | null
  /** md = 24px (default), sm = 20px (compact rows). */
  size?: 'sm' | 'md'
}) {
  const IconComp = resolveCollectionIcon(icon)
  return (
    <div
      className={cn(
        'flex shrink-0 items-center justify-center rounded font-bold text-white select-none',
        size === 'sm' ? 'h-5 w-5 text-[10px]' : 'h-6 w-6 text-[11px]'
      )}
      style={{ backgroundColor: color ?? '#94a3b8' }}
      aria-hidden='true'
    >
      {IconComp ? (
        <IconComp className={size === 'sm' ? 'h-3 w-3' : 'h-3.5 w-3.5'} />
      ) : (
        name.charAt(0).toUpperCase()
      )}
    </div>
  )
}

// ─── Badges ───────────────────────────────────────────────────────────────────

interface BadgeSpec {
  key: string
  label: string
  icon: LucideIcon
  tip: string
  /** A warning (amber) rather than a plain fact. */
  warn?: boolean
}

/** "Units (up to 2,341 per record)" — the heavy columns a list opens on. */
export function heavyListTip(flag: HeavyListFlag): string {
  const parts = flag.fields.map((f) => `${f.label} (up to ${formatNumber(f.max)} per record)`)
  return `The list opens on ${parts.join(' and ')} — slow and unreadable. Fix it in Data model → Collection Browser.`
}

function badgesFor(
  col: Collection,
  stat: CollectionStat | undefined,
  heavyList: HeavyListFlag | undefined
): BadgeSpec[] {
  const out: BadgeSpec[] = []
  // First, so the 3-badge cap never hides it.
  if (heavyList && heavyList.fields.length > 0)
    out.push({
      key: 'heavy-list',
      label: 'Heavy list',
      icon: AlertTriangle,
      tip: heavyListTip(heavyList),
      warn: true
    })
  // A link table is its own kind (its own switch), whatever its hidden flag says.
  if (col.hidden && !stat?.link)
    out.push({ key: 'hidden', label: 'Hidden', icon: EyeOff, tip: 'Hidden from navigation' })
  if (stat?.virtual)
    out.push({
      key: 'virtual',
      label: 'Virtual',
      icon: Code2,
      tip: 'Backed by SQL — read-only'
    })
  if (stat?.link)
    out.push({ key: 'link', label: 'Link table', icon: Link2, tip: 'Links two collections' })
  if (stat?.pipeline)
    out.push({ key: 'pipeline', label: 'Pipeline', icon: Workflow, tip: stat.pipeline })
  if (stat && stat.forms > 0)
    out.push({
      key: 'forms',
      label: stat.forms > 1 ? `Form ×${stat.forms}` : 'Form',
      icon: LayoutTemplate,
      tip: `${stat.forms} form layout${stat.forms === 1 ? '' : 's'}`
    })
  if (stat && stat.imports > 0)
    out.push({
      key: 'imports',
      label: 'Imports',
      icon: Download,
      tip: `${stat.imports} import${stat.imports === 1 ? '' : 's'} feed this collection`
    })
  if (col.singleton)
    out.push({ key: 'singleton', label: 'Singleton', icon: Square, tip: 'Holds a single record' })
  return out
}

function Badge({ spec }: { spec: BadgeSpec }) {
  const Icon = spec.icon
  return (
    <span
      data-tip={spec.tip}
      data-badge={spec.key}
      className={cn(
        'inline-flex items-center gap-1 whitespace-nowrap rounded px-1.5 py-px text-[10px] font-medium',
        spec.warn
          ? 'bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-200 dark:bg-amber-400/10 dark:text-amber-300 dark:ring-amber-400/25'
          : 'bg-slate-100 text-slate-500 dark:bg-white/10 dark:text-slate-400'
      )}
    >
      <Icon className='h-[11px] w-[11px] shrink-0' aria-hidden='true' />
      {spec.label}
    </span>
  )
}

function Badges({ items }: { items: BadgeSpec[] }) {
  if (items.length === 0) return null
  const shown = items.slice(0, MAX_BADGES)
  const rest = items.slice(MAX_BADGES)
  return (
    <span data-cdr='' className='hidden shrink-0 items-center gap-1 sm:[&[data-cdr]]:flex'>
      {shown.map((b) => (
        <Badge key={b.key} spec={b} />
      ))}
      {rest.length > 0 && (
        <span
          data-tip={rest.map((b) => b.label).join(' · ')}
          className='inline-flex items-center rounded px-1 py-px text-[10px] font-medium tabular-nums text-slate-500 dark:text-slate-400'
        >
          +{rest.length}
        </span>
      )}
    </span>
  )
}

// ─── Key with the filter match marked ─────────────────────────────────────────

function matchIndex(key: string, highlight: string | undefined): number {
  const q = highlight?.trim().toLowerCase()
  if (!q) return -1
  return key.toLowerCase().indexOf(q)
}

function KeyText({ text, at, len }: { text: string; at: number; len: number }) {
  let body: ReactNode = text
  if (at >= 0 && len > 0)
    body = (
      <>
        {text.slice(0, at)}
        <mark className='rounded-sm bg-nvr-cyan/15 text-slate-700 dark:bg-nvr-cyan/25 dark:text-slate-200'>
          {text.slice(at, at + len)}
        </mark>
        {text.slice(at + len)}
      </>
    )
  return (
    <span
      data-key-text=''
      className='min-w-0 max-w-[50%] shrink truncate font-mono text-[11px] font-normal text-slate-400 dark:text-slate-500'
    >
      {body}
    </span>
  )
}

// ─── Stats ────────────────────────────────────────────────────────────────────

/**
 * "3h ago" within a week, else the short date ("Nov 2", "Mar 4, 2025"): the column is narrow,
 * so it never takes the full timestamp the exact-time preference gives elsewhere — the full
 * stamp is in the tip.
 */
export function shortWhen(iso: string, now = Date.now()): string {
  const d = new Date(iso)
  const t = d.getTime()
  if (Number.isNaN(t)) return '—'
  const mins = Math.floor((now - t) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 7) return `${days}d ago`
  const sameYear = d.getFullYear() === new Date(now).getFullYear()
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' })
  })
}

function Stats({ stat }: { stat: CollectionStat }) {
  const rows =
    stat.rows == null ? (
      <span data-tip='Record count unknown' className='text-slate-400 dark:text-slate-500'>
        —
      </span>
    ) : stat.rows === 0 ? (
      <span className='text-slate-400 dark:text-slate-500'>Empty</span>
    ) : (
      <span data-tip='Approximate record count'>{formatNumber(stat.rows)}</span>
    )
  return (
    <span className='flex shrink-0 items-center gap-3 text-[11px] tabular-nums text-slate-500 dark:text-slate-400'>
      <span className='w-16 text-right'>{rows}</span>
      <span data-cdr='' className='hidden w-16 whitespace-nowrap text-right md:[&[data-cdr]]:block'>
        {stat.changed_at ? (
          <span data-tip={`Last change ${formatDateTime(stat.changed_at)}`}>
            {shortWhen(stat.changed_at)}
          </span>
        ) : (
          <span
            data-tip='No change seen since the database last started'
            className='text-slate-400 dark:text-slate-500'
          >
            —
          </span>
        )}
      </span>
    </span>
  )
}

// ─── Row ──────────────────────────────────────────────────────────────────────

const REVEAL =
  'opacity-0 transition-opacity duration-150 group-hover/row:opacity-100 group-focus-within/row:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 motion-reduce:transition-none'

function isFocusVisible(el: Element): boolean {
  try {
    return el.matches(':focus-visible')
  } catch {
    return false
  }
}

export function CollectionRow({
  col,
  stat,
  heavyList,
  density,
  favorite,
  onToggleFavorite,
  pinnedForAll = false,
  onTogglePinned,
  onMoveUp,
  onMoveDown,
  quietPin = false,
  folders,
  onMove,
  recordsPath,
  editPath,
  menuExtra,
  selecting,
  selected,
  onSelect,
  dragHandle,
  highlight,
  isAdmin,
  indent
}: {
  col: Collection
  /** undefined for non-admins / still loading → no counts or stat badges. */
  stat?: CollectionStat
  /** Admins only: the list opens on a heavy "link to many" column (amber badge + card note). */
  heavyList?: HeavyListFlag
  density: Density
  /** The reader's own favorite (sidebar favorites) — the star. */
  favorite: boolean
  onToggleFavorite: () => void
  /** On the shared Pinned list (for everyone). */
  pinnedForAll?: boolean
  /** Admins only: pin / unpin for everyone. No pin control without it. */
  onTogglePinned?: () => void
  /** The Pinned section's admin moves, offered in the menu (absent at the ends). */
  onMoveUp?: () => void
  onMoveDown?: () => void
  /** In the Pinned section the pin is implied: show it only on hover/focus, as "Unpin". */
  quietPin?: boolean
  folders: FolderOption[]
  /** Host can move collections between folders (admin app); absent = no Move to folder. */
  onMove?: (group: string | null) => void
  /** Where the collection's records open in this app (default: the admin's /collections/…). */
  recordsPath?: string
  /** Host-only ✏ link to the collection's editor (admin app). */
  editPath?: string
  /** Host-only group in the ⋯ menu (admin app: Data model pages). */
  menuExtra?: { heading: string; items: RowMenuLink[] }
  selecting: boolean
  selected: boolean
  onSelect: () => void
  /** Rendered at the far left only when given (Arrange mode). */
  dragHandle?: ReactNode
  /** Current filter text; a key match shows the key with the match marked. */
  highlight?: string
  isAdmin: boolean
  indent?: boolean
}) {
  const name = col.collection
  const displayName = col.display_name ?? titleCase(name)
  const compact = density === 'compact'
  const [hot, setHot] = useState(false)
  const card = useHoverIntent(isAdmin)
  const openPath = recordsPath ?? defaultCollectionPath(name)

  const at = matchIndex(name, highlight)
  const showKey = hot || at >= 0
  const badges = badgesFor(col, stat, isAdmin ? heavyList : undefined)

  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHot(false)
  }

  const nameEl = (
    <span
      className='min-w-0 truncate text-[13px] font-semibold tracking-[-0.003em] text-slate-800 group-hover/row:text-slate-900 dark:text-slate-200 dark:group-hover/row:text-slate-100'
      onPointerEnter={card.show}
      onPointerLeave={card.hide}
    >
      {displayName}
    </span>
  )

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover/focus only reveal the key; the link, star and menu are the controls
    <div
      data-collection={name}
      className={cn(
        'group/row relative flex w-full items-center gap-2 transition-colors duration-150 hover:bg-nvr-cyan/[0.04] focus-within:bg-nvr-cyan/[0.04] motion-reduce:transition-none dark:hover:bg-nvr-cyan/[0.06] dark:focus-within:bg-nvr-cyan/[0.06]',
        selected && 'bg-nvr-cyan/[0.07] dark:bg-nvr-cyan/[0.1]',
        compact ? 'h-7' : 'min-h-10 py-1',
        indent ? 'pl-2 pr-2' : dragHandle ? 'pr-2' : 'pl-4 pr-2'
      )}
      onMouseEnter={() => setHot(true)}
      onMouseLeave={() => setHot(false)}
      onFocus={() => setHot(true)}
      onBlur={onBlur}
    >
      {dragHandle}
      {selecting && (
        <Checkbox
          checked={selected}
          onCheckedChange={() => onSelect()}
          onClick={(e) => e.stopPropagation()}
          aria-label={`Select ${displayName}`}
          className='h-3.5 w-3.5 border-slate-300 data-[state=checked]:border-nvr-cyan data-[state=checked]:bg-nvr-cyan data-[state=checked]:text-white dark:border-slate-600 [&_svg]:h-3 [&_svg]:w-3'
        />
      )}

      <HostLink
        to={openPath}
        onClick={(e) => {
          card.close()
          if (selecting) {
            e.preventDefault()
            onSelect()
            return
          }
          recordCollectionOpen(name)
        }}
        onFocus={(e) => {
          if (isFocusVisible(e.currentTarget)) card.show()
        }}
        onBlur={card.hide}
        className={cn(
          'flex min-w-0 flex-1 items-center gap-2.5 self-stretch rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan/50',
          compact ? '' : 'py-0.5'
        )}
      >
        <CollectionAvatar
          color={col.color}
          name={displayName}
          icon={col.icon}
          size={compact ? 'sm' : 'md'}
        />
        <span className='flex min-w-0 flex-1 flex-col justify-center'>
          <span className='flex min-w-0 items-baseline gap-2'>
            {isAdmin ? (
              <CollectionHoverCard
                collection={name}
                title={displayName}
                heavyList={heavyList}
                open={card.open}
                onClose={card.close}
                onCardEnter={card.cancel}
                onCardLeave={card.hide}
              >
                {nameEl}
              </CollectionHoverCard>
            ) : (
              nameEl
            )}
            {showKey && <KeyText text={name} at={at} len={highlight?.trim().length ?? 0} />}
            {compact && col.note && (
              <span className='min-w-0 flex-1 truncate text-[12px] text-slate-500 dark:text-slate-400'>
                {col.note}
              </span>
            )}
          </span>
          {!compact && col.note && (
            <span className='truncate text-[12px] leading-4 text-slate-500 dark:text-slate-400'>
              {col.note}
            </span>
          )}
        </span>
        <Badges items={badges} />
        {stat && <Stats stat={stat} />}
      </HostLink>

      {isAdmin && editPath && (
        <HostLink
          to={editPath}
          aria-label={`Edit ${displayName}`}
          data-tip='Edit fields, forms and settings'
          data-collection-edit
          data-cdr=''
          onClick={(e) => e.stopPropagation()}
          className={cn(
            // Phones: the ⋯ menu carries editing; the row keeps its width for the name.
            'hidden h-6 w-6 shrink-0 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 sm:[&[data-cdr]]:flex dark:text-slate-500 dark:hover:bg-white/10 dark:hover:text-slate-300',
            REVEAL
          )}
        >
          <Pencil className='h-3.5 w-3.5' />
        </HostLink>
      )}
      {isAdmin && onTogglePinned && (
        <button
          type='button'
          aria-label={
            pinnedForAll ? `Unpin ${displayName} for everyone` : `Pin ${displayName} for everyone`
          }
          aria-pressed={pinnedForAll}
          data-tip={pinnedForAll ? 'Unpin for everyone' : 'Pin to the top for everyone'}
          data-collection-pin
          data-cdr=''
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            onTogglePinned()
          }}
          className={cn(
            // Phones: Pin for everyone stays in the ⋯ menu.
            'hidden sm:[&[data-cdr]]:flex h-6 w-6 shrink-0 items-center justify-center rounded hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:hover:bg-white/10',
            pinnedForAll && !quietPin
              ? 'text-slate-600 hover:text-slate-800 dark:text-slate-300 dark:hover:text-slate-100'
              : cn(
                  REVEAL,
                  'text-slate-400 hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300'
                )
          )}
        >
          <Pin className={cn('h-3.5 w-3.5', pinnedForAll && 'fill-current')} />
        </button>
      )}
      <button
        type='button'
        aria-label={
          favorite
            ? `Remove ${displayName} from my favorites`
            : `Add ${displayName} to my favorites`
        }
        aria-pressed={favorite}
        data-tip={favorite ? 'Remove from my favorites' : 'Add to my favorites'}
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          onToggleFavorite()
        }}
        className={cn(
          'flex h-6 w-6 shrink-0 items-center justify-center rounded hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:hover:bg-white/10',
          favorite
            ? 'text-nvr-cyan'
            : cn(
                REVEAL,
                'text-slate-400 hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300'
              )
        )}
      >
        <Star className={cn('h-3.5 w-3.5', favorite && 'fill-current')} />
      </button>
      <CollectionRowMenu
        col={col}
        displayName={displayName}
        isAdmin={isAdmin}
        recordsPath={openPath}
        extra={isAdmin ? menuExtra : undefined}
        favorite={favorite}
        onToggleFavorite={onToggleFavorite}
        pinnedForAll={pinnedForAll}
        onTogglePinned={onTogglePinned}
        onMoveUp={onMoveUp}
        onMoveDown={onMoveDown}
        folders={folders}
        onMove={onMove}
        // Touch screens have no hover: keep the menu in sight there.
        className={cn(REVEAL, '[@media(hover:none)]:[&[data-cdr]]:opacity-100')}
      />
    </div>
  )
}
