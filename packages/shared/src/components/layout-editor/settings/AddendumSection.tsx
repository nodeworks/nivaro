import { PickList, Setting } from './controls'
import { changeLabel, type SectionProps } from './section-props'
import { useCollectionLayoutList, useWorkflowTemplates } from './settings-api'
import { ToggleSetting } from './ToggleSetting'

export function AddendumSection(props: SectionProps) {
  const { layout, kind, collection } = props
  const workflows = useWorkflowTemplates(kind === 'addendum')
  const addendumForms = useCollectionLayoutList(collection, 'addendum')
  return (
    <>
      <Setting
        k='layout.workflow_template_id'
        control={
          <PickList
            ariaLabel='Addendum workflow'
            value={layout.workflow_template_id ? String(layout.workflow_template_id) : null}
            options={workflows.map((w) => ({ value: w.id, label: w.name }))}
            clearLabel='No workflow'
            emptyText='No workflows yet'
            onChange={(v) =>
              props.set({ workflow_template_id: v }, changeLabel('layout.workflow_template_id'))
            }
          />
        }
      />
      <ToggleSetting k='layout.single_active_addendum' props={props} />
      <Setting
        k='layout.addendum_layout_id'
        control={
          <PickList
            ariaLabel='Addendum form'
            value={layout.addendum_layout_id == null ? null : String(layout.addendum_layout_id)}
            options={addendumForms.map((l) => ({ value: String(l.id), label: l.name }))}
            clearLabel="Collection's default"
            emptyText='This collection has no addendum forms'
            onChange={(v) =>
              props.set(
                { addendum_layout_id: v ? Number(v) : null },
                changeLabel('layout.addendum_layout_id')
              )
            }
          />
        }
      />
      <ToggleSetting k='layout.addendum_default_view' props={props} />
    </>
  )
}
