import type { LayoutBundle, LayoutOp } from '../../lib/layout-ops'
import { titleCase } from '../../lib/utils'
import type { DesignTarget } from './design-context'
import { useOverviewFields } from './overview/overview-api'
import type { ApplyOptions } from './useLayoutDraft'

// The editor's right-hand panel: the one place its parts are chosen. Form
// settings is the real one; the Inspector below is a placeholder that names
// what is selected until inspector/Inspector.tsx lands, which takes exactly
// InspectorProps — the swap is this file re-exporting it:
//   export { Inspector, type InspectorProps } from './inspector/Inspector'

export { FormSettings, type FormSettingsProps } from './settings'

export interface InspectorProps {
  bundle: LayoutBundle
  target: DesignTarget | null
  apply(ops: LayoutOp[], opts?: ApplyOptions): void
  /** useLayoutDraft's flush — typed text goes out on blur. */
  flush?: () => void
  collection: string
  /** "Edit in <parent>": switch the editor to that layout. */
  openLayout?: (layoutId: number) => void
}

const SLOT_NAMES: Record<string, string> = {
  __pipeline__: 'Pipeline',
  __comments__: 'Comments',
  __tasks__: 'Tasks',
  __owners__: 'Owners',
  __pdf__: 'PDF',
  __subtitle__: 'Subtitle',
  __addendums__: 'Addendums',
  __referenced_by__: 'Referenced by',
  __related_records__: 'Related records'
}

export function slotName(field: string): string {
  if (SLOT_NAMES[field]) return SLOT_NAMES[field]
  const ext = field.match(/^__ext_([a-z][a-z0-9-]*)__$/)
  if (ext) return titleCase(ext[1].replace(/-/g, '_'))
  if (/^__widget_\d+__$/.test(field)) return 'Widget'
  return titleCase(field.replace(/^_+|_+$/g, ''))
}

function useTargetTitle(bundle: LayoutBundle, target: DesignTarget, collection: string) {
  const { data: fields = [] } = useOverviewFields(collection)
  const groupLabel = (key: string | null) =>
    key === null || key === '__ungrouped__'
      ? 'Ungrouped'
      : key === '__header__'
        ? 'Header strip'
        : (bundle.groups.find((g) => g.key === key)?.label ?? key)
  if (target.kind === 'group') {
    const g = bundle.groups.find((x) => x.key === target.key)
    const kind = g?.type === 'tab' ? 'Tab' : g?.type === 'container' ? 'Tabs' : 'Section'
    return { kind, title: groupLabel(target.key), sub: null as string | null }
  }
  const field = target.field
  const where = groupLabel(target.kind === 'header' ? '__header__' : target.group_key)
  if (field.startsWith('__')) return { kind: `Panel · ${where}`, title: slotName(field), sub: null }
  const f = fields.find((x) => x.field === field)
  return {
    kind: `Field · ${where}`,
    title: f?.label || titleCase(field),
    sub: field
  }
}

/** Placeholder until inspector/Inspector.tsx lands. */
export function Inspector({ bundle, target, collection }: InspectorProps) {
  if (!target)
    return (
      <p className='px-4 py-6 text-[12.5px] text-slate-500 dark:text-muted-foreground'>
        Click a field, section or panel on the form to change it here.
      </p>
    )
  return <InspectorHead bundle={bundle} target={target} collection={collection} />
}

function InspectorHead({
  bundle,
  target,
  collection
}: {
  bundle: LayoutBundle
  target: DesignTarget
  collection: string
}) {
  const { kind, title, sub } = useTargetTitle(bundle, target, collection)
  return (
    <div className='border-b border-slate-200 px-4 py-3.5 dark:border-border'>
      <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>{kind}</p>
      <h3 className='text-[14px] font-semibold text-slate-900 dark:text-foreground'>{title}</h3>
      {sub && <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>{sub}</p>}
    </div>
  )
}
