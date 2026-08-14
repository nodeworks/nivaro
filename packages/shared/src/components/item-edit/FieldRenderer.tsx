import { ExternalLink } from 'lucide-react'
import { useContext } from 'react'
import { fieldDrilldownConfig, RelationPathDataContext, useDrilldown , useParentDraft } from '../../context'
import { Badge } from '../ui/badge'
import { formatDisplayValue } from './GroupSection'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { SimpleSelect } from '../ui/SimpleSelect'
import { Switch } from '../ui/switch'
import { Textarea } from '../ui/textarea'
import { CatalogPickerField, type CatalogModeConfig } from './CatalogPickerField'
import { FilePickerField, FileM2MField } from './FilePickerField'
import { choiceLabel } from '../../lib/utils'
import { parseJson, toLocalDatetime } from './helpers'
import { InlineGridField } from './InlineGridField'
import { InlineTableField } from './InlineTableField'
import { M2MCombobox, M2MSingleSelectCombobox } from './M2MCombobox'
import { QuickCreateButton, type QuickCreateConfig } from './QuickCreateButton'
import { RelationCombobox } from './RelationCombobox'
import { RelationGroupedCombobox } from './RelationGroupedCombobox'
import { RichTextEditor } from './RichTextEditor'
import type { CMSField, CMSRelation } from './types'

function resolveTokenNode(
  node: unknown,
  draft: Record<string, unknown> | undefined,
  itemId: string
): { v: unknown; ok: boolean } {
  if (typeof node === 'string' && node.startsWith('$parent.')) {
    const key = node.slice('$parent.'.length)
    const val = key === 'id' ? (itemId && itemId !== 'new' ? itemId : undefined) : draft?.[key]
    return { v: val, ok: val !== undefined && val !== null && val !== '' }
  }
  if (Array.isArray(node)) {
    const out: unknown[] = []
    for (const item of node) {
      const r = resolveTokenNode(item, draft, itemId)
      if (!r.ok) return { v: out, ok: false }
      out.push(r.v)
    }
    return { v: out, ok: true }
  }
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      const r = resolveTokenNode(v, draft, itemId)
      if (!r.ok) return { v: out, ok: false }
      out[k] = r.v
    }
    return { v: out, ok: true }
  }
  return { v: node, ok: true }
}

export function resolveOptionFilterTokens(
  filter: Record<string, unknown> | undefined,
  draft: Record<string, unknown> | undefined,
  itemId: string
): Record<string, unknown> | undefined {
  if (!filter) return undefined
  // Top-level _and: prune entries whose tokens are unresolved
  if (Array.isArray(filter._and)) {
    const kept: unknown[] = []
    for (const entry of filter._and) {
      const r = resolveTokenNode(entry, draft, itemId)
      if (r.ok) kept.push(r.v)
    }
    return kept.length > 0 ? { _and: kept } : undefined
  }
  const r = resolveTokenNode(filter, draft, itemId)
  return r.ok ? (r.v as Record<string, unknown>) : undefined
}

