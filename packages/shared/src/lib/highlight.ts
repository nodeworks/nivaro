/**
 * Token colouring for the request bodies the record's API-provenance popover
 * shows — enough structure to read a GraphQL document or a JSON body at a
 * glance, no dependency. Returns spans; the renderer maps `kind` to colour.
 */
export type HighlightKind =
  | 'keyword'
  | 'name'
  | 'field'
  | 'arg'
  | 'string'
  | 'number'
  | 'bool'
  | 'punct'
  | 'comment'
  | 'text'
export interface HighlightToken {
  kind: HighlightKind
  text: string
}

const GQL_KEYWORDS = new Set([
  'query',
  'mutation',
  'subscription',
  'fragment',
  'on',
  'true',
  'false',
  'null'
])

export function highlightGraphql(src: string): HighlightToken[] {
  const out: HighlightToken[] = []
  const re =
    /(#[^\n]*)|("(?:\\.|[^"\\])*")|(-?\d+(?:\.\d+)?)|([A-Za-z_][A-Za-z0-9_]*)|([{}()[\]:,!$@=|])|(\s+)|(.)/g
  let m: RegExpExecArray | null
  let prevWord: string | null = null
  // biome-ignore lint/suspicious/noAssignInExpressions: tokenizer loop
  while ((m = re.exec(src))) {
    const [, comment, str, num, word, punct, ws, other] = m
    if (comment) out.push({ kind: 'comment', text: comment })
    else if (str) out.push({ kind: 'string', text: str })
    else if (num) out.push({ kind: 'number', text: num })
    else if (word) {
      const rest = src.slice(re.lastIndex)
      if (word === 'true' || word === 'false' || word === 'null')
        out.push({ kind: 'bool', text: word })
      else if (GQL_KEYWORDS.has(word)) out.push({ kind: 'keyword', text: word })
      else if (/^\s*:/.test(rest)) out.push({ kind: 'arg', text: word })
      else if (prevWord && GQL_KEYWORDS.has(prevWord)) out.push({ kind: 'name', text: word })
      else out.push({ kind: 'field', text: word })
      prevWord = word
      continue
    } else if (punct) out.push({ kind: 'punct', text: punct })
    else if (ws) out.push({ kind: 'text', text: ws })
    else if (other) out.push({ kind: 'text', text: other })
    if (!ws) prevWord = null
  }
  return out
}

export function highlightJson(src: string): HighlightToken[] {
  const out: HighlightToken[] = []
  const re =
    /("(?:\\.|[^"\\])*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|(true|false|null)|([{}[\],:])|(\s+)|(.)/g
  let m: RegExpExecArray | null
  // biome-ignore lint/suspicious/noAssignInExpressions: tokenizer loop
  while ((m = re.exec(src))) {
    const [, str, colon, num, lit, punct, ws, other] = m
    if (str) {
      out.push({ kind: colon ? 'arg' : 'string', text: str })
      if (colon) out.push({ kind: 'punct', text: colon })
    } else if (num) out.push({ kind: 'number', text: num })
    else if (lit) out.push({ kind: 'bool', text: lit })
    else if (punct) out.push({ kind: 'punct', text: punct })
    else out.push({ kind: 'text', text: ws ?? other ?? '' })
  }
  return out
}
