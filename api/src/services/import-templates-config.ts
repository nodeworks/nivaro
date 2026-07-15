export type ImportOnMiss = 'leave_blank' | 'error' | 'create_stub'

export type ImportStep =
  | { type: 'trim' }
  | { type: 'remap'; map: Record<string, string>; passthrough: boolean }
  | { type: 'expression'; template: string }
  | {
      type: 'lookup'
      collection: string
      match_field: string
      scope_filters: { field: string; op: 'eq' | 'neq'; value: string }[]
      on_miss: ImportOnMiss
      take: 'id' | 'record'
    }
  | { type: 'wrap_richtext' }
  | { type: 'const'; value: unknown }

export interface ImportHeaderRule {
  target: string
  source: string | null
  steps: ImportStep[]
}

export interface ImportDisperseConfig {
  map_collection: string
  map_key_column: string
  map_key_field: string
  map_values_path: string
  map_all_field: string | null
  member_match_column: string
  group_by_column: string
  amount_column: string
  nested_target: string
  split: 'even'
  member_columns: ImportHeaderRule[]
}

export interface ImportLineConfig {
  target_field: string
  row_filter: { column: string; op: 'nnull' | 'eq' | 'neq'; value?: string } | null
  columns: ImportHeaderRule[]
  apply_field_rules: boolean
  disperse: ImportDisperseConfig | null
}

export interface ImportTemplateConfig {
  file_types: ('xlsx' | 'xlsm' | 'xls' | 'csv')[]
  sheet_match: string | null
  header_row: number
  header_map: ImportHeaderRule[]
  line_map: ImportLineConfig | null
  attach_file_field: string | null
}

export interface ConfigError {
  path: string
  message: string
}

const ON_MISS = ['leave_blank', 'error', 'create_stub'] as const
const TAKE = ['id', 'record'] as const
const FILE_TYPES = ['xlsx', 'xlsm', 'xls', 'csv'] as const
const DEFAULT_FILE_TYPES: ImportTemplateConfig['file_types'] = ['xlsx', 'xlsm', 'csv']
const ROW_FILTER_OPS = ['nnull', 'eq', 'neq'] as const

function asObject(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {}
}

function normalizeStep(raw: unknown, path: string, errors: ConfigError[]): ImportStep | null {
  const src = asObject(raw)
  const type = src.type as string
  switch (type) {
    case 'trim':
      return { type: 'trim' }
    case 'remap': {
      const map = asObject(src.map)
      const clean: Record<string, string> = {}
      for (const [k, v] of Object.entries(map)) if (typeof v === 'string') clean[k] = v
      return { type: 'remap', map: clean, passthrough: src.passthrough !== false }
    }
    case 'expression': {
      if (typeof src.template !== 'string' || src.template === '') {
        errors.push({ path, message: 'expression requires "template"' })
        return null
      }
      return { type: 'expression', template: src.template }
    }
    case 'lookup': {
      let ok = true
      if (typeof src.collection !== 'string' || src.collection === '') {
        errors.push({ path, message: 'lookup requires "collection"' })
        ok = false
      }
      if (typeof src.match_field !== 'string' || src.match_field === '') {
        errors.push({ path, message: 'lookup requires "match_field"' })
        ok = false
      }
      if (!ok) return null
      const filters = Array.isArray(src.scope_filters) ? src.scope_filters : []
      return {
        type: 'lookup',
        collection: src.collection as string,
        match_field: src.match_field as string,
        scope_filters: filters
          .map((f) => asObject(f))
          .filter((f) => typeof f.field === 'string' && typeof f.value === 'string')
          .map((f) => ({
            field: f.field as string,
            op: f.op === 'neq' ? ('neq' as const) : ('eq' as const),
            value: f.value as string
          })),
        on_miss: ON_MISS.includes(src.on_miss as ImportOnMiss)
          ? (src.on_miss as ImportOnMiss)
          : 'leave_blank',
        take: TAKE.includes(src.take as 'id' | 'record') ? (src.take as 'id' | 'record') : 'id'
      }
    }
    case 'wrap_richtext':
      return { type: 'wrap_richtext' }
    case 'const':
      return { type: 'const', value: src.value }
    default:
      errors.push({ path, message: `Unknown step type "${type}"` })
      return null
  }
}

function normalizeRule(raw: unknown, path: string, errors: ConfigError[]): ImportHeaderRule | null {
  const src = asObject(raw)
  if (typeof src.target !== 'string' || src.target === '') {
    errors.push({ path, message: 'rule requires "target"' })
    return null
  }
  const steps = Array.isArray(src.steps) ? src.steps : []
  const normalizedSteps: ImportStep[] = []
  steps.forEach((step, i) => {
    const normalized = normalizeStep(step, `${path}.steps[${i}]`, errors)
    if (normalized) normalizedSteps.push(normalized)
  })
  // The pipeline resolves exactly one lookup per rule (foldStepsSync's pre-lookup
  // slice assumes no earlier lookup); reject configs that would silently drop one.
  if (normalizedSteps.filter((s) => s.type === 'lookup').length > 1) {
    errors.push({ path, message: 'Only one lookup step per rule' })
  }
  return {
    target: src.target,
    source: typeof src.source === 'string' ? src.source : null,
    steps: normalizedSteps
  }
}

