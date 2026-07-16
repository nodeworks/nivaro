import type {
  ImportDisperseConfig,
  ImportHeaderRule,
  ImportLookupCreate,
  ImportNestedConfig,
  ImportStep,
  ImportTemplateConfig
} from './import-templates-config.js'

export interface ImportIssue {
  severity: 'warn' | 'error'
  rule: string // e.g. 'header:vendor' | 'line[3]:unit' | 'disperse'
  row?: number // 1-based sheet data row
  column?: string
  message: string
}

export interface LineDraft {
  values: Record<string, unknown>
  nested?: { field: string; rows: Record<string, unknown>[] }
  stubs?: Record<string, { is_new: true; name: string }> // per-field create_stub sidecars
}

export interface ImportParseResult {
  values: Record<string, unknown>
  lines: LineDraft[]
  issues: ImportIssue[]
  m2m: Record<string, Array<string | number>>
}

// Dependency-injected so the pipeline is pure and unit-testable without a DB.
export type LookupFetcher = (req: {
  collection: string
  match_field: string
  values: string[] // batched, deduped, non-empty
  scope_filters: { field: string; op: 'eq' | 'neq'; value: unknown }[]
}) => Promise<Record<string, unknown>[]>

export type LookupStepConfig = Extract<ImportStep, { type: 'lookup' }>

type Stub = { is_new: true; name: string }

type RowEntry = { row: Record<string, unknown>; rowNumber: number }

interface StepFoldResult {
  value: unknown
  stub?: Stub
}

type LookupResolver = (candidate: unknown, step: ImportStep) => StepFoldResult

function substituteTemplate(
  template: string,
  row: Record<string, unknown>,
  resolvedCtx: Record<string, unknown>,
  issues: ImportIssue[],
  ruleId: string,
  rowNumber: number | undefined,
  lineCtx?: Record<string, unknown>
): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (_match, rawKey: string) => {
    const key = rawKey.trim()
    if (key.startsWith('$resolved.')) {
      const field = key.slice('$resolved.'.length)
      if (Object.hasOwn(resolvedCtx, field)) {
        return resolvedCtx[field] == null ? '' : String(resolvedCtx[field])
      }
    } else if (key.startsWith('$line.')) {
      const field = key.slice('$line.'.length)
      if (lineCtx && Object.hasOwn(lineCtx, field)) {
        return lineCtx[field] == null ? '' : String(lineCtx[field])
      }
    } else if (Object.hasOwn(row, key)) {
      return row[key] == null ? '' : String(row[key])
    }
    const issue: ImportIssue = {
      severity: 'warn',
      rule: ruleId,
      message: `Missing reference "${key}"`
    }
    if (rowNumber != null) issue.row = rowNumber
    issues.push(issue)
    return ''
  })
}

/** A scope-filter value is row-scoped when it references anything that varies per
 *  row — `{{$line.*}}` (earlier line-rule results) or raw sheet columns. Purely
 *  static values and `{{$resolved.*}}` header refs can be applied in SQL; row-scoped
 *  ones must be applied in memory after the batched fetch. */
function isRowScopedFilterValue(template: string): boolean {
  const refs = template.match(/\{\{([^}]+)\}\}/g)
  if (!refs) return false
  return refs.some((r) => !r.slice(2, -2).trim().startsWith('$resolved.'))
}

