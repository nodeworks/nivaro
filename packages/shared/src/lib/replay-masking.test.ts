// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import {
  buildReplayMaskingOptions,
  DEFAULT_REPLAY_MASKING,
  isReplayFieldAllowed,
  normalizeReplayMasking,
  type ReplayMaskingRules,
  shouldMaskReplayInput,
  shouldMaskReplayText
} from './replay-masking'

function rules(over: Partial<ReplayMaskingRules> = {}): ReplayMaskingRules {
  return { ...DEFAULT_REPLAY_MASKING, ...over }
}

const $ = (sel: string) => document.querySelector(sel) as HTMLElement

beforeEach(() => {
  document.body.innerHTML = `
    <main>
      <h1 id='title'>Order 1042</h1>
      <input id='search' value='acme' />
      <input id='pw' type='password' value='hunter2' />
      <div data-field='status' data-field-collection='orders' data-field-interface='select-dropdown'>
        <label data-field-label id='status-label'>Status</label>
        <span id='status-value'>Shipped</span>
        <input id='status-input' value='shipped' />
      </div>
      <div data-field='customer_name' data-field-collection='orders'>
        <label data-field-label>Customer</label>
        <input id='name-input' value='Jane Doe' />
        <span id='name-value'>Jane Doe</span>
      </div>
      <div data-field='notes' data-field-collection='orders' data-field-interface='input-rich-text-html'>
        <div class='ProseMirror' contenteditable='true'><p id='notes-text'>Call after 5</p></div>
      </div>
      <div data-field='attachment' data-field-collection='orders' data-field-interface='file'>
        <p id='file-name' data-file-name>invoice.pdf</p>
        <span id='file-meta'>120 KB</span>
      </div>
      <section data-collection='orders'>
        <dd data-replay-field='code' id='code-value'>ORD-1042</dd>
      </section>
      <div id='library-name' data-file-name>payroll.xlsx</div>
      <div class='ProseMirror' id='comment'>A comment</div>
    </main>`
})

describe('normalizeReplayMasking', () => {
  it('defaults every switch to masked', () => {
    expect(normalizeReplayMasking(null)).toEqual(DEFAULT_REPLAY_MASKING)
    expect(normalizeReplayMasking('not json')).toEqual(DEFAULT_REPLAY_MASKING)
  })

  it('reads JSON text and drops allow entries that are not collection.field', () => {
    const r = normalizeReplayMasking(
      JSON.stringify({
        mask_rich_text: false,
        allow_fields: ['orders.status', 'orders.status', '*.code', 'bad', 'a.b"]', 7]
      })
    )
    expect(r).toEqual({
      mask_rich_text: false,
      mask_file_names: true,
      allow_fields: ['orders.status', '*.code']
    })
  })
})

describe('isReplayFieldAllowed', () => {
  it('matches the collection, or any collection for *', () => {
    const r = rules({ allow_fields: ['orders.status', '*.code'] })
    expect(isReplayFieldAllowed(r, 'orders', 'status')).toBe(true)
    expect(isReplayFieldAllowed(r, 'invoices', 'status')).toBe(false)
    expect(isReplayFieldAllowed(r, null, 'status')).toBe(false)
    expect(isReplayFieldAllowed(r, 'anything', 'code')).toBe(true)
  })
})

