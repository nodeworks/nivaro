import {
  CANVAS_SLOT_KEYS,
  HEADER_GROUP_KEY,
  type PlacementPatch,
  type PlacementRow
} from '../../../lib/layout-ops'
import { PdfFieldConfig } from '../editors/pdf-field-config'
import {
  Buffered,
  Choice,
  Section,
  Segmented,
  Setting,
  TextInput,
  Toggle,
  useInspectorEnv
} from './kit'
import { placeSlotOps, readOverrides, withKey } from './model'
import { useLayoutsOf } from './PickerTab'

export const WIDTHS = [
  { value: '12', label: 'Full' },
  { value: '6', label: '½' },
  { value: '4', label: '⅓' },
  { value: '3', label: '¼' }
]

export const SLOT_NAMES: Record<string, string> = {
  __pipeline__: 'Pipeline',
  __comments__: 'Comments',
  __tasks__: 'Tasks',
  __addendums__: 'Addendums',
  __referenced_by__: 'Referenced by',
  __related_records__: 'Related records',
  __owners__: 'Owners',
  __pdf__: 'PDF button'
}

export function slotName(field: string): string {
  const ext = /^__ext_(.+)__$/.exec(field)
  if (ext) return `Extension slot ${ext[1]}`
  return SLOT_NAMES[field] ?? field
}

/**
 * Writes one slot's columns: an update when the slot has a row on this
 * layout, else its first row where it is drawn now (slots show by default
 * without one — see placeSlotOps).
 */
export function useSlotWriter(field: string, groupKey: string | null, row: PlacementRow | null) {
  const env = useInspectorEnv()
  return (patch: PlacementPatch, label: string, text?: boolean) =>
    env.apply(
      row
        ? [{ op: 'update_placement', at: { field, group_key: groupKey }, patch }]
        : placeSlotOps(env.bundle, field, groupKey, patch),
      { label, text }
    )
}

export function SlotInspector({
  field,
  groupKey,
  row
}: {
  field: string
  groupKey: string | null
  row: PlacementRow | null
}) {
  const env = useInspectorEnv()
  const write = useSlotWriter(field, groupKey, row)
  const name = slotName(field)
  const isCard = (CANVAS_SLOT_KEYS as readonly string[]).includes(field)
  const ov = readOverrides(row)
  const setOv = (key: string, value: unknown, label: string, text?: boolean) =>
    write({ overrides: withKey(ov, key, value) }, label, text)
  const { data: layouts = [] } = useLayoutsOf(field === '__pdf__' ? env.collection : null)
  const fileLayouts = layouts.filter((l) => l.layout_type === 'file')

  return (
    <div className='space-y-4'>
      {isCard && (
        <>
          <Setting k='slot.label_override' label='Title' effect={`Empty uses "${name}".`}>
            <TextInput
              ariaLabel='Title'
              value={row?.label_override ?? ''}
              placeholder={name}
              onChange={(v) =>
                write({ label_override: v.trim() && v !== name ? v : null }, `Rename ${name}`, true)
              }
            />
          </Setting>
          <Toggle
            k='slot.is_visible'
            label='Show on this form'
            effect='Off leaves the panel off this form.'
            checked={row?.is_visible ?? true}
            onChange={(v) => write({ is_visible: v }, v ? `Show ${name}` : `Hide ${name}`)}
          />
          <Toggle
            k='slot.default_expanded'
            label='Starts open'
            effect='Off shows the panel folded until someone opens it.'
            checked={row?.default_expanded ?? field !== '__related_records__'}
            onChange={(v) =>
              write(
                { default_expanded: v },
                v ? `Open ${name} at first` : `Collapse ${name} at first`
              )
            }
          />
        </>
      )}
      {field === '__pipeline__' && (
        <Section title='Action buttons'>
          <p className='text-[11px] text-muted-foreground'>
            The header can already show the transition buttons; hide them here to avoid doubles.
          </p>
          <Toggle
            k='slot.pipeline.hide_actions_collapsed'
            label='Hide while collapsed'
            effect='No transition buttons while the panel is folded.'
            checked={ov.hide_actions_collapsed === true}
            onChange={(v) =>
              setOv('hide_actions_collapsed', v || undefined, `Change the ${name} buttons`)
            }
          />
          <Toggle
            k='slot.pipeline.hide_actions_expanded'
            label='Hide while open'
            effect='No transition buttons while the panel is open.'
            checked={ov.hide_actions_expanded === true}
            onChange={(v) =>
              setOv('hide_actions_expanded', v || undefined, `Change the ${name} buttons`)
            }
          />
          <Toggle
            k='slot.pipeline.show_approval_chain'
            label='Approval chain button'
            effect='A button that shows who approves next.'
            checked={row?.show_approval_chain ?? false}
            onChange={(v) =>
              write(
                { show_approval_chain: v },
                v ? 'Show the approval chain button' : 'Hide the approval chain button'
              )
            }
          />
        </Section>
      )}
      {field === '__pdf__' && (
        <>
          <Buffered value={typeof ov.filename_template === 'string' ? ov.filename_template : ''}>
            {(filename, keep) => (
              <PdfFieldConfig
                tableName={env.collection}
                value={typeof ov.attach_to_field === 'string' ? ov.attach_to_field : null}
                filenameTemplate={filename || null}
                onChange={(v) =>
                  setOv('attach_to_field', v ?? undefined, 'Change where the PDF is attached')
                }
                onFilenameChange={(v) =>
                  setOv(
                    'filename_template',
                    keep(v ?? '') || undefined,
                    'Change the PDF file name',
                    true
                  )
                }
              />
            )}
          </Buffered>
          <Section title='Advanced'>
            <Setting
              k='pdf_button.source_layout_id'
              label='Render from'
              effect='A PDF layout of this collection; otherwise the form itself.'
            >
              <Choice
                ariaLabel='Render from'
                value={typeof ov.source_layout_id === 'number' ? String(ov.source_layout_id) : ''}
                options={[
                  { value: '', label: 'This form' },
                  ...fileLayouts.map((l) => ({ value: String(l.id), label: l.name }))
                ]}
                onChange={(v) =>
                  setOv(
                    'source_layout_id',
                    v ? Number(v) : undefined,
                    'Change what the PDF renders'
                  )
                }
              />
            </Setting>
            <Toggle
              k='pdf_button.auto_generate_on_save'
              label='Make the PDF on every save'
              effect='Each save of the record makes a new PDF.'
              checked={ov.auto_generate_on_save === true}
              onChange={(v) =>
                setOv('auto_generate_on_save', v || undefined, 'Change when the PDF is made')
              }
            />
            <Toggle
              k='pdf_button.overwrite_generated'
              label='Replace the last generated PDF'
              effect='Off keeps every generated file.'
              checked={ov.overwrite_generated !== false}
              onChange={(v) =>
                setOv('overwrite_generated', v ? undefined : false, 'Change how PDFs are kept')
              }
            />
          </Section>
        </>
      )}
      {!isCard && groupKey !== null && groupKey !== HEADER_GROUP_KEY && (
        <Setting k='field.col_span' label='Width' effect='Share of the row it takes.'>
          <Segmented
            value={String(row?.col_span ?? 12)}
            options={WIDTHS}
            onChange={(v) =>
              write({ col_span: v === '12' ? null : Number(v) }, `Change the width of ${name}`)
            }
          />
        </Setting>
      )}
      {!isCard && field !== '__pdf__' && (groupKey === null || groupKey === HEADER_GROUP_KEY) && (
        <p className='text-[12px] text-muted-foreground'>
          {name} has no settings beyond its place.
        </p>
      )}
    </div>
  )
}