// Sequential fold over a rule's steps. Lookup steps do not perform I/O here — they
// consult a pre-resolved (candidate -> matched record) map via `resolver`, since real
// lookups are collected and batched across rows before this runs (see resolveRuleLookup).
function foldStepsSync(
  initial: unknown,
  steps: ImportStep[],
  row: Record<string, unknown>,
  resolvedCtx: Record<string, unknown>,
  issues: ImportIssue[],
  ruleId: string,
  rowNumber: number | undefined,
  resolver?: LookupResolver,
  lineCtx?: Record<string, unknown>
): StepFoldResult {
  let value = initial
  let stub: Stub | undefined
  for (const step of steps) {
    switch (step.type) {
      case 'trim':
        if (typeof value === 'string') value = value.trim()
        break
      case 'remap': {
        const key = value == null ? '' : String(value)
        if (Object.hasOwn(step.map, key)) {
          value = step.map[key]
        } else if (!step.passthrough) {
          value = undefined
        }
        break
      }
      case 'expression':
        value = substituteTemplate(
          step.template,
          row,
          resolvedCtx,
          issues,
          ruleId,
          rowNumber,
          lineCtx
        )
        break
      case 'const':
        value = step.value
        break
      case 'wrap_richtext':
        if (value !== null && value !== undefined && value !== '') {
          value = {
            time: 0,
            blocks: [{ type: 'paragraph', data: { text: String(value) } }],
            version: '2.22.2'
          }
        }
        break
      case 'lookup':
        if (resolver) {
          const result = resolver(value, step)
          value = result.value
          if (result.stub) stub = result.stub
        }
        break
    }
  }
  return { value, stub }
}

function findLookupStep(steps: ImportStep[]): LookupStepConfig | null {
  return steps.find((s): s is LookupStepConfig => s.type === 'lookup') ?? null
}

/** Picks the row's record from a candidate's matches, applying row-scoped scope
 *  filters in memory (they couldn't ride the batched SQL — their values differ per
 *  row). First surviving record wins, mirroring SQL-side filter semantics. */
function selectMatch(
  records: Record<string, unknown>[],
  rowScoped: LookupStepConfig['scope_filters'],
  row: Record<string, unknown>,
  resolvedCtx: Record<string, unknown>,
  lineCtx: Record<string, unknown> | undefined,
  issues: ImportIssue[],
  ruleId: string,
  rowNumber: number | undefined
): Record<string, unknown> | undefined {
  if (rowScoped.length === 0) return records[0]
  return records.find((rec) =>
    rowScoped.every((f) => {
      const want = substituteTemplate(f.value, row, resolvedCtx, issues, ruleId, rowNumber, lineCtx)
      const have = rec[f.field] == null ? '' : String(rec[f.field])
      return f.op === 'neq' ? have !== want : have === want
    })
  )
}

function resolveLookupOutcome(
  step: LookupStepConfig,
  candidate: unknown,
  matchMap: Map<string, Record<string, unknown>[]>,
  rowScoped: LookupStepConfig['scope_filters'],
  row: Record<string, unknown>,
  lineCtx: Record<string, unknown> | undefined,
  resolvedCtx: Record<string, unknown>,
  issues: ImportIssue[],
  ruleId: string,
  column: string | undefined,
  rowNumber: number | undefined
): StepFoldResult {
  const key = candidate == null ? '' : String(candidate).trim().toLowerCase()
  // Empty cells are not lookup misses — resolve to blank silently instead of warning.
  if (key === '') return { value: undefined }
  const record = selectMatch(
    matchMap.get(key) ?? [],
    rowScoped,
    row,
    resolvedCtx,
    lineCtx,
    issues,
    ruleId,
    rowNumber
  )
  if (record) {
    if (step.take === 'record') return { value: record }
    if (step.take === 'field') {
      const fieldName = step.take_field as string
      if (!(fieldName in record)) {
        const missingIssue: ImportIssue = {
          severity: 'warn',
          rule: ruleId,
          column,
          message: `take_field "${fieldName}" not present on matched ${step.collection} record`
        }
        if (rowNumber != null) missingIssue.row = rowNumber
        issues.push(missingIssue)
        return { value: undefined }
      }
      return { value: record[fieldName] }
    }
    return { value: record.id }
  }
  const name = candidate == null ? '' : String(candidate)
  const issue: ImportIssue = {
    severity: step.on_miss === 'error' ? 'error' : 'warn',
    rule: ruleId,
    column,
    message:
      step.on_miss === 'create_stub'
        ? `No match for "${name}" — flagged as new`
        : step.on_miss === 'create'
          ? `No match for "${name}" — will be created on direct import`
          : `No match for "${name}" in ${step.collection}`
  }
  if (rowNumber != null) issue.row = rowNumber
  issues.push(issue)
  if (step.on_miss === 'create_stub' || step.on_miss === 'create') {
    return { value: undefined, stub: { is_new: true, name } }
  }
  return { value: undefined }
}