function normalizeDisperse(
  raw: unknown,
  path: string,
  errors: ConfigError[]
): ImportDisperseConfig | null {
  const src = asObject(raw)
  const requiredStrings = [
    'map_collection',
    'map_key_column',
    'map_key_field',
    'map_values_path',
    'member_match_column',
    'group_by_column',
    'amount_column',
    'nested_target'
  ] as const
  let ok = true
  for (const field of requiredStrings) {
    if (typeof src[field] !== 'string' || src[field] === '') {
      errors.push({ path, message: `disperse requires "${field}"` })
      ok = false
    }
  }
  if (!ok) return null
  const memberColumnsRaw = Array.isArray(src.member_columns) ? src.member_columns : []
  const memberColumns: ImportHeaderRule[] = []
  memberColumnsRaw.forEach((rule, i) => {
    const normalized = normalizeRule(rule, `${path}.member_columns[${i}]`, errors)
    if (normalized) memberColumns.push(normalized)
  })
  return {
    map_collection: src.map_collection as string,
    map_key_column: src.map_key_column as string,
    map_key_field: src.map_key_field as string,
    map_values_path: src.map_values_path as string,
    map_all_field: typeof src.map_all_field === 'string' ? src.map_all_field : null,
    member_match_column: src.member_match_column as string,
    group_by_column: src.group_by_column as string,
    amount_column: src.amount_column as string,
    nested_target: src.nested_target as string,
    split: 'even',
    member_columns: memberColumns
  }
}

function normalizeLineConfig(
  raw: unknown,
  path: string,
  errors: ConfigError[]
): ImportLineConfig | null {
  const src = asObject(raw)
  if (typeof src.target_field !== 'string' || src.target_field === '') {
    errors.push({ path, message: 'line_map requires "target_field"' })
    return null
  }
  const rowFilterSrc = asObject(src.row_filter)
  let rowFilter: ImportLineConfig['row_filter'] = null
  if (src.row_filter != null) {
    if (
      typeof rowFilterSrc.column === 'string' &&
      ROW_FILTER_OPS.includes(rowFilterSrc.op as (typeof ROW_FILTER_OPS)[number])
    ) {
      rowFilter = {
        column: rowFilterSrc.column,
        op: rowFilterSrc.op as 'nnull' | 'eq' | 'neq',
        ...(typeof rowFilterSrc.value === 'string' ? { value: rowFilterSrc.value } : {})
      }
    }
  }
  const columnsRaw = Array.isArray(src.columns) ? src.columns : []
  const columns: ImportHeaderRule[] = []
  columnsRaw.forEach((col, i) => {
    const normalized = normalizeRule(col, `${path}.columns[${i}]`, errors)
    if (normalized) columns.push(normalized)
  })
  const disperse =
    src.disperse != null ? normalizeDisperse(src.disperse, `${path}.disperse`, errors) : null
  return {
    target_field: src.target_field,
    row_filter: rowFilter,
    columns,
    apply_field_rules: src.apply_field_rules !== false,
    disperse
  }
}

export function normalizeImportTemplateConfig(raw: unknown): {
  config: ImportTemplateConfig
  errors: ConfigError[]
} {
  const errors: ConfigError[] = []
  const src = asObject(raw)

  const fileTypesRaw = Array.isArray(src.file_types) ? src.file_types : null
  const fileTypes = fileTypesRaw
    ? fileTypesRaw.filter((t): t is (typeof FILE_TYPES)[number] =>
        FILE_TYPES.includes(t as (typeof FILE_TYPES)[number])
      )
    : [...DEFAULT_FILE_TYPES]

  const headerMapRaw = Array.isArray(src.header_map) ? src.header_map : []
  const headerMap: ImportHeaderRule[] = []
  headerMapRaw.forEach((rule, i) => {
    const normalized = normalizeRule(rule, `header_map[${i}]`, errors)
    if (normalized) headerMap.push(normalized)
  })

  const lineMap =
    src.line_map != null ? normalizeLineConfig(src.line_map, 'line_map', errors) : null

  const config: ImportTemplateConfig = {
    file_types: fileTypes.length > 0 ? fileTypes : [...DEFAULT_FILE_TYPES],
    sheet_match: typeof src.sheet_match === 'string' ? src.sheet_match : null,
    header_row: Math.max(1, Number(src.header_row) || 1),
    header_map: headerMap,
    line_map: lineMap,
    attach_file_field: typeof src.attach_file_field === 'string' ? src.attach_file_field : null
  }

  return { config, errors }
}
