export type ContentNode =
  | { type: 'h1'; id: string; text: string }
  | { type: 'h2'; id: string; text: string }
  | { type: 'h3'; id?: string; text: string }
  | { type: 'p'; text: string }
  | { type: 'pre'; code: string }
  | { type: 'table'; head: string[]; rows: string[][] }
  | { type: 'note'; text: string }
  | { type: 'warn'; text: string }
  | { type: 'ul'; items: string[] }
  | { type: 'divider' }

export interface DocSection {
  id: string
  label: string
  content: ContentNode[]
}

/**
 * Inline text format used in p / note / warn / ul items:
 *   `code`   → inline code element
 *   plain text otherwise
 */
export type InlineText = string
