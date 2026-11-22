/**
 * A refusal the agent answers with: an HTTP status, a stable code and a short
 * fixed sentence. Never an Engine body, a secret value or a raw request text.
 */
export type FieldRefusal = { field: string; code: string }

export class StackError extends Error {
  readonly status: number
  readonly code: string
  readonly fields?: FieldRefusal[]
  constructor(status: number, code: string, message: string, fields?: FieldRefusal[]) {
    super(message)
    this.name = 'StackError'
    this.status = status
    this.code = code
    if (fields?.length) this.fields = fields
  }
}

/** The Engine answered a write or read with something other than success. */
export function engineFailed(): StackError {
  return new StackError(502, 'ENGINE_ERROR', 'The Docker Engine refused the request')
}
