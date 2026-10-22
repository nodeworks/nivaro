import { useQueryClient } from '@tanstack/react-query'
import { Bot, Database, Handshake, LayoutGrid, PlugZap, Radio } from 'lucide-react'
import { type ReactNode, useCallback, useEffect } from 'react'
import {
  clearPretendDown,
  getPretendDown,
  PRETEND_DOWN_EVENT,
  type PretendDownDependency,
  setPretendDown
} from '../lib/client-chaos'
import { cn, titleCase } from '../lib/utils'
import {
  type ClientChaosUser,
  useClientChaosGate,
  usePretendDownVersion
} from './client-chaos-gate'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'

/**
 * "Pretend X is down" (#2858) — in a design surface (dashboard editing, the layout editor and the
 * record page's Edit layout), toggle a dependency the view uses off and watch its widgets and
 * panels render their real error state. Only this viewer, only this browser tab, only while the
 * design surface is open: it rides browser chaos mode's engine (#2840) with a URL-pattern filter,
 * so the app's own error paths run. Nothing is sent to the server and nobody else sees it.
 *
 * A host mounts `usePretendDownScope(scope)` on the surface (it clears when the surface closes)
 * and renders `PretendDownList` / `PretendDownButton` with the dependencies it uses.
 */

/** The layout editor's scope (one editor per tab; the record page's Edit layout uses it too). */
export const LAYOUT_PRETEND_SCOPE = 'layout-editor'

export type PretendDownKind = 'query' | 'data' | 'partner' | 'ai' | 'realtime' | 'panel'

export interface PretendDownOption extends PretendDownDependency {
  kind: PretendDownKind
  /** One line under the label: what it feeds ("3 widgets"). */
  hint?: string
}

const KIND_ICON: Record<PretendDownKind, ReactNode> = {
  query: <Database className='h-3.5 w-3.5' />,
  data: <LayoutGrid className='h-3.5 w-3.5' />,
  partner: <Handshake className='h-3.5 w-3.5' />,
  ai: <Bot className='h-3.5 w-3.5' />,
  realtime: <Radio className='h-3.5 w-3.5' />,
  panel: <PlugZap className='h-3.5 w-3.5' />
}

/** Clears what the scope pretends is down when the surface that owns it unmounts. */
export function usePretendDownScope(scope: string): void {
  useEffect(() => () => clearPretendDown(scope), [scope])
}

/** The ids one scope pretends are down, live. */
export function usePretendDownIds(scope: string): string[] {
  usePretendDownVersion()
  return getPretendDown(scope).map((d) => d.id)
}

/** Toggle one dependency and make the views ask again, so they meet the outage now. */
export function usePretendDownToggle(scope: string, options: PretendDownOption[]) {
  const qc = useQueryClient()
  return useCallback(
    (id: string) => {
      const current = new Set(getPretendDown(scope).map((d) => d.id))
      if (current.has(id)) current.delete(id)
      else current.add(id)
      setPretendDown(
        scope,
        options.filter((o) => current.has(o.id))
      )
      void qc.invalidateQueries({ refetchType: 'active' })
      if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(PRETEND_DOWN_EVENT))
    },
    [scope, options, qc]
  )
}

