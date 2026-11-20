// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { fillBoardRowsNow, isBlankRich, nestedTemplatePaths } from './RecordReadView'

function board(widths: Array<string | [string, 'hidden']>, tracks = 6) {
  const b = document.createElement('div')
  b.style.gridTemplateColumns = Array(tracks).fill('1fr').join(' ')
  for (const w of widths) {
    const s = document.createElement('section')
    const [width, hidden] = Array.isArray(w) ? w : [w, null]
    s.dataset.readWidth = width
    if (hidden) s.hidden = true
    const dl = document.createElement('dl')
    dl.dataset.readDl = width
    s.appendChild(dl)
    b.appendChild(s)
  }
  document.body.appendChild(b)
  fillBoardRowsNow(b)
  return [...b.children].map((c) => (c as HTMLElement).style.gridColumn)
}

describe('read board rows', () => {
  it('stretches a half that sits alone before a full section', () => {
    expect(board(['half', 'full', 'half'])).toEqual(['span 6 / span 6', '', 'span 6 / span 6'])
  })

  it('leaves full rows alone', () => {
    expect(board(['half', 'half', 'full', 'third', 'third', 'third'])).toEqual([
      '',
      '',
      '',
      '',
      '',
      ''
    ])
  })

  it('stretches the last of a short run, skipping hidden sections', () => {
    expect(board(['third', ['half', 'hidden'], 'third', 'full'])).toEqual([
      '',
      '',
      'span 4 / span 4',
      ''
    ])
  })

  it('widens a stretched section to the full-row field grid, and puts it back', () => {
    const b = document.createElement('div')
    b.style.gridTemplateColumns = '1fr 1fr 1fr 1fr 1fr 1fr'
    b.innerHTML =
      '<section data-read-width="half"><dl data-read-dl="half"></dl></section><section data-read-width="full"><dl data-read-dl="full"></dl></section>'
    fillBoardRowsNow(b)
    const dl = b.querySelector('dl') as HTMLElement
    expect(dl.dataset.readDl).toBe('full')
    ;(b.children[1] as HTMLElement).dataset.readWidth = 'half'
    fillBoardRowsNow(b)
    expect(dl.dataset.readDl).toBe('half')
    expect((b.children[0] as HTMLElement).style.gridColumn).toBe('')
  })

  it('does nothing on a narrow (one-track) board', () => {
    expect(board(['half', 'full'], 1)).toEqual(['', ''])
  })
})

describe('read view helpers', () => {
  it('reads rich text with no words as blank', () => {
    expect(isBlankRich(null)).toBe(true)
    expect(isBlankRich('<p></p>')).toBe(true)
    expect(isBlankRich('<p>&nbsp;</p>')).toBe(true)
    expect(isBlankRich('<p>Scope</p>')).toBe(false)
  })

  it('names the link paths a display template reads', () => {
    expect(nestedTemplatePaths('{{core_category.name}} - {{sub_category.name}}')).toBe(
      'core_category.name,sub_category.name'
    )
    expect(nestedTemplatePaths('{{name}}')).toBe('')
    expect(nestedTemplatePaths(null)).toBe('')
  })
})
