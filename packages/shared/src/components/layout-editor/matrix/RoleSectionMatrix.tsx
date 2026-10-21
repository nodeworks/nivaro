import { useMemo } from 'react'
import type { GroupRow, LayoutBundle, LayoutOp } from '../../../lib/layout-ops'
import { cn, titleCase } from '../../../lib/utils'
import { Skeleton } from '../../ui/skeleton'
import type { DesignTarget, SelectOptions } from '../design-context'
import { fieldZones } from '../field-zones'
import { resetGroupPlan } from '../inheritance'
import { overrideGroupOps } from '../inspector/model'
import { LoadError } from '../load-error'
import type { ApplyOptions } from '../useLayoutDraft'
import {
  type CellTone,
  type Choice,
  InheritChip,
  MatrixCellButton,
  MatrixMenu,
  matrixCellTd,
  matrixCorner,
  matrixRowHead,
  matrixTh,
  useCellMenu
} from './MatrixGrid'
import { useMatrixRoles } from './matrix-api'
import {
  ACCESS_LABEL,
  ROLE_ACCESS,
  ROLE_SECTION_TYPES,
  type RoleAccess,
  roleAccess,
  roleAccessLabel,
  roleAccessOps
} from './role-matrix'

// Role × section matrix (#2645): sections down, roles across; each cell can
// edit / read-only / hidden, stored on the section (hidden_for_roles,
// locked_for_roles). One group_update per cell through the draft.

export interface RoleSectionMatrixProps {
  bundle: LayoutBundle
  parent: LayoutBundle | null
  apply: (ops: LayoutOp[], opts?: ApplyOptions) => void
  onSelect: (t: DesignTarget, opts?: SelectOptions) => void
}

type Source = 'own' | 'override' | 'inherited'
interface SectionRow {
  group: GroupRow
  label: string
  source: Source
}

const TONE: Record<RoleAccess, CellTone> = {
  edit: 'normal',
  readonly: 'readonly',
  hidden: 'hidden'
}
const EFFECT: Record<RoleAccess, string> = {
  edit: 'Sees the section; their field permissions decide the rest',
  readonly: 'Sees it but cannot change it; the server drops their writes',
  hidden: 'Does not see the section at all'
}

/** Sections and tabs that take a Who rule, in page order; the parent's after. */
export function sectionRows(bundle: LayoutBundle, parent: LayoutBundle | null): SectionRow[] {
  const parentKeys = new Set(parent?.groups.map((g) => g.key) ?? [])
  const rows: SectionRow[] = []
  const take = (b: LayoutBundle, source: (g: GroupRow) => Source | null) => {
    for (const z of fieldZones(b)) {
      if (z.key == null) continue
      const g = b.groups.find((x) => x.key === z.key)
      if (!g || !ROLE_SECTION_TYPES.has(g.type)) continue
      const s = source(g)
      if (s) rows.push({ group: g, label: z.label, source: s })
    }
  }
  take(bundle, (g) => (parentKeys.has(g.key) ? 'override' : 'own'))
  if (parent) {
    const own = new Set(bundle.groups.map((g) => g.key))
    take(parent, (g) => (own.has(g.key) ? null : 'inherited'))
  }
  return rows
}

