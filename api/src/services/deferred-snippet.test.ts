import { describe, expect, it } from 'vitest'
import {
  decodeDeferredSnippet,
  encodeDeferredSnippet,
  mailSummaryText
} from './deferred-snippet.js'

// The shape of the branded transition mail (efp base.liquid): title, hidden preheader, brand
// header, then the card body with an eyebrow, the headline, a "Triggered by" line, the summary
// sentence and the button.
const MAIL = `<!doctype html><html><head><title>Engineering Finance Portal</title>
<style>body{margin:0}</style></head><body>
<div style="display:none;font-size:1px;">Engineering Finance Portal&#847;&#847;</div>
<table><tr><td id="card-hdr"><span>Engineering <span>Finance Portal</span></span><span>EFP</span></td></tr>
<tr><td id="card-body">
<p style="margin:0;text-transform:uppercase;">Approve</p>
<h1>CR26-81427 is now Waiting on Level 5 Approval</h1>
<p>Triggered by <strong>Steven Musembi</strong> &middot; Nov 8, 2026 at 3:28 PM</p>
<p>From <strong>Waiting on Level 4 Approval</strong> to <strong>Waiting on Level 5 Approval</strong>. It is now waiting on you.</p>
<p><a href="https://portal/records/workflows/1" style="display:inline-block;padding:11px">Open record</a></p>
</td></tr><tr><td id="card-ftr"><p>You're getting this because you own this step.</p></td></tr></table>
</body></html>`

describe('mailSummaryText', () => {
  it('keeps the summary sentence, never the title, preheader, brand, headline, button or footer', () => {
    const t = mailSummaryText(MAIL)
    expect(t).toBe(
      'From Waiting on Level 4 Approval to Waiting on Level 5 Approval. It is now waiting on you.'
    )
    expect(t).not.toMatch(/Engineering Finance Portal|Open record|Triggered by|getting this/)
  })

  it('passes plain text through, trimmed', () => {
    expect(mailSummaryText('  Hello   there \n')).toBe('Hello there')
  })
})

describe('deferred snippet round trip', () => {
  it('carries the record so the summary can link it', () => {
    const raw = encodeDeferredSnippet(MAIL, { collection: 'workflows', item: 372991 })
    expect(decodeDeferredSnippet(raw)).toEqual({
      text: 'From Waiting on Level 4 Approval to Waiting on Level 5 Approval. It is now waiting on you.',
      collection: 'workflows',
      item: '372991'
    })
  })

  it('an old plain row (the stripped page) shows nothing rather than boilerplate', () => {
    expect(
      decodeDeferredSnippet('Engineering Finance Portal Engineering Finance Portal EFP Approve')
    ).toEqual({ text: '', collection: null, item: null })
  })
})
