/**
 * A small XML reader for AWS answers (EC2, Query APIs like RDS / ELBv2 / STS / IAM, Route 53,
 * S3). No dependency, no DTDs, no entities beyond the five named ones and numeric references.
 *
 * Shape (`parseAwsXml`):
 *  - the result is `{ <RootName>: value }`;
 *  - an element with child elements → an object keyed by child name; a name that repeats → an
 *    array of its values (so a one-item list is NOT an array — read lists with `xmlList`);
 *  - an element with only text → that text (entities decoded, not trimmed); an empty one → '';
 *  - attributes (AWS sends only xmlns) and comments are dropped; CDATA is text.
 *
 * Lists: EC2 wraps them in `<item>`, Query APIs in `<member>`, Route 53 / S3 repeat a named
 * element — `xmlList(container, 'item')` reads any of them as an array.
 */

export type XmlValue = string | XmlObject | XmlValue[]
export interface XmlObject {
  [name: string]: XmlValue
}

export class AwsXmlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AwsXmlError'
  }
}

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
// Names that would reach Object.prototype through a plain object key.
const UNSAFE = new Set(['__proto__', 'constructor', 'prototype'])

function decodeEntities(s: string): string {
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
  children: Array<[string, XmlValue]>
  text: string
}

function frameValue(f: Frame): XmlValue {
  if (f.children.length === 0) return f.text
  const obj: XmlObject = {}
  for (const [name, v] of f.children) {
    if (UNSAFE.has(name)) continue
    const have = obj[name]
    // A child's own value is never an array, so an array here is always a repeated name.
    if (have === undefined) obj[name] = v
    else if (Array.isArray(have)) have.push(v)
    else obj[name] = [have, v]
  }
  return obj
}

/** Parses an AWS XML answer. Throws AwsXmlError on text that is not well-formed. */
export function parseAwsXml(text: string): XmlObject {
  const src = String(text ?? '')
  const stack: Frame[] = []
  let root: [string, XmlValue] | null = null
  let i = 0
  const n = src.length
  while (i < n) {
    const lt = src.indexOf('<', i)
    const chunk = lt === -1 ? src.slice(i) : src.slice(i, lt)
    if (chunk) {
      if (stack.length) stack[stack.length - 1].text += decodeEntities(chunk)
      else if (chunk.trim()) throw new AwsXmlError('Text outside the root element.')
    }
    if (lt === -1) break
    if (src.startsWith('<?', lt)) {
      const end = src.indexOf('?>', lt + 2)
      if (end === -1) throw new AwsXmlError('Unclosed processing instruction.')
      i = end + 2
      continue
    }
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4)
      if (end === -1) throw new AwsXmlError('Unclosed comment.')
      i = end + 3
      continue
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9)
      if (end === -1) throw new AwsXmlError('Unclosed CDATA section.')
      if (!stack.length) throw new AwsXmlError('CDATA outside the root element.')
      stack[stack.length - 1].text += src.slice(lt + 9, end)
      i = end + 3
      continue
    }
    if (src.startsWith('<!', lt)) throw new AwsXmlError('Declarations are not supported.')
    const gt = src.indexOf('>', lt + 1)
    if (gt === -1) throw new AwsXmlError('Unclosed tag.')
    const tag = src.slice(lt + 1, gt)
    i = gt + 1
    if (tag.startsWith('/')) {
      const name = local(tag.slice(1).trim())
      const f = stack.pop()
      if (!f || f.name !== name) throw new AwsXmlError(`Unexpected closing tag ${name}.`)
      const v = frameValue(f)
      if (stack.length) stack[stack.length - 1].children.push([name, v])
      else if (root) throw new AwsXmlError('More than one root element.')
      else root = [name, v]
      continue
    }
    const selfClosing = tag.endsWith('/')
    const m = /^([A-Za-z_][\w.:-]*)/.exec(tag)
    if (!m) throw new AwsXmlError('Bad tag name.')
    const name = local(m[1])
    if (selfClosing) {
      if (stack.length) stack[stack.length - 1].children.push([name, ''])
      else if (root) throw new AwsXmlError('More than one root element.')
      else root = [name, '']
      continue
    }
    if (!stack.length && root) throw new AwsXmlError('More than one root element.')
    stack.push({ name, children: [], text: '' })
  }
  if (stack.length) throw new AwsXmlError(`Unclosed element ${stack[stack.length - 1].name}.`)
  if (!root) throw new AwsXmlError('No root element.')
  const out: XmlObject = {}
  if (!UNSAFE.has(root[0])) out[root[0]] = root[1]
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

/** The text of a value ('' when it is missing or not text). */
export function xmlText(v: XmlValue | undefined): string {
  return typeof v === 'string' ? v : ''
}

/** A child of an object value (undefined when `v` is not an object). */
export function xmlChild(v: XmlValue | undefined, name: string): XmlValue | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as XmlObject)[name] : undefined
}

/**
 * The error an AWS XML answer carries, any of the three shapes: EC2
 * `<Response><Errors><Error>`, Query `<ErrorResponse><Error>`, S3 / Route 53 `<Error>` (Route 53
 * also `<ErrorResponse><Error>`). null when it is not an error answer.
 */
export function awsXmlError(doc: XmlObject): { code: string; message: string } | null {
  const pick = (e: XmlValue | undefined) => {
    const first = xmlList(e)[0]
    const code = xmlText(xmlChild(first, 'Code'))
    return code ? { code, message: xmlText(xmlChild(first, 'Message')) } : null
  }
  if (doc.Error !== undefined) return pick(doc.Error)
  if (doc.ErrorResponse !== undefined) return pick(xmlChild(doc.ErrorResponse, 'Error'))
  if (doc.Response !== undefined) return pick(xmlChild(xmlChild(doc.Response, 'Errors'), 'Error'))
  return null
}