function runRuleForRow(
  rule: ImportHeaderRule,
  row: Record<string, unknown>,
  resolvedCtx: Record<string, unknown>,
  batch: RuleLookupBatch | null,
  lookupStep: LookupStepConfig | null,
  issues: ImportIssue[],
  ruleId: string,
  rowNumber: number | undefined,
  lineCtx?: Record<string, unknown>
): StepFoldResult {
  const initial = rule.source != null ? row[rule.source] : undefined
  const resolver: LookupResolver | undefined =
    lookupStep && batch
      ? (candidate, step) =>
          step === lookupStep
            ? resolveLookupOutcome(
                lookupStep,
                candidate,
                batch.matchMap,
                batch.rowScoped,
                row,
                lineCtx,
                resolvedCtx,
                issues,
                ruleId,
                rule.source ?? undefined,
                rowNumber
              )
            : { value: candidate }
      : undefined
  return foldStepsSync(
    initial,
    rule.steps,
    row,
    resolvedCtx,
    issues,
    ruleId,
    rowNumber,
    resolver,
    lineCtx
  )
}

interface RuleLookupBatch {
  matchMap: Map<string, Record<string, unknown>[]>
  /** Scope filters whose values vary per row — applied in memory by selectMatch. */
  rowScoped: LookupStepConfig['scope_filters']
}

// Collects every row's candidate value for a rule's lookup step (running only the
// steps BEFORE it, which by construction never contain another lookup), dedupes, and
// resolves them with exactly one lookup() call. Static scope filters ride the SQL;
// row-scoped ones (referencing `$line.*` or sheet columns) are returned for per-row
// in-memory selection so the one-query-per-rule batching is preserved.
async function resolveRuleLookup(
  rule: ImportHeaderRule,
  lookupStep: LookupStepConfig,
  rowsForBatch: { row: Record<string, unknown>; rowNumber?: number }[],
  resolvedCtx: Record<string, unknown>,
  lookup: LookupFetcher,
  lineCtxFor?: (rowNumber: number | undefined) => Record<string, unknown> | undefined
): Promise<RuleLookupBatch> {
  const idx = rule.steps.indexOf(lookupStep)
  const preSteps = rule.steps.slice(0, idx)
  const scratchIssues: ImportIssue[] = []
  const candidates = new Set<string>()
  for (const { row, rowNumber } of rowsForBatch) {
    const initial = rule.source != null ? row[rule.source] : undefined
    const { value } = foldStepsSync(
      initial,
      preSteps,
      row,
      resolvedCtx,
      scratchIssues,
      '',
      undefined,
      undefined,
      lineCtxFor?.(rowNumber)
    )
    if (value != null) {
      const s = String(value).trim()
      if (s !== '') candidates.add(s)
    }
  }
  const staticFilters: { field: string; op: 'eq' | 'neq'; value: string }[] = []
  const rowScoped: LookupStepConfig['scope_filters'] = []
  for (const f of lookupStep.scope_filters) {
    if (lineCtxFor && isRowScopedFilterValue(f.value)) {
      rowScoped.push(f)
    } else {
      staticFilters.push({
        field: f.field,
        op: f.op,
        value: substituteTemplate(f.value, {}, resolvedCtx, scratchIssues, '', undefined)
      })
    }
  }
  const values = Array.from(candidates)
  const records = values.length
    ? await lookup({
        collection: lookupStep.collection,
        match_field: lookupStep.match_field,
        values,
        scope_filters: staticFilters
      })
    : []
  const matchMap = new Map<string, Record<string, unknown>[]>()
  for (const rec of records) {
    const key = rec[lookupStep.match_field]
    if (key == null) continue
    const k = String(key).trim().toLowerCase()
    if (k === '') continue
    const bucket = matchMap.get(k)
    if (bucket) bucket.push(rec)
    else matchMap.set(k, [rec])
  }
  return { matchMap, rowScoped }
}

