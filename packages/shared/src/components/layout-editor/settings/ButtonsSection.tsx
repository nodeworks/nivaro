import { flag, type SectionProps } from './section-props'
import { TextSetting } from './TextSetting'
import { ToggleSetting } from './ToggleSetting'

/**
 * The dossier route reads the switch and label from the collection's default
 * (active grouped) form only, so say what a switch here actually does.
 */
function dossierNote(props: SectionProps): string | null {
  if (props.kind !== 'grouped')
    return 'No effect on this kind of layout: the Dossier button follows the default form.'
  if (!flag(props.layout.is_active))
    return 'Takes effect while this form is the default; until then the default form decides.'
  return null
}

export function ButtonsSection(props: SectionProps) {
  const dossierOn = flag(props.layout.dossier_enabled)
  const note = dossierNote(props)
  // On a kind the server never reads, the switch can only be turned off.
  const inert = props.kind !== 'grouped'
  return (
    <>
      <ToggleSetting k='layout.ai_enabled' props={props} />
      <ToggleSetting
        k='layout.dossier_enabled'
        props={props}
        disabled={inert && !dossierOn}
        note={note ?? undefined}
      />
      <TextSetting
        k='layout.dossier_label'
        props={props}
        placeholder='Dossier'
        disabled={!dossierOn}
        note={dossierOn ? note : 'Turn on the Dossier button first.'}
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
