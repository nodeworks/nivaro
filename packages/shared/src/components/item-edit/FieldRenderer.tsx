import { ExternalLink } from 'lucide-react'
import { useContext } from 'react'
import { fieldDrilldownConfig, RelationPathDataContext, useDrilldown } from '../../context'
import { Badge } from '../ui/badge'
import { formatDisplayValue } from './GroupSection'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Switch } from '../ui/switch'
import { Textarea } from '../ui/textarea'
import { FilePickerField, FileM2MField } from './FilePickerField'
import { parseJson, toLocalDatetime } from './helpers'
import { InlineGridField } from './InlineGridField'
import { InlineTableField } from './InlineTableField'
import { M2MCombobox, M2MSingleSelectCombobox } from './M2MCombobox'
import { RelationCombobox } from './RelationCombobox'
import { RelationGroupedCombobox } from './RelationGroupedCombobox'
import { RichTextEditor } from './RichTextEditor'
import type { CMSField, CMSRelation } from './types'

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
    const combobox = (
      <RelationCombobox
        collection={m2oRel.one_collection}
        value={value}
        onChange={onChange}
        disabled={field.readonly}
        placeholder={field.placeholder ?? undefined}
        extraFilter={cascadeFilter}
        requiredParent={requiredParentLabel ?? undefined}
      />
    )
    if (!m2oDrillCfg) return combobox
    return (
      <div className='flex items-center gap-1.5'>
        <div className='min-w-0 flex-1'>{combobox}</div>
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
    const fieldOpts = parseJson<{ max_values?: number }>(field.options)
    if (fieldOpts?.max_values === 1) {
      return (
        <M2MSingleSelectCombobox
          relation={m2mRel}
          parentId={itemId}
          allRelations={relations}
          extraFilter={cascadeFilter}
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
        const drawerRelations = Array.isArray(opts.drawer_relations)
          ? opts.drawer_relations
          : undefined
        const parentContextFields = Array.isArray(opts.parent_context_fields) ? opts.parent_context_fields as string[] : undefined
        const uniqueBy = Array.isArray(opts.unique_by) ? opts.unique_by as string[] : undefined
        const sortField = typeof opts.sort_field === 'string' && opts.sort_field ? opts.sort_field : undefined
        const sortDir = opts.sort_dir === 'desc' ? 'desc' as const : 'asc' as const
        return (
          <InlineTableField relatedCollection={o2mCol} manyField={o2mManyField} parentId={itemId} parentCollection={collection} layoutId={layoutId} showRowRevisions={showRowRevisions} allowRevisionRestore={allowRevisionRestore} saveMode={saveMode} showLineNumbers={showLineNumbers} enableReorder={enableReorder} parentCascades={parentCascades} rowRules={rowRules} columnPresets={columnPresets} drawerRelations={drawerRelations} parentContextFields={parentContextFields} uniqueBy={uniqueBy} sortField={sortField} sortDir={sortDir} prefillParentId={prefillParentId} parentFieldKey={field.field} readOnly={field.readonly} />
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
        <select
          value={strVal}
          onChange={(e) => onChange(e.target.value || null)}
          className='h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring'
        >
          <option value=''>— Select —</option>
          {opts.map((o) => (
            <option key={o.value} value={o.value}>
              {o.text}
            </option>
          ))}
        </select>
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
