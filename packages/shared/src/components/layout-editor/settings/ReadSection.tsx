import { HeaderFieldsPicker, SheetWidthInput } from '../editors/ReadPresentationEditor'
import { Segmented, Setting } from './controls'
import { changeLabel, flag, type SectionProps } from './section-props'
import { useSettingsFields } from './settings-api'
import { ToggleSetting } from './ToggleSetting'

function headerFieldsOf(raw: unknown): string[] {
  let v = raw
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v)
    } catch {
      return []
    }
  }
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

export function ReadSection(props: SectionProps) {
  const { layout, collection } = props
  const fields = useSettingsFields(collection)
  const summaryOn = flag(layout.summary_enabled)
  const width = layout.sheet_width == null ? null : Number(layout.sheet_width)
  return (
    <>
      <ToggleSetting k='layout.summary_enabled' props={props} />
      <ToggleSetting
        k='layout.summary_hide_empty'
        props={props}
        disabled={!summaryOn}
        note={summaryOn ? undefined : 'Turn on the summary side panel first.'}
      />
      <Setting
        k='layout.display_mode'
        control={
          <Segmented<'form' | 'read'>
            ariaLabel='Drill-down opens as'
            value={layout.display_mode === 'read' ? 'read' : 'form'}
            options={[
              { value: 'form', label: 'Form' },
              { value: 'read', label: 'Read view' }
            ]}
            onChange={(v) =>
              props.set(
                { display_mode: v === 'read' ? 'read' : null },
                changeLabel('layout.display_mode')
              )
            }
          />
        }
      />
      <Setting
        k='layout.sheet_width'
        htmlFor='setting-sheet_width'
        control={
          <SheetWidthInput
            id='setting-sheet_width'
            value={Number.isFinite(width) ? width : null}
            onChange={(w) => props.set({ sheet_width: w }, changeLabel('layout.sheet_width'))}
          />
        }
      />
      <Setting k='layout.header_fields'>
        <HeaderFieldsPicker
          value={headerFieldsOf(layout.header_fields)}
          fields={fields}
          onChange={(keys) =>
            props.set({ header_fields: keys }, changeLabel('layout.header_fields'))
          }
        />
      </Setting>
      <ToggleSetting k='layout.hide_empty' props={props} />
    </>
  )
}
