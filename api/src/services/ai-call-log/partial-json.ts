/**
 * Read a JSON text the call log cut at its size cap (`…` appended mid-value).
 * A plain JSON.parse fails on every such row, so the readable transcript would
 * lose the person's question exactly on the long calls. This closes whatever
 * was open — the string, then the arrays/objects — after dropping a dangling
 * key, colon or comma, and parses that. Returns `{ value, cut }`; `value` is
 * null when nothing usable survives. Pure, no dependencies.
 */
export function parsePartialJson(text: string | null | undefined): {
  value: unknown
  cut: boolean
} {
  if (text == null) return { value: null, cut: false }
  try {
    return { value: JSON.parse(text), cut: false }
  } catch {
    // fall through to the repair below
  }
  let s = text.endsWith('…') ? text.slice(0, -1) : text
  const t = s.trimStart()
  if (!t.startsWith('{') && !t.startsWith('[')) return { value: null, cut: true }
  // Several passes: each one closes what is open; if the cut fell somewhere a
  // close cannot fix (inside a number, a literal, after a key), drop the tail
  // back to the last structural character and try again.
  for (let attempt = 0; attempt < 6 && s.length > 0; attempt++) {
    const closed = closeOpen(s)
    if (closed != null) {
      try {
        return { value: JSON.parse(closed), cut: true }
      } catch {
        // trim and retry
      }
    }
    const back = Math.max(s.lastIndexOf(','), s.lastIndexOf('{'), s.lastIndexOf('['))
    if (back <= 0) break
    s = s[back] === ',' ? s.slice(0, back) : s.slice(0, back + 1)
  }
  return { value: null, cut: true }
}

function closeOpen(src: string): string | null {
  const stack: string[] = []
  let inStr = false
  let esc = false
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '{' || c === '[') stack.push(c)
    else if (c === '}' || c === ']') stack.pop()
  }
  let out = src
  if (inStr) {
    // A cut escape (`\` or a partial `\u12`) cannot be closed as it stands.
    out = out.replace(/\\u[0-9a-fA-F]{0,3}$/, '').replace(/\\$/, '')
    out += '"'
  }
  // A dangling `,`, `:` or `"key":` / `"key"` inside an object cannot stand.
  out = out.replace(/\s+$/, '')
  for (;;) {
    const before = out
    out = out.replace(/,\s*$/, '')
    if (stack[stack.length - 1] === '{') {
      out = out.replace(/(?:[{,]\s*)"(?:[^"\\]|\\.)*"\s*:?\s*$/, (m) =>
        m.startsWith('{') ? '{' : ''
      )
    }
    out = out.replace(/:\s*$/, '')
    if (out === before) break
  }
  for (let i = stack.length - 1; i >= 0; i--) out += stack[i] === '{' ? '}' : ']'
  return out
}
