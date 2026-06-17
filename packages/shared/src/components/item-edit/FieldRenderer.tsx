import { Badge } from '../ui/badge'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Switch } from '../ui/switch'
import { Textarea } from '../ui/textarea'
import { parseJson, toLocalDatetime } from './helpers'
import { InlineGridField } from './InlineGridField'
import { M2MCombobox, M2MSingleSelectCombobox } from './M2MCombobox'
import { RelationCombobox } from './RelationCombobox'
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
  requiredParentLabel
}: {
  field: CMSField
  value: unknown
  onChange: (v: unknown) => void
  relations: CMSRelation[]
  collection: string
  itemId: string
  cascadeFilter?: Record<string, unknown>
  requiredParentLabel?: string | null
}) {
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
    return (
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
  }

  // M2M
  const m2mRel =
    isRelIface && !m2oRel
      ? (() => {
          const r = relations.find(
            (rel) => rel.one_collection === collection && rel.one_field === field.field
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
    if (!itemId || itemId === 'new')
      return (
        <p className='text-[12px] text-slate-400 py-1'>
          Save the record first to manage related items
        </p>
      )
    const fieldOpts = parseJson<{ max_values?: number }>(field.options)
    if (fieldOpts?.max_values === 1) {
      return (
        <M2MSingleSelectCombobox
          relation={m2mRel}
          parentId={itemId}
          allRelations={relations}
          extraFilter={cascadeFilter}
          requiredParent={requiredParentLabel ?? undefined}
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
      />
    )
  }

  // Read-only display
  if (field.readonly) {
    const display =
      value === null || value === undefined ? (
        <span className='text-muted-foreground italic text-sm'>—</span>
      ) : typeof value === 'boolean' ? (
        <Badge variant={value ? 'default' : 'secondary'}>{value ? 'Yes' : 'No'}</Badge>
      ) : (
        <span className='text-sm'>{String(value)}</span>
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

  const isNumeric = ['integer', 'bigInteger', 'float', 'decimal', 'numeric'].includes(field.type)
  if (isNumeric) {
    const isInt = field.type === 'integer' || field.type === 'bigInteger'
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
      if (o2mCol && o2mManyField && itemId && itemId !== 'new') {
        return (
          <InlineGridField relatedCollection={o2mCol} manyField={o2mManyField} parentId={itemId} />
        )
      }
      return (
        <p className='text-[12px] text-slate-400 py-1'>
          {!itemId || itemId === 'new'
            ? 'Save the record first to manage related rows'
            : 'Inline grid editing not available in embedded form'}
        </p>
      )
    }
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
