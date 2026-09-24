import { Bot, CalendarClock, CircleHelp, Workflow } from 'lucide-react'
import { cn } from '../../../../lib/utils'
import { UserAvatar } from '../../../UserAvatar'

/** One user recorded on a call — a subset of `PartnerCallUser` so this file
 *  never needs to import the console's types.ts for one field. */
export interface CallTriggerUser {
  id: string
  name: string
  email: string | null
}

export interface CallTriggerInfo {
  kind: 'person' | 'machine' | 'scheduled' | 'flow' | 'unknown'
  label: string
}

/** "sync-inventory" → "Sync inventory". */
function humanize(slug: string): string {
  const s = slug.replace(/[-_]+/g, ' ').trim()
  return s ? s[0].toUpperCase() + s.slice(1) : slug
}

const NAMED_TRIGGERS: Record<string, CallTriggerInfo> = {
  test: { kind: 'machine', label: 'The Test button' },
  'transition-action': { kind: 'machine', label: 'A transition action' },
  'erp-submission': { kind: 'machine', label: 'The push API' },
  contract: { kind: 'scheduled', label: 'A contract check' },
  'sync-job': { kind: 'scheduled', label: 'A sync job' },
  // The generic fallback a caller's own `_log.triggeredBy` degrades to when
  // it names nothing more specific.
  extension: { kind: 'machine', label: 'An extension' }
}

const PREFIXED_TRIGGERS: Array<[RegExp, (id: string) => CallTriggerInfo]> = [
  [/^flow:(.+)$/, (id) => ({ kind: 'flow', label: `Flow #${id}` })],
  [/^cron:(.+)$/, (id) => ({ kind: 'scheduled', label: `Scheduled — ${humanize(id)}` })],
  [/^extension:(.+)$/, (id) => ({ kind: 'machine', label: `Extension — ${id}` })],
  [/^custom-action:(.+)$/, (id) => ({ kind: 'machine', label: `Custom action #${id}` })],
  [/^item-action:(.+)$/, (id) => ({ kind: 'machine', label: `Item action — ${humanize(id)}` })]
]

/**
 * What a call log's `triggered_by` value says sent it — a recorded fact, not
 * an inference (unlike `Requester` in requester.tsx, which reconstructs who
 * sent a PUSH from several clues). A resolved `user` always wins; otherwise
 * a literal reading of the stored string. An unrecognized value is shown
 * verbatim rather than swallowed, so a new trigger string is never invisible.
 */
export function describeCallTrigger(
  triggeredBy: string | null,
  user: CallTriggerUser | null
): CallTriggerInfo {
  if (user) return { kind: 'person', label: user.name }
  const tb = (triggeredBy ?? '').trim()
  if (!tb) return { kind: 'unknown', label: 'Not recorded' }
  if (tb in NAMED_TRIGGERS) return NAMED_TRIGGERS[tb]
  for (const [re, build] of PREFIXED_TRIGGERS) {
    const m = re.exec(tb)
    if (m) return build(m[1])
  }
  return { kind: 'unknown', label: tb }
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  const a = parts[0]?.[0] ?? '?'
  const b = parts.length > 1 ? parts[parts.length - 1][0] : ''
  return `${a}${b}`.toUpperCase()
}

const ICON = {
  machine: Bot,
  scheduled: CalendarClock,
  flow: Workflow,
  unknown: CircleHelp
} as const

/**
 * Who/what sent a call — a person (avatar + name) or the recorded machine
 * origin with its own glyph. `size='sm'` fits a row's own summary line;
 * `'md'` (default) fits the expanded Triggered-by section.
 */
export function TriggerChip({
  triggeredBy,
  user,
  size = 'md'
}: {
  triggeredBy: string | null
  user: CallTriggerUser | null
  size?: 'sm' | 'md'
}) {
  const info = describeCallTrigger(triggeredBy, user)
  const disc = size === 'sm' ? 'h-4 w-4 text-[8px]' : 'h-5 w-5 text-[9px]'
  const text = size === 'sm' ? 'text-[11.5px]' : 'text-[12.5px]'
  const Icon = info.kind === 'person' ? null : (ICON[info.kind as keyof typeof ICON] ?? CircleHelp)
  return (
    <span
      className='inline-flex min-w-0 max-w-full items-center gap-1.5'
      data-ic-call-trigger={info.kind}
    >
      {info.kind === 'person' && user ? (
        <UserAvatar
          userId={user.id}
          className={cn(disc, 'shrink-0 rounded-full object-cover')}
          alt=''
          fallback={
            <span
              aria-hidden
              className={cn(
                disc,
                'inline-flex shrink-0 items-center justify-center rounded-full bg-muted font-semibold text-muted-foreground'
              )}
            >
              {initials(user.name)}
            </span>
          }
        />
      ) : Icon ? (
        <span
          aria-hidden
          className={cn(
            disc,
            'inline-flex shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground'
          )}
        >
          <Icon className={size === 'sm' ? 'h-2.5 w-2.5' : 'h-3 w-3'} />
        </span>
      ) : null}
      <span
        className={cn(
          'truncate',
          text,
          info.kind === 'unknown' ? 'italic text-muted-foreground' : 'font-medium text-foreground'
        )}
        data-tip={user?.email ?? undefined}
      >
        {info.label}
      </span>
    </span>
  )
}