async function runHeaderPhase(
  headerMap: ImportHeaderRule[],
  headerRow: Record<string, unknown>,
  issues: ImportIssue[],
  lookup: LookupFetcher,
  m2mFields: Set<string> | undefined
): Promise<{
  values: Record<string, unknown>
  resolved: Record<string, unknown>
  m2m: Record<string, Array<string | number>>
}> {
  const values: Record<string, unknown> = {}
  const resolved: Record<string, unknown> = {}
  const m2m: Record<string, Array<string | number>> = {}
  for (const rule of headerMap) {
    const lookupStep = findLookupStep(rule.steps)
    let batch: RuleLookupBatch | null = null
    if (lookupStep) {
      batch = await resolveRuleLookup(rule, lookupStep, [{ row: headerRow }], resolved, lookup)
    }
    const ruleId = `header:${rule.target}`
    const { value } = runRuleForRow(
      rule,
      headerRow,
      resolved,
      batch,
      lookupStep,
      issues,
      ruleId,
      undefined
    )
    resolved[rule.target] = value
    if (m2mFields?.has(rule.target)) {
      // Only scalar lookup results are linkable M2M ids — a lookup that resolved to a
      // whole record (take 'record'/'field' yielding an object), an array, or null/
      // undefined can't become a junction row, so the key is omitted from m2m entirely.
      if (typeof value === 'string' || typeof value === 'number') m2m[rule.target] = [value]
    } else {
      values[rule.target] = value
    }
  }
  return { values, resolved, m2m }
}

// Shared by the line phase (columns against every filtered row) and disperse
// (member_columns against each group's representative row). One lookup() call per
// column rule that has a lookup step, batched across all rows passed in. Columns
// run in ARRAY ORDER: each rule's per-row result lands in that row's `$line.*`
// context, so later rules can chain off earlier ones (expressions AND row-scoped
// scope filters) — e.g. resolving `category` from already-resolved core_category +
// category_type ids.
async function runColumnsBatched(
  columns: ImportHeaderRule[],
  rowsWithIndex: RowEntry[],
  resolvedCtx: Record<string, unknown>,
  lookup: LookupFetcher,
  issues: ImportIssue[],
  ruleIdFor: (rowNumber: number, target: string) => string
): Promise<{ rowNumber: number; values: Record<string, unknown>; stubs: Record<string, Stub> }[]> {
  const lineCtxByRow = new Map<number, Record<string, unknown>>()
  const stubsByRow = new Map<number, Record<string, Stub>>()
  for (const { rowNumber } of rowsWithIndex) {
    lineCtxByRow.set(rowNumber, {})
    stubsByRow.set(rowNumber, {})
  }
  const lineCtxFor = (rowNumber: number | undefined) =>
    rowNumber == null ? undefined : lineCtxByRow.get(rowNumber)

  for (const col of columns) {
    const lookupStep = findLookupStep(col.steps)
    const batch = lookupStep
      ? await resolveRuleLookup(col, lookupStep, rowsWithIndex, resolvedCtx, lookup, lineCtxFor)
      : null

    for (const { row, rowNumber } of rowsWithIndex) {
      const ruleId = ruleIdFor(rowNumber, col.target)
      const lineCtx = lineCtxByRow.get(rowNumber)
      const { value, stub } = runRuleForRow(
        col,
        row,
        resolvedCtx,
        batch,
        lookupStep,
        issues,
        ruleId,
        rowNumber,
        lineCtx
      )
      if (lineCtx) lineCtx[col.target] = value
      const stubs = stubsByRow.get(rowNumber)
      if (stub && stubs) stubs[col.target] = stub
    }
  }

  return rowsWithIndex.map(({ rowNumber }) => ({
    rowNumber,
    values: { ...(lineCtxByRow.get(rowNumber) ?? {}) },
    stubs: stubsByRow.get(rowNumber) ?? {}
  }))
}

