// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import {
  formLocale,
  layoutText,
  readLayoutI18n,
  translateFieldRow,
  translateGroup,
  withLayoutText
} from './layout-i18n'

describe('layout i18n', () => {
  afterEach(() => {
    localStorage.removeItem('nivaro_admin_locale')
  })

  it('sets and clears one text, dropping empty locales', () => {
    const a = withLayoutText({}, 'es', 'label', 'Nombre')
    expect(a).toEqual({ es: { label: 'Nombre' } })
    const b = withLayoutText(a ?? {}, 'es', 'note', 'Ayuda')
    expect(b).toEqual({ es: { label: 'Nombre', note: 'Ayuda' } })
    expect(withLayoutText({ es: { label: 'Nombre' } }, 'es', 'label', '  ')).toBeUndefined()
  })

  it('matches the exact locale, then the language', () => {
    const map = readLayoutI18n('{"pt":{"label":"Nome"},"es-mx":{"label":"Nombre MX"}}')
    expect(layoutText(map, 'pt-br', 'label')).toBe('Nome')
    expect(layoutText(map, 'es-mx', 'label')).toBe('Nombre MX')
    expect(layoutText(map, 'es', 'label')).toBe('Nombre MX')
    expect(layoutText(map, 'fr', 'label')).toBeNull()
  })

  it('translates a field row and a group only where the form has the text', () => {
    const row = {
      label: 'Name',
      note: 'Your name',
      _overrides: { i18n: { es: { label: 'Nombre' } } }
    }
    expect(translateFieldRow(row, 'es')).toEqual({ ...row, label: 'Nombre' })
    expect(translateFieldRow(row, 'fr')).toBe(row)
    // A hidden label stays hidden.
    expect(translateFieldRow({ ...row, label: '' }, 'es').label).toBe('')
    expect(translateGroup({ label: 'Basics', i18n: '{"es":{"label":"Básico"}}' }, 'es').label).toBe(
      'Básico'
    )
    expect(translateGroup({ label: 'Basics' }, 'es').label).toBe('Basics')
  })

  it('reads the chosen admin language first', () => {
    localStorage.setItem('nivaro_admin_locale', 'de')
    expect(formLocale()).toBe('de')
  })
})
