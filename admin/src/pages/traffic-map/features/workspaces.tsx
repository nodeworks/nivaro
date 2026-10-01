import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useTrafficMap } from '../context'
import { entityLabel, fmtCount, fmtPct } from '../EventTicker'
import { Bar, Section } from '../Inspector'
import { inspectorPanels } from '../registry/inspectorPanels'
import { pagePanels } from '../registry/pagePanels'
import { register } from '../registry/registry'
import { toolbarItems } from '../registry/toolbarItems'
import type { Selection } from '../types'
import { createStore, inPage, useEntityDetail, useLens, useStore } from './b1-shared'

/**
 * #1154 — traffic by workspace (multi-workspace instances). When more than one workspace is
 * seen, a Workspace chip group appears beside the filters; picking one opens its traffic (busiest
 * entities, errors), and the inspector splits an entity's requests by workspace.
 */
export const WORKSPACES_TAP = 'workspaces'
export const workspaceFocus = createStore<string>('')

export interface WsRow {
  id: string
  req: number
  error: number
  entities: Array<{ key: string; n: number }>
}

function useWorkspaceNames(): (id: string) => string {
  const q = useQuery({
    queryKey: ['traffic-map', 'workspaces'],
    queryFn: async () =>
      (await api.get('/traffic-map/workspaces')).data.data as Record<string, string>,
    staleTime: 300_000
  })
  return (id) =>
    q.data?.[id] ?? (id === '00000000-0000-0000-0000-000000000001' ? 'Default' : id.slice(0, 8))
}

const CHIP =
  'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-[3px] text-[12px] font-medium leading-tight transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--tm-card)]'
const ON =
  'border-[color-mix(in_srgb,var(--tm-accent)_55%,var(--tm-line))] bg-[var(--tm-accent-soft)] text-[var(--tm-accent-ink)]'
const OFF =
  'border-[var(--tm-line)] bg-[var(--tm-card)] text-[var(--tm-fg-2)] hover:bg-[var(--tm-card-2)]'

function WorkspaceChips() {
  const focus = useStore(workspaceFocus)
  const name = useWorkspaceNames()
  const { data } = useLens<{ workspaces: WsRow[] }>(WORKSPACES_TAP)
  const list = data?.workspaces ?? []
  if (list.length < 2 && !focus) return null
  return (
    <fieldset
      className='flex min-w-0 flex-wrap items-center gap-1'
      aria-label='Workspace'
      id='tm-workspaces'
    >
      <span className='mr-0.5 text-[12px] font-medium text-[var(--tm-muted)]'>Workspace</span>
      <button
        type='button'
        aria-pressed={!focus}
        onClick={() => workspaceFocus.set('')}
        className={cn(CHIP, !focus ? ON : OFF)}
      >
        All
      </button>
      {list.slice(0, 6).map((w) => (
        <button
          key={w.id}
          type='button'
          aria-pressed={focus === w.id}
          data-tm-workspace={w.id}
          onClick={() => workspaceFocus.set(focus === w.id ? '' : w.id)}
          className={cn(CHIP, focus === w.id ? ON : OFF)}
        >
          {name(w.id)}
          <span className='tabular-nums text-[var(--tm-fg-2)]'>{fmtCount(w.req)}</span>
        </button>
      ))}
    </fieldset>
  )
}

function WorkspacePanel() {
  const focus = useStore(workspaceFocus)
  const name = useWorkspaceNames()
  const { catalog, setSelection } = useTrafficMap()
  const { data } = useLens<{ workspaces: WsRow[] }>(WORKSPACES_TAP)
  const w = data?.workspaces.find((x) => x.id === focus)
  if (!focus) return null
  return (
    <section
      className='min-w-0 rounded-lg border border-[var(--tm-line)] bg-[var(--tm-card)]'
      aria-label='Workspace traffic'
      id='tm-workspace-panel'
    >
      <div className='flex items-start justify-between gap-3 border-b border-[var(--tm-line-2)] px-3.5 py-2'>
        <div className='min-w-0'>
          <h2 className='truncate text-[13px] font-semibold'>{name(focus)}</h2>
          <p className='text-[11.5px] tabular-nums text-[var(--tm-muted)]'>
            {w
              ? `${fmtCount(w.req)} requests · ${fmtPct(w.req ? (100 * w.error) / w.req : Number.NaN)} errors in the window`
              : 'No traffic in this window.'}
          </p>
        </div>
        <button type='button' onClick={() => workspaceFocus.set('')} className={cn(CHIP, OFF)}>
          Close
        </button>
      </div>
      <div className='grid gap-1.5 px-3.5 py-2.5'>
        {(w?.entities ?? []).map((e) => {
          const cut = e.key.indexOf('/')
          return (
            <button
              key={e.key}
              type='button'
              className='rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
              onClick={() => setSelection({ kind: 'entity', id: e.key })}
            >
              <Bar
                label={entityLabel(catalog, e.key.slice(0, cut), e.key.slice(cut + 1))}
                n={e.n}
                max={w?.entities[0]?.n ?? 1}
              />
            </button>
          )
        })}
      </div>
    </section>
  )
}

function EntityWorkspaces({ sel }: { sel: Selection }) {
  const { model } = useTrafficMap()
  const name = useWorkspaceNames()
  const detail = useEntityDetail(sel.id)
  const by = (detail?.[WORKSPACES_TAP] ?? model.entityMeta(sel.id)?.ext?.[WORKSPACES_TAP]) as
    | Record<string, number>
    | undefined
  const rows = Object.entries(by ?? {}).sort((a, b) => b[1] - a[1])
  if (rows.length < 2) return null
  return (
    <Section title='By workspace'>
      <div className='grid gap-1.5' id='tm-entity-workspaces'>
        {rows.map(([id, n]) => (
          <Bar key={id} label={name(id)} n={n} max={rows[0][1]} mono={false} />
        ))}
      </div>
    </Section>
  )
}

register(toolbarItems, { id: 'workspaces', order: 30, Component: inPage(WorkspaceChips) })
register(pagePanels, { id: 'workspaces', order: 10, Component: inPage(WorkspacePanel) })
register(inspectorPanels, {
  id: 'workspaces',
  order: 60,
  applies: (sel) => sel.kind === 'entity',
  Component: inPage(EntityWorkspaces)
})