function matchesRowFilter(
  row: Record<string, unknown>,
  filter: { column: string; op: 'nnull' | 'eq' | 'neq'; value?: string } | null
): boolean {
  if (!filter) return true
  const value = row[filter.column]
  if (filter.op === 'nnull') return value !== null && value !== undefined && value !== ''
  const compare = value == null ? '' : String(value)
  if (filter.op === 'eq') return compare === (filter.value ?? '')
  return compare !== (filter.value ?? '')
}

function filterRows(
  rows: Record<string, unknown>[],
  filter: { column: string; op: 'nnull' | 'eq' | 'neq'; value?: string } | null
): RowEntry[] {
  const withIndex = rows.map((row, i) => ({ row, rowNumber: i + 1 }))
  return withIndex.filter(({ row }) => matchesRowFilter(row, filter))
}

function splitEven(total: number, count: number): string[] {
  if (count <= 0) return []
  const per = Math.floor((total / count) * 100) / 100
  const amounts: string[] = []
  for (let i = 0; i < count - 1; i++) amounts.push(per.toFixed(2))
  amounts.push((total - per * (count - 1)).toFixed(2))
  return amounts
}

async function processDisperse(
  disperse: ImportDisperseConfig,
  filteredRows: RowEntry[],
  resolvedCtx: Record<string, unknown>,
  lookup: LookupFetcher,
  issues: ImportIssue[],
  lineDraftByRowNumber: Map<number, LineDraft>
): Promise<void> {
  const triggerEntries = filteredRows.filter(({ row }) => {
    const v = row[disperse.map_key_column]
    return v !== null && v !== undefined && String(v).trim() !== ''
  })
  if (triggerEntries.length === 0) return

  const candidateValues = Array.from(
    new Set(triggerEntries.map(({ row }) => String(row[disperse.map_key_column]).trim()))
  )
  const mapRecords = await lookup({
    collection: disperse.map_collection,
    match_field: disperse.map_key_field,
    values: candidateValues,
    scope_filters: []
  })
  const mapMatchMap = new Map<string, Record<string, unknown>>()
  for (const rec of mapRecords) {
    const key = rec[disperse.map_key_field]
    if (key == null) continue
    const k = String(key).trim().toLowerCase()
    if (k !== '') mapMatchMap.set(k, rec)
  }

  for (const { row: triggerRow, rowNumber } of triggerEntries) {
    const candidate = String(triggerRow[disperse.map_key_column]).trim()
    const mapRecord = mapMatchMap.get(candidate.toLowerCase())
    // Not being in the dispersal map is the normal case — the row stays a plain line.
    if (!mapRecord) continue

    const isAll = disperse.map_all_field ? Boolean(mapRecord[disperse.map_all_field]) : false
    const rawValuesPath = mapRecord[disperse.map_values_path]
    const allowedValues = new Set(
      Array.isArray(rawValuesPath) ? rawValuesPath.map((v) => String(v).trim().toLowerCase()) : []
    )

    const memberEntries = filteredRows.filter(({ row: candRow, rowNumber: candRowNumber }) => {
      if (candRowNumber === rowNumber) return false
      if (isAll) {
        const isMapKeyed =
          candRow[disperse.map_key_column] != null &&
          String(candRow[disperse.map_key_column]).trim() !== ''
        const hasGroup =
          candRow[disperse.group_by_column] != null &&
          String(candRow[disperse.group_by_column]).trim() !== ''
        return !isMapKeyed && hasGroup
      }
      const matchVal = candRow[disperse.member_match_column]
      if (matchVal == null) return false
      return allowedValues.has(String(matchVal).trim().toLowerCase())
    })
    if (memberEntries.length === 0) continue

    const groups: { key: string; rows: RowEntry[] }[] = []
    const groupIndex = new Map<string, number>()
    for (const entry of memberEntries) {
      const key = String(entry.row[disperse.group_by_column] ?? '')
      let idx = groupIndex.get(key)
      if (idx == null) {
        idx = groups.length
        groupIndex.set(key, idx)
        groups.push({ key, rows: [] })
      }
      groups[idx].rows.push(entry)
    }

    const total = Number(triggerRow[disperse.amount_column]) || 0
    const splitAmounts = splitEven(total, groups.length)
    const representativeRows = groups.map((g) => g.rows[0])
    const memberResults = await runColumnsBatched(
      disperse.member_columns,
      representativeRows,
      resolvedCtx,
      lookup,
      issues,
      (_rowNumber, target) => `disperse:${target}`
    )

    // Nested member stubs are NOT written into the stored row — create_stub misses
    // already surface as warn issues (resolveLookupOutcome); persisting a `stubs` key
    // here would leak pipeline metadata into the business JSON on save.
    const nestedRows = groups.map((_g, i) => ({
      ...memberResults[i].values,
      allocated_amount: splitAmounts[i]
    }))

    const draft = lineDraftByRowNumber.get(rowNumber)
    if (draft) draft.nested = { field: disperse.nested_target, rows: nestedRows }
  }
}