/** The toggle list — inside a host's own popover, or PretendDownButton's. */
export function PretendDownList({
  scope,
  options,
  className
}: {
  scope: string
  options: PretendDownOption[]
  className?: string
}) {
  const down = new Set(usePretendDownIds(scope))
  const toggle = usePretendDownToggle(scope, options)
  return (
    <div className={className}>
      <p className='text-[12px] font-medium text-slate-700 dark:text-foreground'>Pretend down</p>
      <p className='mt-0.5 text-[11.5px] leading-snug text-slate-500 dark:text-muted-foreground'>
        See how this view copes when something it uses fails. Only you, only here, until you leave.
      </p>
      {options.length === 0 ? (
        <p className='mt-2 text-[12px] text-slate-500 dark:text-muted-foreground'>
          This view uses nothing that can be pretended down yet.
        </p>
      ) : (
        <ul className='-mx-1.5 mt-1.5 space-y-px'>
          {options.map((o) => {
            const on = down.has(o.id)
            return (
              <li key={o.id}>
                <button
                  type='button'
                  role='switch'
                  aria-checked={on}
                  onClick={() => toggle(o.id)}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-md px-1.5 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50',
                    on ? 'bg-amber-50 dark:bg-amber-400/10' : 'hover:bg-muted'
                  )}
                >
                  <span
                    className={cn(
                      'flex h-6 w-6 shrink-0 items-center justify-center rounded-md',
                      on
                        ? 'bg-amber-100 text-amber-700 dark:bg-amber-400/15 dark:text-amber-300'
                        : 'bg-slate-100 text-slate-500 dark:bg-white/[0.06] dark:text-muted-foreground'
                    )}
                  >
                    {KIND_ICON[o.kind]}
                  </span>
                  <span className='min-w-0 flex-1'>
                    <span className='block truncate text-[12.5px] leading-tight'>{o.label}</span>
                    {(on || o.hint) && (
                      <span className='block truncate text-[11.5px] leading-snug text-slate-500 dark:text-muted-foreground'>
                        {on ? 'Pretending it is down' : o.hint}
                      </span>
                    )}
                  </span>
                  <span
                    aria-hidden
                    className={cn(
                      'relative h-4 w-7 shrink-0 rounded-full transition-colors motion-reduce:transition-none',
                      on ? 'bg-amber-500' : 'bg-slate-200 dark:bg-white/[0.15]'
                    )}
                  >
                    <span
                      className={cn(
                        'absolute top-0.5 h-3 w-3 rounded-full bg-white shadow-sm transition-transform motion-reduce:transition-none',
                        on ? 'translate-x-3.5' : 'translate-x-0.5'
                      )}
                    />
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

/**
 * A toolbar button with the list in an anchored popover. Hidden unless the chaos gate allows
 * browser chaos for this person (the same gate as the personal chaos toolbar).
 */
export function PretendDownButton({
  scope,
  options,
  user,
  className
}: {
  scope: string
  options: PretendDownOption[]
  user: ClientChaosUser | undefined
  className?: string
}) {
  const gate = useClientChaosGate(user)
  const count = usePretendDownIds(scope).length
  if (!gate.allowed) return null
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type='button'
          data-pretend-down=''
          data-tip='Pretend a dependency is down and see how this view copes (only you)'
          className={cn(
            'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-[12px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50',
            count > 0
              ? 'border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-200 dark:hover:bg-amber-400/15'
              : 'border-slate-200 text-slate-600 hover:bg-muted dark:border-border dark:text-muted-foreground',
            className
          )}
        >
          <PlugZap className='h-3.5 w-3.5' />
          <span>{count > 0 ? `${count} down` : 'Pretend down'}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align='end' className='w-[300px] p-3'>
        <PretendDownList scope={scope} options={options} />
      </PopoverContent>
    </Popover>
  )
}

/**
 * Whoever has a design surface open already holds the right to change it, and pretend down only
 * changes what their own tab sees: the server's chaos gate is the only check here.
 */
const DESIGNER: ClientChaosUser = { is_admin: true }

/** Inside the layout editor's Preview popover. */
export function PretendDownSection({
  scope,
  options
}: {
  scope: string
  options: PretendDownOption[]
}) {
  const gate = useClientChaosGate(DESIGNER)
  if (!gate.allowed) return null
  return (
    <PretendDownList
      scope={scope}
      options={options}
      className='mt-3 border-t border-slate-100 pt-3 dark:border-border'
    />
  )
}

// ── What a view depends on ────────────────────────────────────────────────────

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Everything every view can lean on: the AI gateway, partners and the realtime socket. */
export function commonPretendDownOptions(opts: { ai?: boolean; partners?: boolean } = {}) {
  const out: PretendDownOption[] = []
  if (opts.ai !== false)
    out.push({
      id: 'ai',
      kind: 'ai',
      label: 'AI gateway',
      hint: 'Ask AI, AI fill and summaries',
      patterns: [/^\/ai(\/|$)/, /^\/ask(\/|$)/]
    })
  if (opts.partners !== false)
    out.push({
      id: 'partners',
      kind: 'partner',
      label: 'Partners and external APIs',
      hint: 'Calls out to other systems',
      status: 502,
      patterns: [/^\/external-apis(\/|$)/, /^\/integrations?(\/|$)/, /^\/erp-submissions(\/|$)/]
    })
  out.push({
    id: 'realtime',
    kind: 'realtime',
    label: 'Live updates',
    hint: 'The socket: presence, live figures',
    patterns: [],
    socket: true
  })
  return out
}

interface AssignmentLike {
  field?: string | null
  widget_id?: unknown
  label?: string | null
}

const PANEL_DEPS: Array<{ field: string; id: string; label: string; patterns: RegExp[] }> = [
  {
    field: '__pipeline__',
    id: 'panel:pipeline',
    label: 'Pipeline panel',
    patterns: [/^\/pipelines\/instance(\/|$)/, /^\/workflows\/instance(\/|$)/]
  },
  { field: '__owners__', id: 'panel:owners', label: 'Owners panel', patterns: [/\/owners(\/|$)/] },
  {
    field: '__comments__',
    id: 'panel:comments',
    label: 'Comments panel',
    patterns: [/^\/comments(\/|$)/]
  },
  { field: '__tasks__', id: 'panel:tasks', label: 'Tasks panel', patterns: [/^\/tasks(\/|$)/] },
  {
    field: '__addendums__',
    id: 'panel:addendums',
    label: 'Addendums panel',
    patterns: [/^\/addendums(\/|$)/]
  },
  {
    field: '__related_records__',
    id: 'panel:related',
    label: 'Related records panel',
    patterns: [/^\/items\/[^/]+\/[^/]+\/related(\/|$)/, /^\/related-records(\/|$)/]
  },
  { field: '__pdf__', id: 'panel:pdf', label: 'PDF panel', patterns: [/^\/pdf(-templates)?(\/|$)/] }
]

/**
 * The dependencies a record form uses (layout editor, record-page Edit layout): its record
 * widgets (custom queries and rollups render through them), its built-in panels, then the AI
 * gateway, partners and live updates.
 */
export function layoutPretendDownOptions(
  layout: { assignments?: AssignmentLike[] | null } | null | undefined
): PretendDownOption[] {
  const assignments = layout?.assignments ?? []
  const out: PretendDownOption[] = []
  const widgetIds = new Map<string, string | null>()
  for (const a of assignments) {
    const field = a.field ?? ''
    if (field.startsWith('__widget_') && field.endsWith('__') && a.widget_id != null)
      widgetIds.set(String(a.widget_id), a.label?.trim() || null)
  }
  for (const [id, label] of widgetIds)
    out.push({
      id: `widget:${id}`,
      kind: 'query',
      label: label ?? `Record widget ${id}`,
      hint: 'Its query or rollup',
      status: 500,
      patterns: [new RegExp(`^/widgets-internal/${escapeRe(id)}(/|$)`)]
    })
  const fields = new Set(assignments.map((a) => a.field ?? ''))
  for (const p of PANEL_DEPS)
    if (fields.has(p.field))
      out.push({ id: p.id, kind: 'panel', label: p.label, patterns: p.patterns })
  return [...out, ...commonPretendDownOptions()]
}

/**
 * The dependencies a dashboard uses, grouped by source: each collection its widgets read, Ask AI
 * charts, report presets and pipeline flow widgets — every widget reads through
 * `/dashboards/widgets/<id>/data`, so each option names the widgets it feeds. Collections are
 * named by `labels` (collection key → display name) when the host has them, else title-cased.
 */
export function dashboardPretendDownOptions(
  widgets: Array<{
    id: string
    type: string
    collection?: string | null
    field?: string | null
  }>,
  labels: Record<string, string | null | undefined> = {}
): PretendDownOption[] {
  const groups = new Map<
    string,
    { label: string; kind: PretendDownKind; ids: string[]; extra: RegExp[] }
  >()
  const add = (
    key: string,
    label: string,
    kind: PretendDownKind,
    id: string,
    extra: RegExp[] = []
  ) => {
    const g = groups.get(key) ?? { label, kind, ids: [], extra: [] }
    g.ids.push(id)
    for (const r of extra) g.extra.push(r)
    groups.set(key, g)
  }
  for (const w of widgets) {
    if (w.type === 'ai_query') add('ai', 'Ask AI charts', 'ai', w.id)
    else if (w.type === 'report_preset')
      add('preset', 'Report presets', 'query', w.id, [
        /^\/report-studio\/widget-presets(\/|$)/,
        /^\/custom-queries(\/|$)/
      ])
    else if (w.type === 'cumulative_flow') add('flow', 'Pipeline flow', 'data', w.id)
    else if (w.collection)
      add(
        `c:${w.collection}`,
        labels[w.collection]?.trim() || titleCase(w.collection),
        'data',
        w.id
      )
  }
  const out: PretendDownOption[] = []
  for (const [key, g] of groups) {
    const ids = g.ids.map(escapeRe).join('|')
    out.push({
      id: `dash:${key}`,
      kind: g.kind,
      label: g.kind === 'data' && key.startsWith('c:') ? `${g.label} data` : g.label,
      hint: `${g.ids.length} widget${g.ids.length === 1 ? '' : 's'}`,
      status: 500,
      patterns: [new RegExp(`^/dashboards/widgets/(${ids})(/|$)`), ...g.extra]
    })
  }
  return [...out, ...commonPretendDownOptions({ partners: false })]
}
