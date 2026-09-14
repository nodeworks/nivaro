/** Strip scripts, embeds and event handlers from stored rich text before it is
 *  rendered as HTML. Keeps formatting tags; drops anything executable. */
export function sanitizeHtml(html: string): string {
  if (typeof DOMParser === 'undefined') return ''
  const doc = new DOMParser().parseFromString(html, 'text/html')
  for (const el of doc.querySelectorAll('script, style, iframe, object, embed, form, link, meta')) {
    el.remove()
  }
  for (const el of doc.body.querySelectorAll('*')) {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase()
      if (name.startsWith('on')) el.removeAttribute(attr.name)
      else if (
        (name === 'href' || name === 'src' || name === 'xlink:href') &&
        /^\s*javascript:/i.test(attr.value)
      )
        el.removeAttribute(attr.name)
    }
  }
  return doc.body.innerHTML
}
