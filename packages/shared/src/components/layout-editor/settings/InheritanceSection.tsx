import { PickList, quietText, Setting } from './controls'
import { changeLabel, type SectionProps } from './section-props'
import { useCollectionLayoutList } from './settings-api'

export function InheritanceSection(props: SectionProps) {
  const { layout, collection } = props
  const id = Number(layout.id)
  const layouts = useCollectionLayoutList(collection)
  const parentId = layout.parent_layout_id == null ? null : String(layout.parent_layout_id)
  const children = layouts.filter((l) => Number(l.parent_layout_id) === id)
  // One level, same collection: a parent has no parent of its own, and a layout
  // others inherit from cannot itself inherit.
  const options = layouts
    .filter((l) => l.id !== id && !l.parent_layout_id)
    .map((l) => ({ value: String(l.id), label: l.name }))
  return (
    <Setting
      k='layout.parent_layout_id'
      control={
        <PickList
          ariaLabel='Inherit from'
          value={parentId}
          options={options}
          clearLabel='Nothing'
          disabled={children.length > 0 && !parentId}
          emptyText='No other layout to inherit from'
          onChange={(v) =>
            props.set(
              { parent_layout_id: v ? Number(v) : null },
              changeLabel('layout.parent_layout_id')
            )
          }
        />
      }
      note={
        children.length > 0 ? (
          <span className={quietText}>
            {children.map((c) => c.name).join(', ')}{' '}
            {children.length === 1 ? 'inherits' : 'inherit'} from this form, so it cannot inherit
            from another.
          </span>
        ) : null
      }
    />
  )
}
