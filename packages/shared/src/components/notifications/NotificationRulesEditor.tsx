import { RotateCcw } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { cn } from '../../lib/utils'
import { SimpleSelectXs } from '../ui/SimpleSelect'

/**
 * The notification rules editor (quiet hours, per-category channel matrix, unread escalation),
 * shared by Profile → Notification rules (a person's own rules) and Roles → Notification
 * defaults (#3077: a role's starting rules — the SAME shape). When `inherited` is given (the
 * person's role defaults), every value the person never set shows the inherited one with a
 * "role" mark, and a per-row reset puts a category back on the role's defaults.
 *
 * Writes keep ABSENCE: only the value a control changed is written, so everything else keeps
 * following the layer below. Twin of api services/notification-layers.ts mergeNotifyRules /
 * layerOf — change both together.
 */

export type EmailMode = 'instant' | 'daily' | 'off'
export interface RulesMatrixRow {
  inapp?: boolean
  push?: boolean
  teams?: boolean
  email?: EmailMode
  quiet_override?: boolean
}
export interface RulesEscalation {
  push_after_min?: number
  email_after_min?: number
}
export interface NotifyRulesValue {
  quiet_start?: string
  quiet_end?: string
  teams_muted_until?: string
  matrix?: Record<string, RulesMatrixRow>
  escalation?: Record<string, RulesEscalation>
}
export type RuleLayer = 'person' | 'role' | 'system'

export const NOTIFY_RULE_CATS: Array<{ key: string; label: string; help: string }> = [
  {
    key: 'mentions',
    label: 'Mentions',
    help: 'Someone @-mentions you in a comment, note, or chat room.'
  },
  {
    key: 'workflow',
    label: 'Workflow & approvals',
    help: 'A record you own or follow moves state, needs your approval, is sent back, or an approval chain reaches your step. Also support requests you work on the desk (new, assigned, replied).'
  },
  {
    key: 'sla',
    label: 'SLA & escalations',
    help: 'A record you own is nearing or past its SLA, and escalation-ladder notices as they climb. SLA escalations always email immediately.'
  },
  {
    key: 'watch',
    label: 'Watches',
    help: 'Something you explicitly watch fired: field watches, per-record subscriptions, and watched stock parts (Stock Planning).'
  },
  {
    key: 'alerts',
    label: 'Alerts',
    help: 'Threshold alerts you subscribe to: metric alert rules, per-record alert definitions, report alerts, and the alert digest.'
  },
  {
    key: 'audit',
    label: 'Audit log patterns',
    help: 'An activity-pattern alert you subscribe to matched: someone made the kind of change it watches for (for example a large amount edited, or a zone changed). Past the rule’s hourly limit the rest arrive as one digest.'
  },
  {
    key: 'anomaly',
    label: 'Anomaly detections',
    help: 'Anomaly rules you created flag an outlier, spike, or duplicate pattern.'
  },
  {
    key: 'reports',
    label: 'Reports',
    help: 'Scheduled report emails, Report Studio subscription digests, and saved-view change digests.'
  },
  {
    key: 'integrations',
    label: 'Integrations',
    help: 'A partner system was not told something about your record, a send is still unanswered, or an integration alert you turned on in the Integrations console fired.'
  },
  {
    key: 'huddle',
    label: 'Huddles & calls',
    help: 'Someone calls you in a huddle or adds you to one, and reminders for huddles you were invited to. Push is what rings a closed tab.'
  },
  {
    key: 'chaos',
    label: 'Chaos drills',
    help: 'Chaos Monkey drills starting and ending, and pushes about drills you started or take part in (with a Stop button). Only administrators and chaos operators get these.'
  },
  {
    key: 'system',
    label: 'System & digests',
    help: 'Maintenance windows, failing monitors, import results, updates on support requests you raised, and the daily action summary itself. Maintenance and monitor failures always email immediately.'
  },
  {
    key: 'other',
    label: 'Everything else',
    help: 'Any notification that does not fit a category above — direct messages from other users, access requests, task assignments.'
  }
]

