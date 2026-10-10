// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { maskInputsIn } from '../../lib/screenshot'
import { buildReportPayload } from './ReportProblem'

describe('buildReportPayload', () => {
  it('carries the sentence, route, app, screenshot, context and replay', () => {
    const body = buildReportPayload({
      sentence: '  The upload spins forever  ',
      route: '/claims/7/upload?step=2#top',
      app: 'efp',
      screenshot: 'data:image/jpeg;base64,AAA',
      includeShot: true,
      context: {
        text: 'Page: /claims/7/upload',
        fileId: 'f-1',
        replay: { recording_id: 'r-1', offset_ms: 52_000 }
      }
    })
    expect(body).toEqual({
      sentence: 'The upload spins forever',
      route: '/claims/7/upload?step=2',
      app: 'efp',
      screenshot: 'data:image/jpeg;base64,AAA',
      context: 'Page: /claims/7/upload',
      attachments: ['f-1'],
      replay: { recording_id: 'r-1', offset_ms: 52_000 }
    })
  })

  it('leaves out what the person unticked or what was not there', () => {
    const body = buildReportPayload({
      sentence: 'x',
      route: '/a',
      screenshot: 'data:image/jpeg;base64,AAA',
      includeShot: false,
      context: null
    })
    expect(body).toEqual({
      sentence: 'x',
      route: '/a',
      screenshot: null,
      context: null,
      attachments: []
    })
  })
})

describe('maskInputsIn', () => {
  it('hides every typed value before the screenshot, and nvr-no-record blocks', () => {
    document.body.innerHTML = `
      <input id="name" value="Jane Doe" />
      <input id="empty" value="" />
      <input id="pw" type="password" value="hunter2" />
      <input id="btn" type="submit" value="Save" />
      <textarea id="ta">secret notes</textarea>
      <select id="sel"><option>Zone 1</option></select>
      <div id="ce" contenteditable="true">draft</div>
      <div id="blocked" class="nvr-no-record">ssn</div>`
    maskInputsIn(document)
    const v = (id: string) => (document.getElementById(id) as HTMLInputElement).value
    expect(v('name')).toBe('••••••')
    expect(v('empty')).toBe('')
    expect(v('pw')).toBe('••••••')
    expect(v('btn')).toBe('Save')
    expect(v('ta')).toBe('••••••')
    expect(document.querySelector('#sel option')?.textContent).toBe('••••••')
    expect(document.getElementById('ce')?.textContent).toBe('••••••')
    expect((document.getElementById('blocked') as HTMLElement).style.visibility).toBe('hidden')
  })
})
