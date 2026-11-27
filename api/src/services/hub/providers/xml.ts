/**
 * A small XML reader for provider answers (AWS EC2 / Query APIs / Route 53 / S3, Namecheap). No
 * dependency, no DTDs, no entities beyond the five named ones and numeric references. Moved here
 * from aws/xml.ts by Task 43 (aws/xml.ts re-exports it, with `parseAwsXml` unchanged).
 *
 * Shape (`parseXml`):
 *  - the result is `{ <RootName>: value }`;
 *  - an element with child elements → an object keyed by child name; a name that repeats → an
 *    array of its values (so a one-item list is NOT an array — read lists with `xmlList`);
 *  - an element with only text → that text (entities decoded, not trimmed); an empty one → '';
 *  - comments are dropped; CDATA is text;
 *  - attributes are dropped unless `{ attributes: true }`: then an element that has any becomes an
 *    object whose `@name` keys hold them (decoded), its child elements beside them and its text,
 *    when there is any besides whitespace, under `#text`. Read one with `xmlAttr`.
 *
 * Lists: EC2 wraps them in `<item>`, Query APIs in `<member>`, Route 53 / S3 / Namecheap repeat a
 * named element — `xmlList(container, 'item')` reads any of them as an array.
 */

export type XmlValue = string | XmlObject | XmlValue[]
export interface XmlObject {
  [name: string]: XmlValue
}

export class XmlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AwsXmlError'
  }
}

export interface XmlOptions {
  /** Keep attributes as `@name` keys (Namecheap answers carry their data in attributes). */
  attributes?: boolean
}

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
// Names that would reach Object.prototype through a plain object key.
const UNSAFE = new Set(['__proto__', 'constructor', 'prototype'])
/** Attribute and child names are capped; an answer with more is not a provider answer. */
const MAX_ATTRS = 200

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, ref: string) => {
    if (ref[0] === '#') {
      const code =
        ref[1] === 'x' ? Number.parseInt(ref.slice(2), 16) : Number.parseInt(ref.slice(1), 10)
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m
    }
    return NAMED[ref] ?? m
  })
}

/** Local name (drops a namespace prefix). */
const local = (name: string) => name.slice(name.indexOf(':') + 1)

interface Frame {
  name: string
  attrs: Array<[string, string]>
  children: Array<[string, XmlValue]>
  text: string
}

function frameValue(f: Frame): XmlValue {
  if (f.children.length === 0 && f.attrs.length === 0) return f.text
  const obj: XmlObject = {}
  for (const [name, v] of f.attrs) {
    const key = `@${name}`
    if (UNSAFE.has(name) || obj[key] !== undefined) continue
    obj[key] = v
  }
  for (const [name, v] of f.children) {
    if (UNSAFE.has(name)) continue
    const have = obj[name]
    // A child's own value is never an array, so an array here is always a repeated name.
    if (have === undefined) obj[name] = v
    else if (Array.isArray(have)) have.push(v)
    else obj[name] = [have, v]
  }
  if (f.attrs.length && f.text.trim()) obj['#text'] = f.text
  return obj
}

/** The index of the `>` that closes a tag starting at `from`, skipping quoted attribute values. */
function tagEnd(src: string, from: number): number {
  let quote = ''
  for (let i = from; i < src.length; i++) {
    const c = src[i]
    if (quote) {
      if (c === quote) quote = ''
    } else if (c === '"' || c === "'") quote = c
    else if (c === '>') return i
  }
  return -1
}