const MATRIX_KEYS = ['inapp', 'push', 'teams', 'email', 'quiet_override'] as const
const STEPS = ['push_after_min', 'email_after_min'] as const
const hasQuiet = (r?: NotifyRulesValue | null) =>
  !!r && (r.quiet_start !== undefined || r.quiet_end !== undefined)

/** Person over role, value by value (server twin: mergeNotifyRules). */
export function mergeNotifyRulesClient(
  own: NotifyRulesValue | null | undefined,
  inherited: NotifyRulesValue | null | undefined
): NotifyRulesValue {
  const out: NotifyRulesValue = {}
  const q = hasQuiet(own) ? own : hasQuiet(inherited) ? inherited : null
  if (q?.quiet_start !== undefined) out.quiet_start = q.quiet_start
  if (q?.quiet_end !== undefined) out.quiet_end = q.quiet_end
  const matrix: Record<string, RulesMatrixRow> = {}
  for (const cat of new Set([
    ...Object.keys(inherited?.matrix ?? {}),
    ...Object.keys(own?.matrix ?? {})
  ])) {
    const row: RulesMatrixRow = {}
    for (const k of MATRIX_KEYS) {
      const v = own?.matrix?.[cat]?.[k] ?? inherited?.matrix?.[cat]?.[k]
      if (v !== undefined) (row as Record<string, unknown>)[k] = v
    }
    matrix[cat] = row
  }
  out.matrix = matrix
  const esc: Record<string, RulesEscalation> = {}
  for (const cat of new Set([
    ...Object.keys(inherited?.escalation ?? {}),
    ...Object.keys(own?.escalation ?? {})
  ])) {
    const rule: RulesEscalation = {}
    for (const s of STEPS) {
      const v = own?.escalation?.[cat]?.[s] ?? inherited?.escalation?.[cat]?.[s]
      if (v !== undefined) rule[s] = v
    }
    esc[cat] = rule
  }
  out.escalation = esc
  return out
}

function layerAt(
  own: NotifyRulesValue | null | undefined,
  inherited: NotifyRulesValue | null | undefined,
  pick: (r: NotifyRulesValue | null | undefined) => unknown
): RuleLayer {
  if (pick(own) !== undefined) return 'person'
  if (pick(inherited) !== undefined) return 'role'
  return 'system'
}

function Help({ text }: { text: string }) {
  return (
    <span
      className='ml-1 inline-flex h-3.5 w-3.5 cursor-help items-center justify-center rounded-full border border-slate-300 text-[9px] font-semibold normal-case tracking-normal text-slate-400 dark:border-border'
      role='img'
      data-tip={text}
      aria-label={text}
    >
      ?
    </span>
  )
}

function FromRole({ show, roleName }: { show: boolean; roleName?: string | null }) {
  const tip = `From the ${roleName ? `"${roleName}" ` : ''}role default — change it to make it yours`
  return (
    <span
      data-from-role={show ? '' : undefined}
      aria-hidden={!show}
      data-tip={show ? tip : undefined}
      className={cn(
        'ml-0.5 inline-block rounded bg-violet-50 px-0.5 align-middle text-[8.5px] font-bold uppercase leading-[12px] text-violet-600 dark:bg-violet-500/15 dark:text-violet-300',
        !show && 'invisible'
      )}
    >
      R
    </span>
  )
}

export interface NotificationRulesEditorProps {
  /** The layer being edited: a person's own rules, or a role's defaults. */
  value: NotifyRulesValue
  /** The layer below (a person's role defaults); omitted when editing a role. */
  inherited?: NotifyRulesValue | null
  inheritedName?: string | null
  /** A person's account-wide legacy email default (instant unless 'daily'). */
  legacyEmail?: EmailMode
  onCommit: (next: NotifyRulesValue) => void
  /** Flat-key writes the editor makes alongside (the legacy email_digest default). */
  onLegacyEmail?: (mode: EmailMode) => void
  saving?: boolean
  subject: 'person' | 'role'
  teams?: { available: boolean; linked: boolean; header?: ReactNode } | null
  extraColumn?: { header: ReactNode; cell: (cat: string, label: string) => ReactNode } | null
}