// Per-line nested rows: a second, simpler member-per-line channel alongside disperse
// (one-to-many split from a trigger row). Runs AFTER disperse — any line whose draft
// already carries `.nested` (from disperse) is left alone, disperse wins.
async function processPerLineNested(
  nested: ImportNestedConfig,
  filteredRows: RowEntry[],
  resolvedCtx: Record<string, unknown>,
  lookup: LookupFetcher,
  issues: ImportIssue[],
  lineDraftByRowNumber: Map<number, LineDraft>
): Promise<void> {
  const gatedEntries = filteredRows.filter(({ row, rowNumber }) => {
    const draft = lineDraftByRowNumber.get(rowNumber)
    if (draft?.nested) return false
    return matchesRowFilter(row, nested.when)
  })
  if (gatedEntries.length === 0) return

  const memberResults = await runColumnsBatched(
    nested.columns,
    gatedEntries,
    resolvedCtx,
    lookup,
    issues,
    (rowNumber, target) => `line[${rowNumber}]:nested:${target}`
  )

  for (const result of memberResults) {
    const draft = lineDraftByRowNumber.get(result.rowNumber)
    if (!draft) continue
    // Member stubs are NOT written into the stored row — same rationale as disperse's
    // nestedRows above: create_stub misses already surface as warn issues.
    const member: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(result.values)) {
      if (value !== undefined) member[key] = value
    }
    if (Object.keys(member).length > 0) {
      draft.nested = { field: nested.target_field, rows: [member] }
    }
  }
}

/** Folds a lookup step's `create.defaults` rules into a create payload for a single
 *  miss. `row` is the miss's LINE VALUES (not the raw sheet row — the sheet is gone by
 *  execute time), and `resolvedCtx` is the header-resolved `$resolved.*` context.
 *  Defaults reaching for raw sheet columns must instead read a line-values key or use
 *  `{{$resolved.*}}`. By Task-1 config normalization, defaults never contain lookup
 *  steps, so no batching/resolver is needed. Keys whose rule resolves to undefined are
 *  omitted from the payload. */
export function resolveCreateDefaults(
  defaults: ImportHeaderRule[],
  row: Record<string, unknown>,
  resolvedCtx: Record<string, unknown>
): Record<string, unknown> {
  const payload: Record<string, unknown> = {}
  const scratchIssues: ImportIssue[] = []
  for (const rule of defaults) {
    const { value } = runRuleForRow(
      rule,
      row,
      resolvedCtx,
      null,
      null,
      scratchIssues,
      `create:${rule.target}`,
      undefined
    )
    if (value !== undefined) payload[rule.target] = value
  }
  return payload
}

export interface CreateMiss {
  step: LookupStepConfig & { create: ImportLookupCreate }
  name: string
  values: Record<string, unknown>
  apply: (id: unknown) => void
}