describe('shouldMaskReplayText', () => {
  it('masks every field value by default and leaves page chrome and labels alone', () => {
    const r = rules()
    expect(shouldMaskReplayText($('#title'), r)).toBe(false)
    expect(shouldMaskReplayText($('#status-label'), r)).toBe(false)
    expect(shouldMaskReplayText($('#status-value'), r)).toBe(true)
    expect(shouldMaskReplayText($('#name-value'), r)).toBe(true)
    expect(shouldMaskReplayText($('#code-value'), r)).toBe(true)
  })

  it('shows an allowed field while the rest stays masked', () => {
    const r = rules({ allow_fields: ['orders.status', 'orders.code'] })
    expect(shouldMaskReplayText($('#status-value'), r)).toBe(false)
    expect(shouldMaskReplayText($('#name-value'), r)).toBe(true)
    // read view: the collection comes from an ancestor
    expect(shouldMaskReplayText($('#code-value'), r)).toBe(false)
  })

  it('keeps rich text and file names masked even in an allowed field', () => {
    const r = rules({ allow_fields: ['orders.notes', 'orders.attachment'] })
    expect(shouldMaskReplayText($('#notes-text'), r)).toBe(true)
    expect(shouldMaskReplayText($('#file-name'), r)).toBe(true)
    expect(shouldMaskReplayText($('#file-meta'), r)).toBe(true)
    // outside any field too
    expect(shouldMaskReplayText($('#library-name'), r)).toBe(true)
    expect(shouldMaskReplayText($('#comment'), r)).toBe(true)
  })

  it('lets an admin switch the rich text and file name rules off', () => {
    const r = rules({
      mask_rich_text: false,
      mask_file_names: false,
      allow_fields: ['orders.notes', 'orders.attachment']
    })
    expect(shouldMaskReplayText($('#notes-text'), r)).toBe(false)
    expect(shouldMaskReplayText($('#file-name'), r)).toBe(false)
    expect(shouldMaskReplayText($('#library-name'), r)).toBe(false)
    expect(shouldMaskReplayText($('#comment'), r)).toBe(false)
    // a field nobody allowed is still masked
    expect(shouldMaskReplayText($('#name-value'), r)).toBe(true)
  })
})

describe('shouldMaskReplayInput', () => {
  it('masks every input except inside an allowed field, and never a password', () => {
    const r = rules({ allow_fields: ['orders.status', '*.pw'] })
    expect(shouldMaskReplayInput($('#search'), r)).toBe(true)
    expect(shouldMaskReplayInput($('#status-input'), r)).toBe(false)
    expect(shouldMaskReplayInput($('#name-input'), r)).toBe(true)
    expect(shouldMaskReplayInput($('#pw'), r)).toBe(true)
  })
})

describe('buildReplayMaskingOptions', () => {
  it('casts a wide selector net and lets the functions decide', () => {
    const opts = buildReplayMaskingOptions(rules({ allow_fields: ['orders.status'] }))
    expect(opts.maskAllInputs).toBe(true)
    expect(opts.blockClass).toBe('nvr-no-record')
    expect($('#status-value').closest(opts.maskTextSelector)).not.toBeNull()
    expect($('#comment').closest(opts.maskTextSelector)).not.toBeNull()
    expect($('#title').closest(opts.maskTextSelector)).toBeNull()
    expect(opts.maskTextFn('Shipped', $('#status-value'))).toBe('Shipped')
    expect(opts.maskTextFn('Jane Doe', $('#name-value'))).toBe('**** ***')
    expect(opts.maskInputFn('shipped', $('#status-input'))).toBe('shipped')
    expect(opts.maskInputFn('Jane', $('#name-input'))).toBe('****')
  })

  it('blocks file thumbnails only while file names are masked', () => {
    expect(buildReplayMaskingOptions(rules()).blockSelector).toContain(
      '[data-field-interface="file-image"] img'
    )
    expect(buildReplayMaskingOptions(rules({ mask_file_names: false })).blockSelector).toBe(
      '.nvr-no-record, [data-replay-block]'
    )
  })

  it('reads the rules through a getter, so a change applies without restarting', () => {
    let current = rules()
    const opts = buildReplayMaskingOptions(() => current)
    expect(opts.maskTextFn('Shipped', $('#status-value'))).toBe('*******')
    current = rules({ allow_fields: ['orders.status'] })
    expect(opts.maskTextFn('Shipped', $('#status-value'))).toBe('Shipped')
  })
})