export function FieldRenderer({
  field,
  value,
  onChange,
  relations,
  collection,
  itemId,
  cascadeFilter,
  requiredParentLabel,
  onCountChange,
  displayOnly,
  prefillParentId
}: {
  field: CMSField
  value: unknown
  onChange: (v: unknown) => void
  relations: CMSRelation[]
  collection: string
  itemId: string
  cascadeFilter?: Record<string, unknown>
  requiredParentLabel?: string | null
  onCountChange?: (count: number) => void
  displayOnly?: boolean
  prefillParentId?: string
}) {
  const drill = useDrilldown()
  const parentDraftForFilters = useParentDraft()
  const relationPathData = useContext(RelationPathDataContext)
  const iface = field.interface ?? ''
  const isRelIface =
    !iface ||
    iface.startsWith('relation-') ||
    iface === 'select-multiple-m2m' ||
    iface.endsWith('-m2o') ||
    iface.endsWith('-m2m')

  // M2O
  const m2oRel = isRelIface
    ? relations.find(
        (r) => r.many_collection === collection && r.many_field === field.field && !r.junction_field
      )
    : null
  if (m2oRel?.one_collection) {
    if (iface === 'file-image') {
      const fOpts = parseJson<{ allow_upload?: boolean; allow_pick?: boolean }>(field.options)
      return <FilePickerField value={value} onChange={onChange} disabled={field.readonly} allowUpload={fOpts?.allow_upload !== false} allowPick={fOpts?.allow_pick !== false} />
    }
    if (iface === 'relation-grouped') {
      const gOpts = parseJson<{ group_field?: string; option_field?: string }>(field.options)
      if (gOpts?.group_field && gOpts?.option_field) {
        return (
          <RelationGroupedCombobox
            collection={m2oRel.one_collection}
            value={value}
            onChange={onChange}
            groupField={gOpts.group_field}
            optionField={gOpts.option_field}
            disabled={field.readonly}
            placeholder={field.placeholder ?? undefined}
            extraFilter={cascadeFilter}
          />
        )
      }
    }
    const m2oDrillCfg = drill && value != null && value !== '' ? fieldDrilldownConfig(field) : null
    const m2oOpts = parseJson<{
      picker_facets?: Array<{ field: string; label?: string; sort?: string; filter?: Record<string, unknown> }>
      option_filter?: Record<string, unknown>
      option_sort?: string
      auto_select_single?: boolean
      quick_create?: QuickCreateConfig
    }>(field.options)
    // Per-field option filter (options.option_filter) merged with any active
    // cascade filter — curation of the picker's option set, not security.
    // String values may be '$parent.<field>' tokens resolved from the parent
    // record draft ('$parent.id' = the record id). A top-level _and entry whose
    // tokens are unresolved is PRUNED (EFP semantics: clauses apply only when
    // their driving value is set); any other unresolved shape drops the filter.
    const staticFilter = resolveOptionFilterTokens(
      m2oOpts?.option_filter && typeof m2oOpts.option_filter === 'object'
        ? m2oOpts.option_filter
        : undefined,
      parentDraftForFilters?.draft,
      itemId
    )
    const effectiveFilter = staticFilter
      ? cascadeFilter
        ? { _and: [staticFilter, cascadeFilter] }
        : staticFilter
      : cascadeFilter
    const combobox = (
      <RelationCombobox
        collection={m2oRel.one_collection}
        value={value}
        onChange={onChange}
        disabled={field.readonly}
        placeholder={field.placeholder ?? undefined}
        extraFilter={effectiveFilter}
        autoSelectSingle={m2oOpts?.auto_select_single === true}
        optionSort={
          typeof m2oOpts?.option_sort === 'string' && m2oOpts.option_sort
            ? m2oOpts.option_sort
            : undefined
        }
        requiredParent={requiredParentLabel ?? undefined}
        facets={
          Array.isArray(m2oOpts?.picker_facets)
            ? m2oOpts.picker_facets.map((f) => ({
                ...f,
                // Facet filters support the same '$parent.<field>' tokens (and
                // _and clause pruning) as option_filter, resolved from the same
                // parent draft — keeps facet option lists in sync with the main
                // option query's eligibility clauses.
                filter:
                  f.filter && typeof f.filter === 'object'
                    ? resolveOptionFilterTokens(f.filter, parentDraftForFilters?.draft, itemId)
                    : undefined
              }))
            : undefined
        }
      />
    )
    const quickCreate =
      m2oOpts?.quick_create && Array.isArray(m2oOpts.quick_create.fields) && !field.readonly
        ? m2oOpts.quick_create
        : null
    if (!m2oDrillCfg && !quickCreate) return combobox
    return (
      <div className='flex items-center gap-1.5'>
        <div className='min-w-0 flex-1'>{combobox}</div>
        {quickCreate && (
          <QuickCreateButton
            targetCollection={m2oRel.one_collection}
            config={quickCreate}
            onCreated={(id) => onChange(id)}
          />
        )}
        {m2oDrillCfg && (
          <button
            type='button'
            title='Open detail panel'
            onClick={() =>
              drill?.open({
                collection: m2oRel.one_collection as string,
                itemId: String(value),
                layoutId: m2oDrillCfg.layout_id,
                width: m2oDrillCfg.width
              })
            }
            className='shrink-0 rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-[#00ceff] dark:hover:bg-slate-800'
          >
            <ExternalLink className='h-3.5 w-3.5' />
          </button>
        )}
      </div>
    )
  }

  // M2M
  const m2mRel =
    isRelIface && !m2oRel
      ? (() => {
          const r = relations.find(
            (rel) =>
              rel.one_collection === collection &&
              (rel.one_field === field.field ||
                (rel.junction_field != null && rel.many_collection === field.field))
          )
          if (!r) return null
          if (r.junction_field) return r
          const companion = relations.find(
            (c) => c.many_collection === r.many_collection && c.id !== r.id
          )
          return companion ? { ...r, junction_field: companion.many_field } : null
        })()
      : null
  if (m2mRel) {
    if (iface === 'files-m2m') {
      const fOpts = parseJson<{ allow_upload?: boolean; allow_pick?: boolean; pending_save?: boolean }>(field.options)
      return <FileM2MField relation={m2mRel} parentId={itemId} allRelations={relations} disabled={field.readonly} allowUpload={fOpts?.allow_upload !== false} allowPick={fOpts?.allow_pick !== false} pendingSave={fOpts?.pending_save === true} />
    }
    const fieldOpts = parseJson<{ max_values?: number; option_sort?: string }>(field.options)
    const m2mOptionSort =
      typeof fieldOpts?.option_sort === 'string' && fieldOpts.option_sort
        ? fieldOpts.option_sort
        : undefined
    if (fieldOpts?.max_values === 1) {
      return (
        <M2MSingleSelectCombobox
          relation={m2mRel}
          parentId={itemId}
          allRelations={relations}
          extraFilter={cascadeFilter}
          optionSort={m2mOptionSort}
          requiredParent={requiredParentLabel ?? undefined}
          onCountChange={onCountChange}
          readOnly={displayOnly}
        />
      )
    }
    return (
      <M2MCombobox
        relation={m2mRel}
        parentId={itemId}
        allRelations={relations}
        extraFilter={cascadeFilter}
        optionSort={m2mOptionSort}
        requiredParent={requiredParentLabel ?? undefined}
        onCountChange={onCountChange}
      drilldown={fieldDrilldownConfig(field)} />
    )
  }

  // Read-only display — formatDisplayValue applies the field's display settings
  // (options.format currency/decimal/int, choice labels, datetime locale) so a
  // read-only field renders exactly like its formatted editable counterpart.
  // Inline tables are exempt: they render the full table in read-only mode
  // (same display, no edit affordances) further down.
  if (field.readonly && iface !== 'inline-table') {
    // Relation-path fields configured for drill-down render as a link to the
    // final entity's detail sheet (host app provides the DrilldownContext).
    if (iface === 'relation-path' && value != null && value !== '' && drill) {
      const cfg = fieldDrilldownConfig(field)
      const meta = relationPathData?.[field.field]
      if (cfg && meta?.target_collection && meta.ids.length > 0) {
        return (
          <div className='min-h-[36px] flex items-center'>
            <button
              type='button'
              onClick={() =>
                drill.open({
                  collection: meta.target_collection as string,
                  itemId: meta.ids[0],
                  layoutId: cfg.layout_id,
                  width: cfg.width,
                  title: String(value)
                })
              }
              className='text-left text-sm text-slate-700 underline decoration-slate-300 decoration-dotted underline-offset-2 hover:text-[#172940] hover:decoration-[#00ceff] dark:text-slate-200 dark:hover:text-[#00ceff]'
            >
              {formatDisplayValue(value, field)}
            </button>
          </div>
        )
      }
    }
    // A derived total that is moving under the reader's edits — an addendum's
    // proposed lines, say — has to show BOTH figures. The new number alone
    // silently replaces the one they are amending, and the difference is the
    // whole point of the amendment.
    const liveDelta = (field.options as { __live_delta?: { original: unknown; live: number } } | null)
      ?.__live_delta
    if (liveDelta && Number.isFinite(Number(liveDelta.live))) {
      const originalNum = Number(liveDelta.original)
      const rawDiff = Number(liveDelta.live) - (Number.isFinite(originalNum) ? originalNum : 0)
      // Round to cents: float sums drift, and a "+$0.00" chip is noise.
      const diff = Math.round(rawDiff * 100) / 100
      return (
        <div className='flex min-h-[36px] flex-wrap items-center gap-x-2 gap-y-0.5'>
          <span className='text-sm text-slate-400 line-through tabular-nums'>
            {formatDisplayValue(liveDelta.original, field)}
          </span>
          <span className='text-slate-300' aria-hidden>
            →
          </span>
          <span className='text-sm font-medium tabular-nums'>
            {formatDisplayValue(liveDelta.live, field)}
          </span>
          {diff !== 0 && (
            <span
              className={`rounded px-1.5 py-px text-[11px] font-medium tabular-nums ${
                diff > 0
                  ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400'
                  : 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-400'
              }`}
            >
              {diff > 0 ? '+' : '−'}
              {formatDisplayValue(Math.abs(diff), field)}
            </span>
          )}
        </div>
      )
    }
    const display =
      value === null || value === undefined ? (
        <span className='text-muted-foreground italic text-sm'>—</span>
      ) : typeof value === 'boolean' ? (
        <Badge variant={value ? 'default' : 'secondary'}>{value ? 'Yes' : 'No'}</Badge>
      ) : (
        <span className='text-sm tabular-nums'>{formatDisplayValue(value, field)}</span>
      )
    return <div className='min-h-[36px] flex items-center'>{display}</div>
  }

  const strVal = value === null || value === undefined ? '' : String(value)

  if (field.type === 'boolean') {
    return (
      <div className='flex items-center gap-2'>
        <Switch checked={Boolean(value)} onCheckedChange={onChange} />
        <Label className='font-normal text-sm'>{value ? 'Yes' : 'No'}</Label>
      </div>
    )
  }

  if (field.type === 'datetime' || iface === 'datetime') {
    // A datetime column may be configured date-only (options.date_mode:
    // 'date') — delivery dates etc. carry no meaningful time. Stored as the
    // bare yyyy-mm-dd (local midnight server-side, no tz shifting).
    const dtOpts = parseJson<{ date_mode?: string }>(field.options)
    if (dtOpts?.date_mode === 'date') {
      return (
        <Input
          type='date'
          value={strVal.slice(0, 10)}
          onChange={(e) => onChange(e.target.value || null)}
          placeholder={field.placeholder ?? undefined}
        />
      )
    }
    return (
      <Input
        type='datetime-local'
        value={toLocalDatetime(value)}
        onChange={(e) => onChange(e.target.value ? new Date(e.target.value).toISOString() : null)}
        placeholder={field.placeholder ?? undefined}
      />
    )
  }

  if (field.type === 'date' || iface === 'date') {
    return (
      <Input
        type='date'
        value={strVal.slice(0, 10)}
        onChange={(e) => onChange(e.target.value || null)}
        placeholder={field.placeholder ?? undefined}
      />
    )
  }

  const isNumeric = ['integer', 'bigInteger', 'float', 'decimal', 'numeric', 'int', 'bigint', 'smallint', 'tinyint', 'real', 'money', 'smallmoney', 'double', 'number'].includes(field.type)
  if (isNumeric) {
    const isInt = ['integer', 'bigInteger', 'int', 'bigint', 'smallint', 'tinyint'].includes(field.type)
    return (
      <Input
        type='number'
        step={isInt ? '1' : 'any'}
        value={strVal}
        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
        placeholder={field.placeholder ?? undefined}
      />
    )
  }

  if (field.type === 'json' || iface === 'code') {
    return (
      <Textarea
        className='font-mono text-xs'
        rows={4}
        value={typeof value === 'object' ? JSON.stringify(value, null, 2) : strVal}
        onChange={(e) => {
          try {
            onChange(JSON.parse(e.target.value))
          } catch {
            onChange(e.target.value)
          }
        }}
        placeholder={field.placeholder ?? undefined}
      />
    )
  }

  if (iface === 'textarea') {
    return (
      <Textarea
        rows={4}
        value={strVal}
        onChange={(e) => onChange(e.target.value)}
        placeholder={field.placeholder ?? undefined}
      />
    )
  }

  if (iface === 'wysiwyg' || iface === 'markdown') {
    return (
      <Textarea
        rows={6}
        value={strVal}
        onChange={(e) => onChange(e.target.value)}
        placeholder={field.placeholder ?? undefined}
        className='font-mono text-sm'
      />
    )
  }

  if (
    iface === 'input-rich-text-html' ||
    iface === 'rich_text' ||
    field.type === 'rich_text' ||
    iface === 'extension-editorjs'
  ) {
    return (
      <RichTextEditor
        value={strVal}
        onChange={onChange}
        placeholder={field.placeholder ?? undefined}
        disabled={field.readonly}
      />
    )
  }

  if (iface === 'inline-grid' || iface === 'relation-list' || iface === 'list-o2m') {
    const o2mRel = relations.find(
      (r) =>
        r.one_collection === collection &&
        !r.junction_field &&
        (r.one_field === field.field || r.many_collection === field.field)
    )
    if (o2mRel) {
      const o2mCol = o2mRel.many_collection ?? null
      const o2mManyField = o2mRel.many_field ?? null
      if (o2mCol && o2mManyField && itemId) {
        const opts = typeof field.options === 'string'
          ? (() => { try { return JSON.parse(field.options) } catch { return {} } })()
          : (field.options ?? {})
        const layoutSlug = (opts.layout_slug as string | null) ?? null
        return (
          <InlineGridField relatedCollection={o2mCol} manyField={o2mManyField} parentId={itemId} layoutSlug={layoutSlug} parentFieldKey={field.field} />
        )
      }
      return (
        <p className='text-[12px] text-slate-400 py-1'>
          Inline grid editing not available in embedded form
        </p>
      )
    }
  }

  if (iface === 'inline-table') {
    const o2mRel = relations.find(
      (r) =>
        r.one_collection === collection &&
        !r.junction_field &&
        (r.one_field === field.field || r.many_collection === field.field)
    )
    if (o2mRel) {
      const o2mCol = o2mRel.many_collection ?? null
      const o2mManyField = o2mRel.many_field ?? null
      if (o2mCol && o2mManyField && itemId) {
        const opts = typeof field.options === 'string'
          ? (() => { try { return JSON.parse(field.options) } catch { return {} } })()
          : (field.options ?? {})
        const layoutId = (opts.layout_id as number | null) ?? null
        const showRowRevisions = !!opts.show_row_revisions
        const allowRevisionRestore = opts.allow_revision_restore !== false
        const saveMode = (opts.save_mode as 'immediate' | 'pending') ?? 'immediate'
        const showLineNumbers = !!(opts.show_line_numbers)
        const enableReorder = opts.enable_reorder !== false
        const parentCascades = Array.isArray(opts.parent_cascades)
          ? (opts.parent_cascades as Array<{ parent_field: string; child_field: string }>)
          : undefined
        const rowRules = Array.isArray(opts.row_rules) ? opts.row_rules : undefined
        const columnPresets = Array.isArray(opts.column_presets) ? opts.column_presets : undefined
        const defaultPreset =
          typeof opts.default_preset === 'string' && opts.default_preset
            ? opts.default_preset
            : undefined
        const drawerRelations = Array.isArray(opts.drawer_relations)
          ? opts.drawer_relations
          : undefined
        const parentContextFields = Array.isArray(opts.parent_context_fields) ? opts.parent_context_fields as string[] : undefined
        const uniqueBy = Array.isArray(opts.unique_by) ? opts.unique_by as string[] : undefined
        const sortField = typeof opts.sort_field === 'string' && opts.sort_field ? opts.sort_field : undefined
        const sortDir = opts.sort_dir === 'desc' ? 'desc' as const : 'asc' as const
        const sectionGroupBy =
          typeof opts.section_group_by === 'string' && opts.section_group_by.includes('.')
            ? opts.section_group_by
            : undefined
        const rowFilter =
          opts.row_filter && typeof opts.row_filter === 'object'
            ? (opts.row_filter as Record<string, unknown>)
            : undefined
        const allocateDrawer =
          opts.allocate_drawer && typeof opts.allocate_drawer === 'object'
            ? (opts.allocate_drawer as import('./InlineTableField').AllocateDrawerConfig)
            : undefined
        const autoAllocate =
          opts.auto_allocate && typeof opts.auto_allocate === 'object'
            ? (opts.auto_allocate as import('./InlineTableField').AutoAllocateConfig)
            : undefined
        const rowBulkActions = Array.isArray(opts.row_bulk_actions)
          ? (opts.row_bulk_actions as import('./InlineTableField').RowBulkActionConfig[])
          : undefined
        const uploadTemplate =
          typeof opts.upload_template === 'string' && opts.upload_template
            ? opts.upload_template
            : undefined
        const rowDefaults =
          opts.row_defaults && typeof opts.row_defaults === 'object'
            ? (opts.row_defaults as Record<string, unknown>)
            : undefined
        const submissionErrors =
          opts.submission_errors === true
            ? {}
            : opts.submission_errors && typeof opts.submission_errors === 'object'
              ? (opts.submission_errors as { line_field?: string })
              : undefined
        const catalogMode = opts.catalog_mode as CatalogModeConfig | undefined
        if (catalogMode?.item_field && catalogMode?.section_by) {
          return (
            <CatalogPickerField
              relatedCollection={o2mCol}
              manyField={o2mManyField}
              parentId={itemId}
              parentCollection={collection}
              config={catalogMode}
              readOnly={field.readonly}
            />
          )
        }
        return (
          <InlineTableField relatedCollection={o2mCol} manyField={o2mManyField} parentId={itemId} parentCollection={collection} layoutId={layoutId} showRowRevisions={showRowRevisions} allowRevisionRestore={allowRevisionRestore} saveMode={saveMode} showLineNumbers={showLineNumbers} enableReorder={enableReorder} parentCascades={parentCascades} rowRules={rowRules} columnPresets={columnPresets} defaultPreset={defaultPreset} drawerRelations={drawerRelations} parentContextFields={parentContextFields} uniqueBy={uniqueBy} sortField={sortField} sortDir={sortDir} sectionGroupBy={sectionGroupBy} rowFilter={rowFilter} rowDefaults={rowDefaults} allocateDrawer={allocateDrawer} autoAllocate={autoAllocate} rowBulkActions={rowBulkActions} uploadTemplate={uploadTemplate} submissionErrors={submissionErrors} prefillParentId={prefillParentId} parentFieldKey={field.field} readOnly={field.readonly} />
        )
      }
    }
    return (
      <p className='text-[12px] text-slate-400 py-1'>
        Inline table editing not available in embedded form
      </p>
    )
  }

  // Select / dropdown
  if (iface === 'select-dropdown' || iface === 'radio-buttons') {
    const opts = (() => {
      const parsed = parseJson<{ choices?: Array<{ text: string; value: string }> }>(field.options)
      return parsed?.choices ?? []
    })()
    if (opts.length > 0) {
      return (
        <SimpleSelect
          value={strVal}
          onChange={(v) => onChange(v || null)}
          options={[
            { value: '', label: '— Select —' },
            ...opts.map((o) => ({ value: o.value, label: choiceLabel(o.text) }))
          ]}
          ariaLabel={field.label ?? field.field}
          className='h-9 rounded-md text-sm'
        />
      )
    }
  }

  return (
    <Input
      value={strVal}
      onChange={(e) => onChange(e.target.value || null)}
      placeholder={field.placeholder ?? undefined}
    />
  )
}
