// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import {
  approveLayoutText,
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
    const b = withLayoutText(a ?? {}, 'es', 'help', 'Ayuda')
    expect(b).toEqual({ es: { label: 'Nombre', help: 'Ayuda' } })
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

  it('keeps a suggested translation off records until it is approved', () => {
    const row = {
      label: 'Name',
      note: 'Your name',
      _overrides: { i18n: { es: { label: 'Nombre', help: 'Su nombre', draft: true } } }
    }
    expect(translateFieldRow(row, 'es')).toBe(row)
    // Editing keeps it a suggestion; approving makes it live.
    const edited = withLayoutText(readLayoutI18n(row._overrides.i18n), 'es', 'label', 'Nombre!')
    expect(edited?.es.draft).toBe(true)
    const approved = approveLayoutText(edited ?? {}, 'es')
    expect(approved.es).toEqual({ label: 'Nombre!', help: 'Su nombre' })
    expect(translateFieldRow({ ...row, _overrides: { i18n: approved } }, 'es')).toMatchObject({
      label: 'Nombre!',
      note: 'Su nombre'
    })
  })

  it('reads the chosen admin language first', () => {
    localStorage.setItem('nivaro_admin_locale', 'de')
    expect(formLocale()).toBe('de')
  })
})
