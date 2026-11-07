import { describe, expect, it, vi } from 'vitest'

// Army 6 M51: the inbox read "push_mwf: external API request failed —
// /flows/3F525BD5-6B8F-4016-81EB-95A03432B467" — an op key and a flow uuid.

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import { flowErrorNotice, friendlyFlowError } from '../../../services/flow-executor.js'

describe('friendlyFlowError', () => {
  it('drops the step key, flow paths and uuids, and says it in plain words', () => {
    expect(friendlyFlowError('push_mwf: external API request failed', 'push_mwf')).toBe(
      'the external system did not answer'
    )
    expect(
      friendlyFlowError(
        'push_mwf: external API request failed — /flows/3F525BD5-6B8F-4016-81EB-95A03432B467'
      )
    ).toBe('the external system did not answer')
    expect(friendlyFlowError('mail_owners: missing recipient', 'mail_owners')).toBe(
      'the step is not set up (recipient missing)'
    )
    expect(
      friendlyFlowError('HTTP 502 from 3F525BD5-6B8F-4016-81EB-95A03432B467 gateway', null)
    ).toBe('HTTP 502 from gateway')
    expect(friendlyFlowError('', null)).toBe('an unknown error')
  })
})

describe('flowErrorNotice', () => {
  it('names the record by its friendly id', () => {
    expect(
      flowErrorNotice(
        'MWF — link inventory request',
        'the external system did not answer',
        'CM26INV-37422'
      )
    ).toEqual({
      subject: 'Flow "MWF — link inventory request" failed for CM26INV-37422',
      message:
        'MWF — link inventory request failed for CM26INV-37422: the external system did not answer.'
    })
  })
  it('without a record it names none (never a row id)', () => {
    expect(flowErrorNotice('Nightly sync', 'timeout', null).message).toBe(
      'Nightly sync failed: timeout.'
    )
  })
})