/** Walks submitted lines' `stubs` sidecars, matching each to the line_map column whose
 *  lookup step carries an `on_miss: 'create'` policy. Line columns only — v1.2 has no
 *  slot to apply a created id back into a header target or a nested member row (nested
 *  member stubs are never persisted; see processDisperse/processPerLineNested). */
export function collectCreateMisses(
  config: ImportTemplateConfig,
  lines: LineDraft[]
): CreateMiss[] {
  const misses: CreateMiss[] = []
  const columns = config.line_map?.columns ?? []
  const createStepByTarget = new Map<string, LookupStepConfig & { create: ImportLookupCreate }>()
  for (const col of columns) {
    const lookupStep = findLookupStep(col.steps)
    if (lookupStep?.on_miss === 'create' && lookupStep.create) {
      createStepByTarget.set(
        col.target,
        lookupStep as LookupStepConfig & { create: ImportLookupCreate }
      )
    }
  }
  if (createStepByTarget.size === 0) return misses
  for (const line of lines) {
    if (!line.stubs) continue
    for (const [target, stub] of Object.entries(line.stubs)) {
      const step = createStepByTarget.get(target)
      if (!step) continue
      misses.push({
        step,
        name: stub.name,
        values: line.values,
        apply: (id) => {
          line.values[target] = id
        }
      })
    }
  }
  return misses
}

export async function runImportPipeline(opts: {
  config: ImportTemplateConfig
  rows: Record<string, unknown>[]
  lookup: LookupFetcher
  applyLineFieldRules?: (draft: Record<string, unknown>) => Promise<void>
  m2mFields?: Set<string>
}): Promise<ImportParseResult> {
  const { config, rows, lookup, applyLineFieldRules, m2mFields } = opts
  const issues: ImportIssue[] = []
  const headerRow = rows[0] ?? {}

  for (const rule of config.header_map) {
    if (rule.source != null && !Object.hasOwn(headerRow, rule.source)) {
      issues.push({
        severity: 'warn',
        rule: `header:${rule.target}`,
        column: rule.source,
        message: `Column "${rule.source}" not found in sheet`
      })
    }
  }

  const { values, resolved, m2m } = await runHeaderPhase(
    config.header_map,
    headerRow,
    issues,
    lookup,
    m2mFields
  )

  const lines: LineDraft[] = []
  const lineDraftByRowNumber = new Map<number, LineDraft>()

  if (config.line_map) {
    const lm = config.line_map
    const filteredRows = filterRows(rows, lm.row_filter)

    for (const col of lm.columns) {
      if (col.source != null) {
        const source = col.source
        const missing = filteredRows.every(({ row }) => !Object.hasOwn(row, source))
        if (missing) {
          issues.push({
            severity: 'warn',
            rule: `line:${col.target}`,
            column: source,
            message: `Column "${source}" not found in sheet`
          })
        }
      }
    }

    const lineResults = await runColumnsBatched(
      lm.columns,
      filteredRows,
      resolved,
      lookup,
      issues,
      (rowNumber, target) => `line[${rowNumber}]:${target}`
    )

    for (const result of lineResults) {
      const draft: LineDraft = { values: result.values }
      if (lm.apply_field_rules && applyLineFieldRules) {
        await applyLineFieldRules(draft.values)
      }
      if (Object.keys(result.stubs).length > 0) draft.stubs = result.stubs
      lines.push(draft)
      lineDraftByRowNumber.set(result.rowNumber, draft)
    }

    if (lm.disperse) {
      await processDisperse(
        lm.disperse,
        filteredRows,
        resolved,
        lookup,
        issues,
        lineDraftByRowNumber
      )
    }

    if (lm.nested) {
      await processPerLineNested(
        lm.nested,
        filteredRows,
        resolved,
        lookup,
        issues,
        lineDraftByRowNumber
      )
    }
  }

  return { values, lines, issues, m2m }
}
