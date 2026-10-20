import { flag, type SectionProps } from './section-props'
import { TextSetting } from './TextSetting'
import { ToggleSetting } from './ToggleSetting'

export function ButtonsSection(props: SectionProps) {
  const dossierOn = flag(props.layout.dossier_enabled)
  return (
    <>
      <ToggleSetting k='layout.ai_enabled' props={props} />
      <ToggleSetting k='layout.dossier_enabled' props={props} />
      <TextSetting
        k='layout.dossier_label'
        props={props}
        placeholder='Dossier'
        disabled={!dossierOn}
        note={dossierOn ? null : 'Turn on the Dossier button first.'}
      />
      <ToggleSetting k='layout.disable_comments' props={props} />
      <ToggleSetting k='layout.disable_tasks' props={props} />
      <ToggleSetting k='layout.disable_revisions' props={props} />
      <ToggleSetting k='layout.disable_clone' props={props} />
      <ToggleSetting k='layout.disable_delete' props={props} />
      <ToggleSetting k='layout.hide_integrity_banner' props={props} />
      <ToggleSetting k='layout.hide_sla_banner' props={props} />
      <ToggleSetting k='layout.changes_tray' props={props} />
      <ToggleSetting k='layout.allow_schedule' props={props} />
      <ToggleSetting k='layout.allow_disable_pickers' props={props} />
    </>
  )
}
