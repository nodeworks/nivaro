/**
 * Schema change proposals (#3209): draft a field or collection change for an administrator to
 * review. Nothing changes until an administrator applies it on the Data Model page.
 */
import { type Command, cmd } from '../command.js'

export type SchemaFieldType =
  | 'string'
  | 'text'
  | 'integer'
  | 'bigInteger'
  | 'boolean'
  | 'decimal'
  | 'float'
  | 'date'
  | 'datetime'
  | 'uuid'

export interface SchemaChoice {
  value: string | number
  text?: string
}

export interface ProposedField {
  field: string
  type?: SchemaFieldType
  label?: string
  note?: string
  choices?: SchemaChoice[]
  required?: boolean
  max_length?: number
}

export type ProposedSchemaChange =
  | ({ kind: 'add_field'; collection: string } & ProposedField)
  | {
      kind: 'update_field'
      collection: string
      field: string
      label?: string
      note?: string
      choices?: SchemaChoice[]
      required?: boolean
    }
  | {
      kind: 'add_collection'
      collection: string
      display_name?: string
      singular?: string
      plural?: string
      icon?: string
      note?: string
      fields?: ProposedField[]
    }

/**
 * Store a schema proposal (POST /schema-proposals). Answers the plain-words reading of each
 * change; changes that would not hold (a field that exists, an unknown collection) are refused
 * with 400 and `change_index`.
 */
export function proposeSchemaChange(body: {
  changes: ProposedSchemaChange[]
  note?: string
}): Command<{ data: { id: string; status: 'proposed'; changes: string[]; note: string } }> {
  return cmd('POST', '/schema-proposals', undefined, body)
}

export interface SchemaProposal {
  id: string
  status: 'proposed' | 'applied' | 'rejected' | 'expired'
  collections: string[]
  changes: ProposedSchemaChange[]
  sentences: string[]
  note: string | null
  proposed_by: { id: string; name: string }
  via: string
  client: string | null
  created_at: string
  resolved_at: string | null
  result: Record<string, unknown> | null
}

/** One proposal and its outcome (the proposer or an administrator). */
export function readSchemaProposal(id: string): Command<{ data: SchemaProposal }> {
  return cmd('GET', `/schema-proposals/${id}`)
}
