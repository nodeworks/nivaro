import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useNivaroClient } from '../../../context'
import { get } from '../../../lib/commands'
import type { PlacementRow } from '../../../lib/layout-ops'
import type { CMSRelation } from '../../pipeline/types'
import { ReportWidgetConfigSection } from '../editors/report-widget-config'
import { FieldPicker } from '../pickers/field-picker'
import { useCollectionMeta } from './field-context'
import { Section, Segmented, Setting, TextInput, useInspectorEnv } from './kit'
import { type Binding, bindingsOf } from './model'

interface WidgetDef {
  id: number
  name: string
  widget_type: string
  inputs?: Array<{ key: string; label?: string }> | null
  config?: Record<string, unknown> | null
}

export function useWidgetCatalog(enabled = true) {
  const client = useNivaroClient()
  return useQuery<WidgetDef[]>({
    queryKey: ['layout-editor', 'widgets'],
    queryFn: () =>
      client
        .request<{ data: WidgetDef[] }>(get('/widgets-internal'))
        .then((r) => (Array.isArray(r.data) ? r.data : [])),
    enabled,
    staleTime: 60_000
  })
}

/** The inputs a widget takes: declared, or the ones its type always needs. */
export function widgetInputs(w: WidgetDef | undefined): Array<{ key: string; label: string }> {
  const declared = (w?.inputs ?? []).filter((i) => i?.key)
  if (declared.length) return declared.map((i) => ({ key: i.key, label: i.label || i.key }))
  if (['review_list', 'rollup'].includes(w?.widget_type ?? ''))
    return [{ key: 'record_id', label: 'Record' }]
  if (w?.widget_type === 'report_widget')
    return [{ key: 'entity_filter_value', label: 'Filter value' }]
  const pb = (w?.config?.param_bindings as Array<{ input_key?: string }> | null) ?? []
  return [...new Set(pb.map((b) => b.input_key).filter((k): k is string => !!k))].map((k) => ({
    key: k,
    label: k
  }))
}

export function WidgetInspector({ row }: { row: PlacementRow }) {
  const env = useInspectorEnv()
  const { data: catalog = [] } = useWidgetCatalog()
  const { data: meta } = useCollectionMeta(env.collection)
  const def = catalog.find((w) => w.id === row.widget_id)
  const name = row.label_override || def?.name || 'Widget'
  const at = { field: row.field, group_key: row.group_key }
  const bindings = bindingsOf(row)
  const [confirmRemove, setConfirmRemove] = useState(false)

  const setBinding = (key: string, patch: Partial<Binding>, text?: boolean) => {
    const existing = bindings.find((b) => b.key === key) ?? {
      key,
      binding_type: 'item_field',
      binding_value: ''
    }
    const next = [...bindings.filter((b) => b.key !== key), { ...existing, ...patch }]
    env.apply([{ op: 'update_placement', at, patch: { input_bindings: next } }], {
      label: `Change what ${name} shows`,
      text
    })
  }

  return (
    <div className='space-y-4'>
      <Setting
        k='widget.label_override'
        label='Title'
        effect={def ? `Empty uses "${def.name}".` : undefined}
      >
        <TextInput
          ariaLabel='Title'
          value={row.label_override ?? ''}
          placeholder={def?.name}
          onChange={(v) =>
            env.apply([{ op: 'update_placement', at, patch: { label_override: v || null } }], {
              label: `Rename ${name}`,
              text: true
            })
          }
        />
      </Setting>

      {widgetInputs(def).length > 0 && (
        <Setting
          k='widget.input_bindings'
          label='Inputs'
          effect='Where each input comes from: a field of the record, a fixed value or the page address.'
        >
          <div className='space-y-2' onBlurCapture={() => env.flush()}>
            {widgetInputs(def).map((inp) => {
              const b = bindings.find((x) => x.key === inp.key)
              const type = b?.binding_type ?? 'item_field'
              const value = typeof b?.binding_value === 'string' ? b.binding_value : ''
              return (
                <div key={inp.key} className='space-y-1'>
                  <p className='text-[11px] text-muted-foreground'>{inp.label}</p>
                  <Segmented
                    value={type}
                    options={[
                      { value: 'item_field', label: 'Field' },
                      { value: 'static', label: 'Fixed value' },
                      { value: 'url_param', label: 'Page address' }
                    ]}
                    onChange={(t) => setBinding(inp.key, { binding_type: t, binding_value: '' })}
                  />
                  {type === 'item_field' ? (
                    <FieldPicker
                      collection={env.collection}
                      fields={(meta?.fields ?? []).map((f) => ({
                        field: f.field,
                        type: f.type ?? 'string',
                        interface: f.interface ?? null,
                        hidden: !!f.hidden
                      }))}
                      relations={(meta?.relations ?? []) as unknown as CMSRelation[]}
                      value={value}
                      onChange={(picked) =>
                        setBinding(inp.key, { binding_value: picked.path.join('.') })
                      }
                      onClear={() => setBinding(inp.key, { binding_value: '' })}
                      placeholder='Pick a field…'
                    />
                  ) : (
                    <TextInput
                      ariaLabel={inp.label}
                      value={value}
                      placeholder={type === 'url_param' ? 'parameter name' : 'value'}
                      onChange={(v) => setBinding(inp.key, { binding_value: v }, true)}
                    />
                  )}
                </div>
              )
            })}
          </div>
        </Setting>
      )}

      {def?.widget_type === 'report_widget' && (
        <Section title='Report'>
          <Setting
            k='widget.report_config'
            label='Report and figure'
            scope='field'
            effect='Saved on the widget itself: every form using this widget changes.'
          >
            <ReportWidgetConfigSection widgetId={def.id} config={def.config ?? null} />
          </Setting>
        </Section>
      )}

      <div
        data-setting='widget.remove'
        className='border-t border-slate-200 pt-3 dark:border-border'
      >
        {confirmRemove ? (
          <div className='flex items-center gap-2 text-[12px]'>
            <span>Remove {name} from this form?</span>
            <button
              type='button'
              onClick={() => env.apply([{ op: 'remove', at }], { label: `Remove ${name}` })}
              className='rounded-md bg-red-600 px-2.5 py-1 font-medium text-white hover:bg-red-700'
            >
              Remove
            </button>
            <button
              type='button'
              onClick={() => setConfirmRemove(false)}
              className='rounded-md px-2.5 py-1 hover:bg-muted'
            >
              Keep
            </button>
          </div>
        ) : (
          <button
            type='button'
            onClick={() => setConfirmRemove(true)}
            className='text-[12px] text-red-600 hover:underline dark:text-red-400'
          >
            Remove from this form
          </button>
        )}
      </div>
    </div>
  )
}
