import { describe, expect, it } from 'vitest'
import { detectDefaultBodyRejection } from '../../../services/workflow-actions.js'

describe('detectDefaultBodyRejection', () => {
  it('reads an error status string and returns the partner message', () => {
    expect(
      detectDefaultBodyRejection({ api_status: 'Bad Request', message: 'Invalid workflow_id.' })
    ).toBe('Invalid workflow_id.')
    expect(detectDefaultBodyRejection({ status: 'ERROR', statusMessage: 'Duplicate line' })).toBe(
      'Duplicate line'
    )
  })

  it('reads boolean false acknowledgements', () => {
    expect(detectDefaultBodyRejection({ success: false })).toBe('Partner responded with success: false')
    expect(detectDefaultBodyRejection({ status: false, error: 'nope' })).toBe('nope')
  })

  it('leaves acceptances and unknown shapes alone', () => {
    expect(detectDefaultBodyRejection({ status: true, message: 'ok' })).toBeNull()
    expect(detectDefaultBodyRejection({ api_status: 'OK' })).toBeNull()
    expect(detectDefaultBodyRejection({ status: 'SUCCESS', statusMessage: '' })).toBeNull()
    expect(detectDefaultBodyRejection('plain text')).toBeNull()
    expect(detectDefaultBodyRejection([{ status: 'ERROR' }])).toBeNull()
    expect(detectDefaultBodyRejection(null)).toBeNull()
  })
})