export function RoleSectionMatrix({ bundle, parent, apply, onSelect }: RoleSectionMatrixProps) {
  const { data: roles = [], isLoading, isError, refetch } = useMatrixRoles()
  const menu = useCellMenu()
  const rows = useMemo(() => sectionRows(bundle, parent), [bundle, parent])
  const parentName = String(parent?.layout.name ?? 'the parent layout')
  const nameOf = (g: GroupRow) => g.label || titleCase(g.key)

  const open = useMemo(() => {
    if (!menu.open) return null
    const [key, roleId] = menu.open.split('|')
    const row = rows.find((r) => r.group.key === key && r.source !== 'inherited')
    const role = roles.find((r) => r.id === roleId)
    return row && role ? { row, role } : null
  }, [menu.open, rows, roles])

  const choices: Choice<RoleAccess>[] = ROLE_ACCESS.map((a) => ({
    value: a,
    label: ACCESS_LABEL[a],
    tone: TONE[a],
    effect: EFFECT[a],
    blocked: null
  }))

  const pick = (to: RoleAccess) => {
    if (!open) return
    const ops = roleAccessOps(open.row.group, open.role.id, to)
    if (ops.length)
      apply(ops, { label: roleAccessLabel(nameOf(open.row.group), open.role.name, to) })
  }

  return (
    <div data-role-section-matrix='' className='flex min-h-full flex-col gap-2 p-4'>
      <p className='m-0 text-[12px] text-slate-500 dark:text-muted-foreground'>
        Who sees and edits each section. Field permissions still apply inside a section;
        administrators always see and edit everything.
      </p>
      {isLoading ? (
        <Skeleton className='h-48 w-full rounded-lg' />
      ) : isError ? (
        <LoadError what='the roles' onRetry={() => void refetch()} />
      ) : (
        <MatrixMenu
          menu={menu}
          title={open ? `${nameOf(open.row.group)} · ${open.role.name}` : ''}
          choices={choices}
          current={open ? roleAccess(open.row.group, open.role.id) : null}
          onPick={pick}
        >
          <div className='min-h-0 flex-1 overflow-auto rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
            <table className='border-separate border-spacing-0 text-[12.5px]'>
              <thead>
                <tr>
                  <th className={matrixCorner}>Section</th>
                  {roles.map((r) => (
                    <th
                      key={r.id}
                      data-matrix-role={r.id}
                      className={cn(matrixTh, 'text-center')}
                      data-tip={
                        r.admin_access ? 'Administrators see and edit every section' : undefined
                      }
                    >
                      {r.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const name = nameOf(r.group)
                  const reset =
                    r.source === 'override' && parent
                      ? resetGroupPlan(bundle, parent, r.group.key)
                      : null
                  return (
                    <tr key={`${r.source}:${r.group.key}`} data-matrix-row={r.group.key}>
                      <th scope='row' className={matrixRowHead}>
                        <button
                          type='button'
                          onClick={() => onSelect({ kind: 'group', key: r.group.key })}
                          data-tip='Select it on the form'
                          className='block max-w-full truncate text-left font-medium text-slate-800 hover:underline dark:text-foreground'
                        >
                          {r.label}
                        </button>
                        {r.source !== 'own' && parent && (
                          <InheritChip
                            kind={r.source === 'inherited' ? 'inherited' : 'override'}
                            parentName={parentName}
                            action={r.source === 'inherited' ? 'override' : 'reset'}
                            actionLabel={
                              r.source === 'inherited'
                                ? `Override ${name} on this form`
                                : `Reset ${name} to ${parentName}`
                            }
                            actionTip={
                              r.source === 'inherited'
                                ? 'Copy the section onto this form to change it here'
                                : reset?.ok
                                  ? resetTip(reset.ungrouped.length, parentName)
                                  : (reset?.why ?? '')
                            }
                            blocked={r.source === 'override' && !reset?.ok}
                            onAction={() => {
                              if (r.source === 'inherited')
                                apply(overrideGroupOps(bundle, parent, r.group), {
                                  label: `Override ${name} on this form`
                                })
                              else if (reset?.ok)
                                apply(reset.ops, { label: `Reset ${name} to ${parentName}` })
                            }}
                          />
                        )}
                      </th>
                      {roles.map((role) => {
                        const a = roleAccess(r.group, role.id)
                        const locked = role.admin_access
                          ? 'Administrators see and edit every section'
                          : r.source === 'inherited'
                            ? `From ${parentName} — override it to change it here`
                            : null
                        return (
                          <td key={role.id} className={matrixCellTd}>
                            <MatrixCellButton
                              cellKey={`${r.group.key}|${role.id}`}
                              tone={role.admin_access ? 'normal' : TONE[a]}
                              word={role.admin_access ? 'Can edit' : ACCESS_LABEL[a]}
                              tip={`${role.name}: ${EFFECT[a].toLowerCase()}`}
                              locked={locked}
                              label={`${name} for ${role.name}: ${ACCESS_LABEL[a]}`}
                              menu={menu}
                            />
                          </td>
                        )
                      })}
                    </tr>
                  )
                })}
                {rows.length === 0 && (
                  <tr>
                    <td
                      colSpan={roles.length + 1}
                      className='px-3 py-6 text-center text-[12.5px] text-slate-500 dark:text-muted-foreground'
                    >
                      No sections on this form. Fields outside sections follow field permissions
                      only.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </MatrixMenu>
      )}
    </div>
  )
}

function resetTip(ungrouped: number, parentName: string): string {
  const base = `Take ${parentName}'s section again`
  return ungrouped
    ? `${base}; ${ungrouped} ${ungrouped === 1 ? 'field' : 'fields'} only this form places move to Ungrouped`
    : base
}
