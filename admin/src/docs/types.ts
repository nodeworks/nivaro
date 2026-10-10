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
  /**
   * A help video (#1528c), shown as a card that opens the player. Either a
   * video by `id`, or by `key`: the video tagged to that page key (the first
   * answer of GET /help-videos/for?page=<key>), so a section can say "the
   * video for page X" without knowing an id. Nothing renders for a reader
   * who may not watch it, or when there is none.
   */
  | {
      type: 'video'
      id?: string
      key?: string
      /** With `key`: how the page is listed under "Where it shows". */
      label?: string
      t_ms?: number
      caption?: string
    }

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