const ATTR_RE = /([A-Za-z_][\w.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/g

function attributesOf(rest: string): Array<[string, string]> {
  const out: Array<[string, string]> = []
  ATTR_RE.lastIndex = 0
  for (let m = ATTR_RE.exec(rest); m; m = ATTR_RE.exec(rest)) {
    const raw = m[1]
    // xmlns declarations are not data.
    if (raw === 'xmlns' || raw.startsWith('xmlns:')) continue
    out.push([local(raw), decodeEntities(m[3] ?? m[4] ?? '')])
    if (out.length > MAX_ATTRS) throw new XmlError('Too many attributes.')
  }
  return out
}

/** Parses an XML answer. Throws XmlError on text that is not well-formed. */
export function parseXml(text: string, opts: XmlOptions = {}): XmlObject {
  const keepAttrs = opts.attributes === true
  const src = String(text ?? '')
  const stack: Frame[] = []
  let root: [string, XmlValue] | null = null
  let i = 0
  const n = src.length
  const close = (name: string, v: XmlValue) => {
    if (stack.length) stack[stack.length - 1].children.push([name, v])
    else if (root) throw new XmlError('More than one root element.')
    else root = [name, v]
  }
  while (i < n) {
    const lt = src.indexOf('<', i)
    const chunk = lt === -1 ? src.slice(i) : src.slice(i, lt)
    if (chunk) {
      if (stack.length) stack[stack.length - 1].text += decodeEntities(chunk)
      else if (chunk.trim()) throw new XmlError('Text outside the root element.')
    }
    if (lt === -1) break
    if (src.startsWith('<?', lt)) {
      const end = src.indexOf('?>', lt + 2)
      if (end === -1) throw new XmlError('Unclosed processing instruction.')
      i = end + 2
      continue
    }
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4)
      if (end === -1) throw new XmlError('Unclosed comment.')
      i = end + 3
      continue
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9)
      if (end === -1) throw new XmlError('Unclosed CDATA section.')
      if (!stack.length) throw new XmlError('CDATA outside the root element.')
      stack[stack.length - 1].text += src.slice(lt + 9, end)
      i = end + 3
      continue
    }
    if (src.startsWith('<!', lt)) throw new XmlError('Declarations are not supported.')
    const gt = tagEnd(src, lt + 1)
    if (gt === -1) throw new XmlError('Unclosed tag.')
    const tag = src.slice(lt + 1, gt)
    i = gt + 1
    if (tag.startsWith('/')) {
      const name = local(tag.slice(1).trim())
      const f = stack.pop()
      if (!f || f.name !== name) throw new XmlError(`Unexpected closing tag ${name}.`)
      close(name, frameValue(f))
      continue
    }
    const selfClosing = tag.endsWith('/')
    const m = /^([A-Za-z_][\w.:-]*)/.exec(tag)
    if (!m) throw new XmlError('Bad tag name.')
    const name = local(m[1])
    const attrs = keepAttrs
      ? attributesOf(tag.slice(m[1].length, selfClosing ? -1 : undefined))
      : []
    if (selfClosing) {
      close(name, frameValue({ name, attrs, children: [], text: '' }))
      continue
    }
    if (!stack.length && root) throw new XmlError('More than one root element.')
    stack.push({ name, attrs, children: [], text: '' })
  }
  if (stack.length) throw new XmlError(`Unclosed element ${stack[stack.length - 1].name}.`)
  if (!root) throw new XmlError('No root element.')
  const out: XmlObject = {}
  const [rootName, rootValue] = root as [string, XmlValue]
  if (!UNSAFE.has(rootName)) out[rootName] = rootValue
  return out
}

/**
 * A list as an array. `itemName` = the wrapper element ('item', 'member', 'ResourceRecordSet');
 * without it `v` itself is the (possibly single) value. Missing / '' → [].
 */
export function xmlList(v: XmlValue | undefined, itemName?: string): XmlValue[] {
  let x: XmlValue | undefined = v
  if (itemName !== undefined) {
    if (!x || typeof x !== 'object' || Array.isArray(x)) return []
    x = (x as XmlObject)[itemName]
  }
  if (x === undefined || x === '') return []
  return Array.isArray(x) ? x : [x]
}

/** The text of a value ('' when it is missing or not text; an element with attributes → its #text). */
export function xmlText(v: XmlValue | undefined): string {
  if (typeof v === 'string') return v
  if (v && typeof v === 'object' && !Array.isArray(v) && typeof v['#text'] === 'string')
    return v['#text'] as string
  return ''
}

/** A child of an object value (undefined when `v` is not an object). */
export function xmlChild(v: XmlValue | undefined, name: string): XmlValue | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as XmlObject)[name] : undefined
}

/** One attribute of an element parsed with `{ attributes: true }` ('' when absent). */
export function xmlAttr(v: XmlValue | undefined, name: string): string {
  const a = xmlChild(v, `@${name}`)
  return typeof a === 'string' ? a : ''
}
