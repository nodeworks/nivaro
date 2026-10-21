import { titleCase } from '../../lib/utils'

// Plain names for the slot and panel keys (`__pipeline__`, `__ext_x__`,
// `__widget_7__` …) — the one helper the Add panel and the Inspector share.

const SLOT_NAMES: Record<string, string> = {
  __pipeline__: 'Pipeline',
  __comments__: 'Comments',
  __tasks__: 'Tasks',
  __owners__: 'Owners',
  __pdf__: 'PDF button',
  __subtitle__: 'Subtitle',
  __addendums__: 'Addendums',
  __referenced_by__: 'Referenced by',
  __related_records__: 'Related records',
  __ungrouped_pos__: 'Fields outside sections'
}

export function slotName(field: string): string {
  if (SLOT_NAMES[field]) return SLOT_NAMES[field]
  const ext = field.match(/^__ext_([a-z][a-z0-9-]*)__$/)
  if (ext) return titleCase(ext[1].replace(/-/g, '_'))
  if (/^__widget_\d+__$/.test(field)) return 'Widget'
  return titleCase(field.replace(/^_+|_+$/g, ''))
}
