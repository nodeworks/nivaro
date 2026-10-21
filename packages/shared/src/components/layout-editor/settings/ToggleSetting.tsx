import type { LayoutPatch } from '../../../lib/layout-ops'
import { Setting, Toggle } from './controls'
import { column, flag, type SectionProps, toggleLabel } from './section-props'
import { settingDef } from './settings-registry'

/** A yes/no layout column as one setting row: `layout.<column>` saves `{ <column>: bool }`. */
export function ToggleSetting({
  k,
  props,
  disabled,
  note,
  defaultOn = false
}: {
  k: string
  props: SectionProps
  disabled?: boolean
  note?: string
  /** What an unset (NULL) column means. */
  defaultOn?: boolean
}) {
  const col = column(k)
  const raw = props.layout[col]
  const on = raw == null ? defaultOn : flag(raw)
  return (
    <Setting
      k={k}
      note={note}
      control={
        <Toggle
          label={settingDef(k)?.label ?? k}
          checked={on}
          disabled={disabled}
          onChange={(next) => props.set({ [col]: next } as LayoutPatch, toggleLabel(k, next))}
        />
      }
    />
  )
}
