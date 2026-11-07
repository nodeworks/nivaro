import { describe, expect, it } from 'vitest'
import { refusedFieldOf } from './save-refusal'

const fields = new Set(['description', 'workflow_lines', 'date_required'])
const sdkErr = (body: Record<string, unknown>) => ({ response: body })

describe('refusedFieldOf', () => {
  it('names the lines field for a refused child row, with a readable message', () => {
    expect(
      refusedFieldOf(
        sdkErr({
          message: 'workflow_lines[0]: Quantity can not be negative — nothing was changed',
          code: 'VALIDATION_RULE_FAILED'
        }),
        fields
      )
    ).toEqual({ field: 'workflow_lines', message: 'Line 1: Quantity can not be negative' })
  })

  it('a saved row is named by id, not position', () => {
    expect(
      refusedFieldOf(sdkErr({ error: 'workflow_lines[A1B2-C3]: Price must be at least 0' }), fields)
    ).toEqual({ field: 'workflow_lines', message: 'Price must be at least 0' })
  })

  it('uses the body field / first violation on the record itself (axios shape too)', () => {
    expect(
      refusedFieldOf(
        {
          response: {
            data: { error: 'Date Required must be on or after today', field: 'date_required' }
          }
        },
        fields
      )
    ).toEqual({ field: 'date_required', message: 'Date Required must be on or after today' })
    expect(
      refusedFieldOf(
        sdkErr({ message: 'x', violations: [{ field: 'description', message: 'Too long' }] }),
        fields
      )
    ).toEqual({ field: 'description', message: 'Too long' })
  })

  it('nothing to point at: a field the form does not have, or no body', () => {
    expect(refusedFieldOf(sdkErr({ error: 'nope', field: 'secret' }), fields)).toBeNull()
    expect(refusedFieldOf(sdkErr({ message: 'other_lines[0]: bad' }), fields)).toBeNull()
    expect(refusedFieldOf(new Error('network'), fields)).toBeNull()
  })
})

describe('refusedFieldOf with the API error body (army6 M4)', () => {
  it('reads the nested reason from `message` when `error` is the status phrase', () => {
    // What POST /items/workflows answers for a line amount past the column's cap.
    expect(
      refusedFieldOf(
        sdkErr({
          statusCode: 400,
          error: 'Bad Request',
          message:
            'workflow_lines[0]: Amount must be smaller than 10,000,000,000 — nothing was changed',
          code: 'VALIDATION_RULE_FAILED',
          violations: [
            {
              field: 'amount',
              rule: 'number_range',
              message: 'Amount must be smaller than 10,000,000,000'
            }
          ]
        }),
        fields
      )
    ).toEqual({
      field: 'workflow_lines',
      message: 'Line 1: Amount must be smaller than 10,000,000,000'
    })
  })

  it('a record-level refusal with the status phrase still names its field', () => {
    expect(
      refusedFieldOf(
        sdkErr({
          error: 'Bad Request',
          message: 'Description is too long',
          field: 'description'
        }),
        fields
      )
    ).toEqual({ field: 'description', message: 'Description is too long' })
  })
})
