export type ImportOnMiss = 'leave_blank' | 'error' | 'create_stub' | 'create'

export interface ImportLookupCreate {
  defaults: ImportHeaderRule[]
  dedupe_by: string[]
}

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
      take: 'id' | 'record' | 'field'
      take_field?: string
      create?: ImportLookupCreate
    }
  | { type: 'wrap_richtext' }
  | { type: 'const'; value: unknown }

export interface ImportHeaderRule {
  target: string
  source: string | null
  steps: ImportStep[]
}

export interface ImportNestedConfig {
  target_field: string
  when: { column: string; op: 'nnull' | 'eq' | 'neq'; value?: string } | null
  columns: ImportHeaderRule[]
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
  nested: ImportNestedConfig | null
}

export interface ImportReimportConfig {
  enabled: boolean
  header_fields: 'overwrite' | 'fill_empty' | 'skip'
  lines: 'replace' | 'upsert' | 'upsert_delete' | 'append'
  match_by: string[]
  attachments: 'add' | 'replace'
}

export interface ImportTemplateConfig {
  file_types: ('xlsx' | 'xlsm' | 'xls' | 'csv')[]
  sheet_match: string | null
  header_row: number
  header_map: ImportHeaderRule[]
  line_map: ImportLineConfig | null
  attach_file_field: string | null
  reimport?: ImportReimportConfig | null
}

export interface ConfigError {
  path: string
  message: string
}

