/**
 * The XML reader for AWS answers. Task 43 moved the reader itself to `providers/xml.ts` (Namecheap
 * reads XML too); this file keeps the AWS names: `parseAwsXml` (attributes dropped, as before),
 * `AwsXmlError` and `awsXmlError`.
 */

import {
  parseXml,
  XmlError,
  type XmlObject,
  type XmlValue,
  xmlChild,
  xmlList,
  xmlText
} from '../xml.js'

export { type XmlObject, type XmlValue, xmlChild, xmlList, xmlText } from '../xml.js'

/** Thrown on text that is not well-formed XML (the shared reader's error). */
export const AwsXmlError = XmlError
export type AwsXmlError = XmlError

/** Parses an AWS XML answer (attributes dropped: AWS sends only xmlns). */
export function parseAwsXml(text: string): XmlObject {
  return parseXml(text)
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
