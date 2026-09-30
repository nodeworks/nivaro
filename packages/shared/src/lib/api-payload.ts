/** The recorded request body as people read it: a GraphQL envelope becomes
 *  the query text itself (real line breaks, common indentation removed) with
 *  its variables as their own JSON block; anything else is pretty JSON. */
export function formatApiPayload(body: unknown): {
  sections: Array<{ kind: 'query' | 'variables' | 'json' | 'text'; title: string; text: string }>
} | null {
  if (body == null || body === '') return null
  if (typeof body === 'string') {
    try {
      return formatApiPayload(JSON.parse(body))
    } catch {
      return { sections: [{ kind: 'text', title: 'Body', text: body }] }
    }
  }
  const obj = body as Record<string, unknown>
  if (typeof obj.query === 'string') {
    const sections: Array<{
      kind: 'query' | 'variables' | 'json' | 'text'
      title: string
      text: string
    }> = [
      {
        kind: 'query',
        title: obj.operationName ? `Query · ${String(obj.operationName)}` : 'Query',
        text: dedent(obj.query)
      }
    ]
    if (obj.variables != null && Object.keys(obj.variables as object).length > 0) {
      sections.push({
        kind: 'variables',
        title: 'Variables',
        text: JSON.stringify(obj.variables, null, 2)
      })
    }
    return { sections }
  }
  return { sections: [{ kind: 'json', title: 'Body', text: JSON.stringify(obj, null, 2) }] }
}

function dedent(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  while (lines.length && lines[0].trim() === '') lines.shift()
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop()
  const indents = lines.filter((l) => l.trim()).map((l) => l.match(/^\s*/)?.[0].length ?? 0)
  const min = indents.length ? Math.min(...indents) : 0
  return lines.map((l) => l.slice(Math.min(min, l.match(/^\s*/)?.[0].length ?? 0))).join('\n')
}