export function NotificationRulesEditor({
  value,
  inherited,
  inheritedName,
  legacyEmail = 'instant',
  onCommit,
  onLegacyEmail,
  saving,
  subject,
  teams,
  extraColumn
}: NotificationRulesEditorProps) {
  const eff = mergeNotifyRulesClient(value, inherited)
  const [quietStart, setQuietStart] = useState<string | null>(null)
  const [quietEnd, setQuietEnd] = useState<string | null>(null)
  const effStart = quietStart ?? eff.quiet_start ?? ''
  const effEnd = quietEnd ?? eff.quiet_end ?? ''
  const quietLayer: RuleLayer = hasQuiet(value) ? 'person' : hasQuiet(inherited) ? 'role' : 'system'
  const showRole = subject === 'person' && !!inherited

  const commit = (patchFn: (draft: NotifyRulesValue) => void) => {
    const next: NotifyRulesValue = {
      ...value,
      matrix: { ...(value.matrix ?? {}) },
      escalation: { ...(value.escalation ?? {}) }
    }
    patchFn(next)
    onCommit(next)
  }
  const setRow = (cat: string, k: keyof RulesMatrixRow, v: RulesMatrixRow[typeof k] | undefined) =>
    commit((d) => {
      const row = { ...(d.matrix?.[cat] ?? {}) } as Record<string, unknown>
      if (v === undefined) delete row[k]
      else row[k] = v
      const m = d.matrix ?? {}
      if (Object.keys(row).length) m[cat] = row as RulesMatrixRow
      else delete m[cat]
      d.matrix = m
    })
  const inheritedRow = (cat: string) => inherited?.matrix?.[cat] ?? {}
  const emailModeOf = (cat: string): EmailMode =>
    value.matrix?.[cat]?.email ??
    (legacyEmail === 'daily' ? 'daily' : (inherited?.matrix?.[cat]?.email ?? legacyEmail))
  const emailLayer = (cat: string): RuleLayer =>
    value.matrix?.[cat]?.email !== undefined || legacyEmail === 'daily'
      ? 'person'
      : inherited?.matrix?.[cat]?.email !== undefined
        ? 'role'
        : 'system'
  const commitQuiet = (start: string | undefined, end: string | undefined) =>
    commit((d) => {
      if (start === undefined && end === undefined) {
        delete d.quiet_start
        delete d.quiet_end
      } else {
        d.quiet_start = start ?? ''
        d.quiet_end = end ?? ''
      }
    })
  const setEscalation = (cat: string, step: keyof RulesEscalation, minutes: number | null) =>
    commit((d) => {
      const cur = { ...(d.escalation?.[cat] ?? {}) }
      if (minutes) cur[step] = minutes
      // "never" over a role default that escalates is an explicit 0; else the key goes.
      else if (inherited?.escalation?.[cat]?.[step]) cur[step] = 0
      else delete cur[step]
      const e = d.escalation ?? {}
      if (Object.keys(cur).length) e[cat] = cur
      else delete e[cat]
      d.escalation = e
    })
  const resetRow = (cat: string) =>
    commit((d) => {
      delete d.matrix?.[cat]
    })
  const resetEscalation = (cat: string) =>
    commit((d) => {
      delete d.escalation?.[cat]
    })
  const ownAnything =
    hasQuiet(value) ||
    Object.keys(value.matrix ?? {}).length > 0 ||
    Object.keys(value.escalation ?? {}).length > 0
  const ESCALATION_OPTIONS = [
    { value: '', label: 'never' },
    { value: '15', label: '15 min' },
    { value: '60', label: '1 hour' },
    { value: '240', label: '4 hours' },
    { value: '480', label: '8 hours' },
    { value: '1440', label: '1 day' }
  ]
  const EMAIL_OPTIONS = [
    { value: 'instant', label: 'Individual email' },
    { value: 'daily', label: 'Daily summary' },
    { value: 'off', label: 'No email' }
  ]
  const who = subject === 'role' ? 'members' : 'you'

  return (
    <div className='space-y-3' data-notification-rules-editor={subject}>
      {showRole && (
        <div
          data-role-defaults-note
          className='flex flex-wrap items-center gap-2 rounded-md border border-violet-200 bg-violet-50/60 px-3 py-1.5 text-[11.5px] text-violet-900 dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-violet-200'
        >
          <span className='min-w-0 flex-1'>
            Your role{inheritedName ? ` (${inheritedName})` : ''} sets starting rules. Values marked{' '}
            <FromRole show roleName={inheritedName} /> come from it until you change them.
          </span>
          {ownAnything && (
            <button
              type='button'
              disabled={saving}
              onClick={() =>
                onCommit(
                  value.teams_muted_until ? { teams_muted_until: value.teams_muted_until } : {}
                )
              }
              className='underline decoration-dotted underline-offset-2 disabled:opacity-50'
            >
              Use the role defaults for everything
            </button>
          )}
        </div>
      )}
      <div className='flex flex-wrap items-center gap-2 text-[12.5px] text-slate-600 dark:text-muted-foreground'>
        Quiet hours (ET):
        <input
          type='time'
          value={effStart}
          onChange={(e) => setQuietStart(e.target.value)}
          onBlur={() => {
            if (quietStart != null) commitQuiet(effStart || '', effEnd || '')
          }}
          aria-label='Quiet hours start'
          className='h-7 rounded-md border border-slate-200 bg-background px-1.5 text-[12px] dark:border-border'
        />
        <span>to</span>
        <input
          type='time'
          value={effEnd}
          onChange={(e) => setQuietEnd(e.target.value)}
          onBlur={() => {
            if (quietEnd != null) commitQuiet(effStart || '', effEnd || '')
          }}
          aria-label='Quiet hours end'
          className='h-7 rounded-md border border-slate-200 bg-background px-1.5 text-[12px] dark:border-border'
        />
        {showRole && quietLayer === 'role' && <FromRole show roleName={inheritedName} />}
        {(effStart || effEnd) && (
          <button
            type='button'
            onClick={() => {
              setQuietStart('')
              setQuietEnd('')
              // Over a role window, "none" must be explicit or the role's comes back.
              if (hasQuiet(inherited)) commitQuiet('', '')
              else commitQuiet(undefined, undefined)
            }}
            className='text-[11.5px] text-slate-400 underline decoration-dotted underline-offset-2'
          >
            Clear
          </button>
        )}
        {showRole && quietLayer === 'person' && hasQuiet(inherited) && (
          <button
            type='button'
            onClick={() => {
              setQuietStart(null)
              setQuietEnd(null)
              commitQuiet(undefined, undefined)
            }}
            className='text-[11.5px] text-slate-400 underline decoration-dotted underline-offset-2'
          >
            Use the role's ({inherited?.quiet_start || '—'}–{inherited?.quiet_end || '—'})
          </button>
        )}
      </div>
      <table className='w-full text-[12px]'>
        <thead>
          <tr className='text-left text-[10.5px] uppercase tracking-wide text-slate-400'>
            <th className='py-1 font-semibold'>Category</th>
            <th className='py-1 text-center font-semibold'>
              In-app
              <Help text='The notification itself: the bell badge and the Notifications inbox in the app. Off = no row is written for this category, so nothing shows anywhere in the app.' />
            </th>
            <th className='py-1 text-center font-semibold'>
              Push
              <Help text='A browser / device alert (the popup you get even with the tab closed) on devices where notifications are allowed. Off keeps the in-app row but stops the device alert. Quiet hours pause pushes too.' />
            </th>
            <th className='py-1 text-center font-semibold'>
              Email
              <Help text='Individual email = one message as each event happens. Daily summary = held and delivered once a day in the action summary. No email = never emailed for this category (in-app and push are unaffected).' />
            </th>
            {teams?.available && (
              <th className='py-1 text-center font-semibold' data-teams-column=''>
                Teams
                <Help text='A message from the Nivaro bot in Microsoft Teams. Off by default: connect Teams, then turn on the categories wanted there.' />
                {teams.header}
              </th>
            )}
            {extraColumn && (
              <th className='py-1 text-center font-semibold'>{extraColumn.header}</th>
            )}
            <th className='py-1 text-center font-semibold'>
              Quiet hours
              <Help
                text={`Ticked = this category still pushes and emails during quiet hours (the in-app row always lands either way). Critical alerts always get through.`}
              />
            </th>
            {showRole && <th className='w-6 py-1' aria-label='Reset' />}
          </tr>
        </thead>
        <tbody>
          {NOTIFY_RULE_CATS.map((c) => {
            const row = eff.matrix?.[c.key] ?? {}
            const fromRole = (k: keyof RulesMatrixRow) =>
              showRole && layerAt(value, inherited, (r) => r?.matrix?.[c.key]?.[k]) === 'role'
            const ownRow = value.matrix?.[c.key]
            return (
              <tr key={c.key} className='border-t border-slate-100 dark:border-border'>
                <td className='py-1.5 text-slate-700 dark:text-foreground'>
                  {c.label}
                  <Help text={c.help} />
                </td>
                {(['inapp', 'push'] as const).map((ch) => (
                  <td key={ch} className='py-1.5 text-center'>
                    <input
                      type='checkbox'
                      checked={row[ch] !== false}
                      onChange={() => setRow(c.key, ch, row[ch] === false)}
                      disabled={saving}
                      aria-label={`${ch === 'inapp' ? 'In-app' : 'Push'} for ${c.label}`}
                      data-notify-channel={`${c.key}:${ch}`}
                      className='h-3.5 w-3.5 align-middle'
                    />
                    <FromRole show={fromRole(ch)} roleName={inheritedName} />
                  </td>
                ))}
                <td className='py-1 text-center'>
                  <div className='inline-flex items-center'>
                    <SimpleSelectXs
                      ariaLabel={`Email for ${c.label}`}
                      value={emailModeOf(c.key)}
                      options={EMAIL_OPTIONS}
                      onChange={(v: string) => setRow(c.key, 'email', v as EmailMode)}
                    />
                    <FromRole
                      show={showRole && emailLayer(c.key) === 'role'}
                      roleName={inheritedName}
                    />
                  </div>
                </td>
                {teams?.available && (
                  <td className='py-1.5 text-center'>
                    <input
                      type='checkbox'
                      checked={row.teams === true}
                      onChange={() => setRow(c.key, 'teams', row.teams !== true)}
                      disabled={saving || (subject === 'person' && !teams.linked)}
                      aria-label={`Teams for ${c.label}`}
                      data-tip={
                        subject === 'person' && !teams.linked ? 'Connect Teams first' : undefined
                      }
                      data-notify-channel={`${c.key}:teams`}
                      className='h-3.5 w-3.5 align-middle'
                    />
                    <FromRole show={fromRole('teams')} roleName={inheritedName} />
                  </td>
                )}
                {extraColumn && (
                  <td className='py-1 text-center'>{extraColumn.cell(c.key, c.label)}</td>
                )}
                <td className='py-1.5 text-center'>
                  <input
                    type='checkbox'
                    checked={row.quiet_override === true}
                    onChange={() =>
                      setRow(
                        c.key,
                        'quiet_override',
                        row.quiet_override === true
                          ? inheritedRow(c.key).quiet_override === true
                            ? false
                            : undefined
                          : true
                      )
                    }
                    disabled={saving}
                    aria-label={`Let ${c.label} through quiet hours`}
                    data-quiet-override={c.key}
                    className='h-3.5 w-3.5 align-middle'
                  />
                  <FromRole show={fromRole('quiet_override')} roleName={inheritedName} />
                </td>
                {showRole && (
                  <td className='py-1 text-center'>
                    <button
                      type='button'
                      onClick={() => resetRow(c.key)}
                      disabled={saving}
                      data-tip='Back to the role default for this category'
                      aria-label={`Use the role default for ${c.label}`}
                      className={cn(
                        'rounded p-0.5 text-slate-400 hover:bg-muted hover:text-slate-700 dark:hover:text-slate-200',
                        !ownRow && 'invisible'
                      )}
                    >
                      <RotateCcw className='h-3 w-3' />
                    </button>
                  </td>
                )}
              </tr>
            )
          })}
        </tbody>
      </table>
      <div className='flex flex-wrap items-center gap-2 text-[11.5px] text-slate-500 dark:text-muted-foreground'>
        <span>All email:</span>
        {EMAIL_OPTIONS.map((o) => (
          <button
            key={o.value}
            type='button'
            disabled={saving}
            onClick={() => {
              commit((d) => {
                const m = d.matrix ?? {}
                for (const c of NOTIFY_RULE_CATS)
                  m[c.key] = { ...(m[c.key] ?? {}), email: o.value as EmailMode }
                d.matrix = m
              })
              if (o.value !== 'off') onLegacyEmail?.(o.value as EmailMode)
            }}
            className='rounded border border-slate-200 px-2 py-0.5 hover:border-slate-400 hover:text-slate-800 dark:border-border dark:hover:text-foreground'
          >
            {o.label}
          </button>
        ))}
      </div>
      <div className='space-y-2 rounded-md border border-slate-100 bg-slate-50/60 px-3 py-2 dark:border-border/60 dark:bg-background/40'>
        <p className='text-[12px] font-medium text-slate-700 dark:text-foreground'>
          If it stays unread
          <span className='ml-1.5 text-[11px] font-normal text-slate-400'>
            one notification climbs channels on a schedule — push, then email — and stops the moment
            {subject === 'role' ? ' it is' : ' you'} read{subject === 'role' ? '' : ' it'}. A
            channel that already delivered it is not repeated.
          </span>
        </p>
        <table className='w-full text-[12px]'>
          <thead>
            <tr className='text-left text-[10.5px] uppercase tracking-wide text-slate-400'>
              <th className='py-1 font-semibold'>Category</th>
              <th className='py-1 font-semibold'>
                Push after
                <Help
                  text={`Still unread after this long → a browser / device push (needs a registered device; quiet hours do not apply to escalations ${who} asked for).`}
                />
              </th>
              <th className='py-1 font-semibold'>
                Email after
                <Help text='Still unread after this long → one email with the notification, regardless of the Email column above.' />
              </th>
              {showRole && <th className='w-6 py-1' aria-label='Reset' />}
            </tr>
          </thead>
          <tbody>
            {NOTIFY_RULE_CATS.map((c) => {
              const rule = eff.escalation?.[c.key] ?? {}
              return (
                <tr key={c.key} className='border-t border-slate-100 dark:border-border'>
                  <td className='py-1 text-slate-700 dark:text-foreground'>{c.label}</td>
                  {STEPS.map((step) => (
                    <td key={step} className='py-1'>
                      <span className='inline-flex items-center'>
                        <SimpleSelectXs
                          ariaLabel={`${step === 'push_after_min' ? 'Push' : 'Email'} after for ${c.label}`}
                          value={rule[step] ? String(rule[step]) : ''}
                          options={ESCALATION_OPTIONS}
                          onChange={(v: string) => setEscalation(c.key, step, v ? Number(v) : null)}
                        />
                        <FromRole
                          show={
                            showRole &&
                            layerAt(value, inherited, (r) => r?.escalation?.[c.key]?.[step]) ===
                              'role'
                          }
                          roleName={inheritedName}
                        />
                      </span>
                    </td>
                  ))}
                  {showRole && (
                    <td className='py-1 text-center'>
                      <button
                        type='button'
                        onClick={() => resetEscalation(c.key)}
                        disabled={saving}
                        data-tip='Back to the role default for this category'
                        aria-label={`Use the role default escalation for ${c.label}`}
                        className={cn(
                          'rounded p-0.5 text-slate-400 hover:bg-muted hover:text-slate-700 dark:hover:text-slate-200',
                          !value.escalation?.[c.key] && 'invisible'
                        )}
                      >
                        <RotateCcw className='h-3 w-3' />
                      </button>
                    </td>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
