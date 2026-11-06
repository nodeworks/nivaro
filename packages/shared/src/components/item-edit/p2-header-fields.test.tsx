// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { fileDisplayName } from './FilePickerField'
import { clearableParents } from './FieldRow'
import { DeleteLineButton } from './InlineTableField'
import { summaryChoiceLabel } from './SummaryPanel'
import { rosterInitials, rosterName } from './UserChip'
import { transitionToastText, withoutSkippedSendBacks } from '../panels/PipelinePanel'

describe('rosterInitials / rosterName (b11-N10)', () => {
  it('builds initials from the person, never from a redacted placeholder', () => {
    expect(rosterInitials('Joseph Berger')).toBe('JB')
    expect(rosterInitials('Lindsey  Pham')).toBe('LP')
    expect(rosterInitials('Redacted Redacted')).toBe('')
    expect(rosterInitials('')).toBe('')
    expect(rosterInitials(null)).toBe('')
  })
  it('falls back to the card name when the row has none', () => {
    expect(rosterName('Ann Lee', { first_name: 'X', last_name: 'Y' })).toBe('Ann Lee')
    expect(rosterName('', { first_name: 'Ron', last_name: 'Sell' })).toBe('Ron Sell')
    expect(rosterName(undefined, null)).toBe('')
  })
})

describe('fileDisplayName (b01-N11)', () => {
  it('appends the stored extension when the title lacks one', () => {
    expect(fileDisplayName({ title: 'Quote', filename_download: 'quote_v2.pdf' })).toBe('Quote.pdf')
    expect(fileDisplayName({ title: 'Quote.PDF', filename_download: 'q.pdf' })).toBe('Quote.PDF')
    expect(fileDisplayName({ title: 'v1.2', filename_download: 'x.xlsx' })).toBe('v1.2.xlsx')
  })
  it('uses the stored name when there is no title, the title when there is no extension', () => {
    expect(fileDisplayName({ title: null, filename_download: 'a.docx' })).toBe('a.docx')
    expect(fileDisplayName({ title: 'Notes', filename_download: 'notes' })).toBe('Notes')
    expect(fileDisplayName(null)).toBe('')
  })
})

describe('summaryChoiceLabel (b02-N8)', () => {
  const options = JSON.stringify({
    choices: [
      { text: 'In progress', value: 'in_progress' },
      { text: '$t:done', value: 'done' }
    ]
  })
  it('shows the choice label, not the stored key', () => {
    expect(summaryChoiceLabel(options, 'in_progress')).toBe('In progress')
    expect(summaryChoiceLabel(options, 'done')).toBe('Done')
    expect(summaryChoiceLabel(options, 'other')).toBeNull()
    expect(summaryChoiceLabel(null, 'x')).toBeNull()
  })
})

describe('transitionToastText (b09-N9)', () => {
  const data = {
    instance: { current_state: 's1' },
    states: [
      { id: 's1', label: 'Started' },
      { id: 's2', label: 'Waiting on manager approval' }
    ],
    available_transitions: [{ id: 't1', label: 'Submit', to_state: 's2' }]
  }
  it('names the transition and where the record is now', () => {
    expect(
      transitionToastText(data, 't1', {
        data: { new_state: { id: 's2', label: 'Waiting on manager approval' } }
      })
    ).toBe('Submit — now Waiting on manager approval')
    expect(transitionToastText(data, 't1', {})).toBe('Submit — now Waiting on manager approval')
  })
  it('says nothing moved when the answer is the state it was already in', () => {
    expect(transitionToastText(data, 't1', { data: { instance: { current_state: 's1' } } })).toBe(
      'Nothing moved'
    )
  })
  it('falls back to the old words with nothing to go on', () => {
    expect(transitionToastText(null, 'zz', null)).toBe('Transition executed')
  })
})

describe('withoutSkippedSendBacks (b06-N6)', () => {
  const states = [
    { id: 'A', sort: 1 },
    { id: 'B', sort: 2 },
    { id: 'C', sort: 3 }
  ]
  const txs = [
    { id: 'back-a', to_state: 'A' },
    { id: 'back-b', to_state: 'B' },
    { id: 'fwd', to_state: 'C' }
  ]
  it('hides a send back to a skipped step, keeps the rest', () => {
    const out = withoutSkippedSendBacks(txs, states, 'C', new Map([['A', ['no owner']]]))
    expect(out.map((t) => t.id)).toEqual(['back-b', 'fwd'])
  })
  it('never hides a forward move, and does nothing without skipped steps', () => {
    expect(
      withoutSkippedSendBacks(txs, states, 'A', new Map([['C', []]])).map((t) => t.id)
    ).toEqual(['back-a', 'back-b', 'fwd'])
    expect(withoutSkippedSendBacks(txs, states, 'C', null)).toBe(txs)
  })
})

describe('DeleteLineButton (b09-N7)', () => {
  function mount(saved: boolean, onDelete: () => void) {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    act(() => root.render(<DeleteLineButton saved={saved} onDelete={onDelete} />))
    return { host, root }
  }
  it('is labelled, and a saved line needs a second click', () => {
    vi.useFakeTimers()
    const del = vi.fn()
    const { host, root } = mount(true, del)
    const btn = host.querySelector('button') as HTMLButtonElement
    expect(btn.getAttribute('aria-label')).toBe('Delete line')
    act(() => btn.click())
    expect(del).not.toHaveBeenCalled()
    expect(btn.getAttribute('aria-label')).toBe('Click again to delete this line')
    act(() => btn.click())
    expect(del).toHaveBeenCalledTimes(1)
    act(() => root.unmount())
    vi.useRealTimers()
  })
  it('disarms after 3 s', () => {
    vi.useFakeTimers()
    const del = vi.fn()
    const { host, root } = mount(true, del)
    const btn = host.querySelector('button') as HTMLButtonElement
    act(() => btn.click())
    act(() => {
      vi.advanceTimersByTime(3100)
    })
    act(() => btn.click())
    expect(del).not.toHaveBeenCalled()
    act(() => root.unmount())
    vi.useRealTimers()
  })
  it('removes an unsaved line at once', () => {
    const del = vi.fn()
    const { host, root } = mount(false, del)
    act(() => (host.querySelector('button') as HTMLButtonElement).click())
    expect(del).toHaveBeenCalledTimes(1)
    act(() => root.unmount())
  })
})

describe('clearableParents (b02-N1)', () => {
  it('does not offer Clear for a parent that was filled from this field', () => {
    const origin = (k: string) => (k === 'region' ? 'supporting_warehouse' : null)
    expect(clearableParents(['region', 'division'], 'supporting_warehouse', origin)).toEqual([
      'division'
    ])
    expect(clearableParents(['region'], 'install_location', origin)).toEqual(['region'])
    expect(clearableParents(['region'], 'supporting_warehouse')).toEqual(['region'])
  })
})