const ON_MISS = ['leave_blank', 'error', 'create_stub', 'create'] as const
const TAKE = ['id', 'record', 'field'] as const
const FILE_TYPES = ['xlsx', 'xlsm', 'xls', 'csv'] as const
const DEFAULT_FILE_TYPES: ImportTemplateConfig['file_types'] = ['xlsx', 'xlsm', 'csv']
const ROW_FILTER_OPS = ['nnull', 'eq', 'neq'] as const
const USERS_SENTINEL = '$users'
const USERS_ALLOWED_MATCH_FIELDS = ['email']
const REIMPORT_HEADER_FIELDS = ['overwrite', 'fill_empty', 'skip'] as const
const REIMPORT_LINES = ['replace', 'upsert', 'upsert_delete', 'append'] as const
const REIMPORT_ATTACHMENTS = ['add', 'replace'] as const

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
      const collection = src.collection as string
      const matchField = src.match_field as string
      const filters = Array.isArray(src.scope_filters) ? src.scope_filters : []
      let take: 'id' | 'record' | 'field' = TAKE.includes(src.take as 'id' | 'record' | 'field')
        ? (src.take as 'id' | 'record' | 'field')
        : 'id'
      let takeField = typeof src.take_field === 'string' ? src.take_field : ''
      let onMiss: ImportOnMiss = ON_MISS.includes(src.on_miss as ImportOnMiss)
        ? (src.on_miss as ImportOnMiss)
        : 'leave_blank'
      if (collection === USERS_SENTINEL) {
        take = 'id'
        takeField = ''
        if (!USERS_ALLOWED_MATCH_FIELDS.includes(matchField)) {
          errors.push({
            path,
            message: `$users lookups may only match on: ${USERS_ALLOWED_MATCH_FIELDS.join(', ')}`
          })
        }
        if (onMiss === 'create') {
          errors.push({ path, message: '$users lookups may not use on_miss "create"' })
          onMiss = 'leave_blank'
        }
      }
      if (take === 'field' && takeField === '') {
        errors.push({ path, message: 'take "field" requires "take_field"' })
      }
      let create: ImportLookupCreate | undefined
      if (onMiss === 'create') {
        const createSrc = asObject(src.create)
        const defaultsRaw = Array.isArray(createSrc.defaults) ? createSrc.defaults : []
        const defaults: ImportHeaderRule[] = []
        defaultsRaw.forEach((rule, i) => {
          const normalized = normalizeRule(rule, `${path}.create.defaults[${i}]`, errors)
          if (normalized) defaults.push(normalized)
        })
        if (defaults.some((d) => d.steps.some((s) => s.type === 'lookup'))) {
          errors.push({ path, message: 'create defaults may not contain lookup steps' })
        }
        const dedupeBy = Array.isArray(createSrc.dedupe_by)
          ? createSrc.dedupe_by.filter((v): v is string => typeof v === 'string' && v !== '')
          : []
        if (dedupeBy.length === 0) {
          errors.push({ path, message: 'create requires a non-empty "dedupe_by"' })
        }
        create = { defaults, dedupe_by: dedupeBy }
      }
      return {
        type: 'lookup',
        collection,
        match_field: matchField,
        scope_filters: filters
          .map((f) => asObject(f))
          .filter((f) => typeof f.field === 'string' && typeof f.value === 'string')
          .map((f) => ({
            field: f.field as string,
            op: f.op === 'neq' ? ('neq' as const) : ('eq' as const),
            value: f.value as string
          })),
        on_miss: onMiss,
        take,
        ...(take === 'field' ? { take_field: takeField } : {}),
        ...(create ? { create } : {})
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

function normalizeNested(
  raw: unknown,
  path: string,
  errors: ConfigError[]
): ImportNestedConfig | null {
  const src = asObject(raw)
  if (typeof src.target_field !== 'string' || src.target_field === '') {
    errors.push({ path, message: 'nested requires "target_field"' })
    return null
  }
  const whenSrc = asObject(src.when)
  let when: ImportNestedConfig['when'] = null
  if (src.when != null) {
    if (
      typeof whenSrc.column === 'string' &&
      ROW_FILTER_OPS.includes(whenSrc.op as (typeof ROW_FILTER_OPS)[number])
    ) {
      when = {
        column: whenSrc.column,
        op: whenSrc.op as 'nnull' | 'eq' | 'neq',
        ...(typeof whenSrc.value === 'string' ? { value: whenSrc.value } : {})
      }
    }
  }
  const columnsRaw = Array.isArray(src.columns) ? src.columns : []
  const columns: ImportHeaderRule[] = []
  columnsRaw.forEach((col, i) => {
    const normalized = normalizeRule(col, `${path}.columns[${i}]`, errors)
    if (normalized) columns.push(normalized)
  })
  return {
    target_field: src.target_field,
    when,
    columns
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
  const nested = src.nested != null ? normalizeNested(src.nested, `${path}.nested`, errors) : null
  return {
    target_field: src.target_field,
    row_filter: rowFilter,
    columns,
    apply_field_rules: src.apply_field_rules !== false,
    disperse,
    nested
  }
}

function normalizeReimport(
  raw: unknown,
  lineMap: ImportLineConfig | null,
  errors: ConfigError[]
): ImportReimportConfig | null {
  if (raw == null) return null
  const src = asObject(raw)
  const path = 'reimport'
  const enabled = src.enabled === true

  let headerFields: ImportReimportConfig['header_fields'] = 'overwrite'
  if (src.header_fields !== undefined) {
    if (
      REIMPORT_HEADER_FIELDS.includes(src.header_fields as (typeof REIMPORT_HEADER_FIELDS)[number])
    ) {
      headerFields = src.header_fields as ImportReimportConfig['header_fields']
    } else {
      errors.push({
        path: `${path}.header_fields`,
        message: `Unknown header_fields "${src.header_fields}"`
      })
    }
  }

  let lines: ImportReimportConfig['lines'] = 'upsert_delete'
  if (src.lines !== undefined) {
    if (REIMPORT_LINES.includes(src.lines as (typeof REIMPORT_LINES)[number])) {
      lines = src.lines as ImportReimportConfig['lines']
    } else {
      errors.push({ path: `${path}.lines`, message: `Unknown lines "${src.lines}"` })
    }
  }

  let attachments: ImportReimportConfig['attachments'] = 'add'
  if (src.attachments !== undefined) {
    if (REIMPORT_ATTACHMENTS.includes(src.attachments as (typeof REIMPORT_ATTACHMENTS)[number])) {
      attachments = src.attachments as ImportReimportConfig['attachments']
    } else {
      errors.push({
        path: `${path}.attachments`,
        message: `Unknown attachments "${src.attachments}"`
      })
    }
  }

  const matchBy = Array.isArray(src.match_by)
    ? src.match_by.filter((v): v is string => typeof v === 'string' && v !== '')
    : []

  if (enabled) {
    if ((lines === 'upsert' || lines === 'upsert_delete') && matchBy.length === 0) {
      errors.push({
        path: `${path}.match_by`,
        message: 'match_by is required when lines is "upsert" or "upsert_delete"'
      })
    }
    if (lineMap) {
      const targetColumns = new Set(lineMap.columns.map((c) => c.target))
      for (const col of matchBy) {
        if (!targetColumns.has(col)) {
          errors.push({
            path: `${path}.match_by`,
            message: `match_by column "${col}" is not a line_map target column`
          })
        }
      }
    }
  }

  return { enabled, header_fields: headerFields, lines, match_by: matchBy, attachments }
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

  const reimport = normalizeReimport(src.reimport, lineMap, errors)

  const config: ImportTemplateConfig = {
    file_types: fileTypes.length > 0 ? fileTypes : [...DEFAULT_FILE_TYPES],
    sheet_match: typeof src.sheet_match === 'string' ? src.sheet_match : null,
    header_row: Math.max(1, Number(src.header_row) || 1),
    header_map: headerMap,
    line_map: lineMap,
    attach_file_field: typeof src.attach_file_field === 'string' ? src.attach_file_field : null,
    reimport
  }

  return { config, errors }
}
