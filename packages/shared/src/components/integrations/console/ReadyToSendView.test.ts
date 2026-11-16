import { describe, expect, it } from 'vitest'
import { tidyRowLabel } from './ReadyToSendView'

describe('tidyRowLabel', () => {
  it('drops separators left by an empty template part', () => {
    expect(tidyRowLabel('· Line 1')).toBe('Line 1')
    expect(tidyRowLabel('Cable assy · ')).toBe('Cable assy')
    expect(tidyRowLabel('Cable assy · Line 3')).toBe('Cable assy · Line 3')
  })
  it('keeps a label that is only punctuation as it is', () => {
    expect(tidyRowLabel('—')).toBe('—')
  })
})
