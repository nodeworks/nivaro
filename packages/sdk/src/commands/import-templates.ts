import { cmd, type Command } from '../command.js'

export interface ImportTemplateSummary {
  id: string
  name: string
  collection: string
  mode: 'prefill' | 'direct' | 'both'
  file_types: string[]
  is_active: boolean
}

export interface ImportParseResponse {
  values: Record<string, unknown>
  lines: {
    values: Record<string, unknown>
    nested?: { field: string; rows: Record<string, unknown>[] }
    stubs?: Record<string, { is_new: true; name: string }>
  }[]
  issues: { severity: 'warn' | 'error'; rule: string; row?: number; column?: string; message: string }[]
  file_id: string | null
  line_target_field: string | null
  m2m: Record<string, Array<string | number>>
}

export const listImportTemplates = (collection: string): Command<{ data: ImportTemplateSummary[] }> =>
  cmd('GET', '/import-templates', { collection })

export const executeImportTemplate = (
  id: string,
  payload: {
    values: Record<string, unknown>
    lines: ImportParseResponse['lines']
    issues: ImportParseResponse['issues']
    file_id?: string | null
    m2m?: Record<string, Array<string | number>>
  }
): Command<{ data: { id: string; line_ids: string[] } }> =>
  cmd('POST', `/import-templates/${id}/execute`, undefined, payload)
