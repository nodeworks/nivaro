import { readLayoutI18n, withLayoutText } from '../../../lib/layout-i18n'
import type { GroupRow } from '../../../lib/layout-ops'
import { titleCase } from '../../../lib/utils'
import { useTranslationSummary } from '../inspect/inspect-api'
import { effectText } from '../panel-style'
import { useFieldCtx } from './field-context'
import { Section, Setting, TextInput, useInspectorEnv } from './kit'

// #2665: this form's text in the other languages of Settings → Localization —
// a field's label and help text (placement overrides.i18n) and a section's
// label (the group's i18n). The first language there is the one the form is
// written in; the record form shows a reader's language when it has it.

const upper = (l: string) => l.toUpperCase()

export function FieldTranslations() {
  const ctx = useFieldCtx()
  const { info, ov, env } = ctx
  const { data } = useTranslationSummary(env.collection)
  const locales = data?.locales ?? []
  if (!locales.length) return null
  const map = readLayoutI18n(ov.i18n)
  const baseLabel = typeof ov.label === 'string' && ov.label ? ov.label : info.label
  const baseNote = (typeof ov.note === 'string' && ov.note) || info.global?.note || ''
  const missing = locales.reduce(
    (n, l) => n + (map[l]?.label ? 0 : 1) + (baseNote && !map[l]?.note ? 1 : 0),
    0
  )
  const set = (locale: string, key: 'label' | 'note', value: string) =>
    ctx.setOverride(
      'i18n',
      withLayoutText(readLayoutI18n(ov.i18n), locale, key, value),
      `Translate the ${key === 'label' ? 'label' : 'help text'} of ${info.label} (${upper(locale)})`,
      true
    )
  return (
    <Section
      title={missing ? `Translations · ${missing} missing` : 'Translations'}
      collapsible
      defaultOpen={false}
    >
      <p className={effectText}>
        Shown to people reading in that language. Empty uses the text above (
        {upper(data?.base ?? 'en')}).
      </p>
      {locales.map((l) => (
        <div key={l} data-translation-locale={l} className='space-y-3'>
          <Setting
            k='field.i18n.label'
            label={`Label (${upper(l)})`}
            effect={`What this form calls the field in ${upper(l)}.`}
          >
            <TextInput
              ariaLabel={`Label in ${upper(l)}`}
              value={map[l]?.label ?? ''}
              placeholder={baseLabel}
              onChange={(v) => set(l, 'label', v)}
            />
          </Setting>
          <Setting
            k='field.i18n.note'
            label={`Help text (${upper(l)})`}
            effect={
              baseNote ? 'The line of help under the field.' : 'Shown only once the field has help.'
            }
          >
            <TextInput
              ariaLabel={`Help text in ${upper(l)}`}
              value={map[l]?.note ?? ''}
              placeholder={baseNote}
              onChange={(v) => set(l, 'note', v)}
            />
          </Setting>
        </div>
      ))}
    </Section>
  )
}

export function GroupTranslations({ group }: { group: GroupRow }) {
  const env = useInspectorEnv()
  const { data } = useTranslationSummary(env.collection)
  const locales = data?.locales ?? []
  if (!locales.length || !['section', 'tab', 'metadata'].includes(group.type)) return null
  const name = group.label || titleCase(group.key)
  if (!data?.groups_supported)
    return (
      <p data-setting='group.i18n' className={effectText}>
        Section names can be translated once the database is updated (migration 465).
      </p>
    )
  const map = readLayoutI18n(group.i18n)
  const set = (locale: string, value: string) => {
    const next = withLayoutText(readLayoutI18n(group.i18n), locale, 'label', value)
    env.apply(
      [
        {
          op: 'group_update',
          key: group.key,
          patch: { i18n: next ? JSON.stringify(next) : null }
        }
      ],
      { label: `Translate the name of ${name} (${upper(locale)})`, text: true }
    )
  }
  return (
    <Section title='Translations' collapsible defaultOpen={false}>
      {locales.map((l) => (
        <Setting
          key={l}
          k='group.i18n.label'
          label={`Name (${upper(l)})`}
          effect={`The heading people reading in ${upper(l)} see. Empty uses the name above.`}
        >
          <TextInput
            ariaLabel={`Name in ${upper(l)}`}
            value={map[l]?.label ?? ''}
            placeholder={name}
            onChange={(v) => set(l, v)}
          />
        </Setting>
      ))}
    </Section>
  )
}
