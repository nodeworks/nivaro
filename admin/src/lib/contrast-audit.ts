/**
 * Dark-mode contrast auditor (#127): dev tool that scans the RENDERED page for
 * text under WCAG contrast (4.5:1 body, 3:1 large/bold) and lists offenders
 * with selectors. Launched from the command palette ("Audit contrast");
 * pre-empts the recurring light-on-light regressions.
 */

interface Offender {
  el: HTMLElement
  selector: string
  sample: string
  fg: string
  bg: string
  ratio: number
  needed: number
}

function parseColor(c: string): [number, number, number, number] | null {
  const m = c.match(/rgba?\(([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)(?:[,/ ]+([\d.]+))?\)/)
  if (!m) return null
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])]
}

function luminance([r, g, b]: [number, number, number]): number {
  const f = (v: number) => {
    const s = v / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}

function contrast(a: [number, number, number], b: [number, number, number]): number {
  const l1 = luminance(a)
  const l2 = luminance(b)
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
}

function blend(
  top: [number, number, number, number],
  under: [number, number, number]
): [number, number, number] {
  const a = top[3]
  return [
    top[0] * a + under[0] * (1 - a),
    top[1] * a + under[1] * (1 - a),
    top[2] * a + under[2] * (1 - a)
  ]
}

function effectiveBg(el: HTMLElement): [number, number, number] {
  const layers: [number, number, number, number][] = []
  let node: HTMLElement | null = el
  while (node) {
    const c = parseColor(getComputedStyle(node).backgroundColor)
    if (c && c[3] > 0) {
      layers.push(c)
      if (c[3] >= 1) break
    }
    node = node.parentElement
  }
  const dark = document.documentElement.classList.contains('dark')
  let acc: [number, number, number] = dark ? [15, 18, 26] : [255, 255, 255]
  for (let i = layers.length - 1; i >= 0; i--) acc = blend(layers[i], acc)
  return acc
}

function cssPath(el: HTMLElement): string {
  const parts: string[] = []
  let node: HTMLElement | null = el
  while (node && node !== document.body && parts.length < 4) {
    let part = node.tagName.toLowerCase()
    if (node.id) {
      parts.unshift(`#${node.id}`)
      break
    }
    const cls = [...node.classList].slice(0, 2).join('.')
    if (cls) part += `.${cls}`
    parts.unshift(part)
    node = node.parentElement
  }
  return parts.join(' > ')
}

export function runContrastAudit(): Offender[] {
  const offenders: Offender[] = []
  const els = document.querySelectorAll<HTMLElement>('body *')
  let scanned = 0
  for (const el of els) {
    if (scanned > 4000 || offenders.length >= 80) break
    // Only elements with DIRECT text content
    const text = [...el.childNodes]
      .filter((n) => n.nodeType === Node.TEXT_NODE)
      .map((n) => n.textContent?.trim() ?? '')
      .join(' ')
      .trim()
    if (!text) continue
    const rect = el.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) continue
    const style = getComputedStyle(el)
    if (style.visibility === 'hidden' || Number(style.opacity) < 0.1) continue
    scanned++
    const fg = parseColor(style.color)
    if (!fg || fg[3] < 0.1) continue
    const bg = effectiveBg(el)
    const fgFlat = blend(fg, bg)
    const ratio = contrast(fgFlat, bg)
    const px = Number.parseFloat(style.fontSize)
    const bold = Number(style.fontWeight) >= 700
    const needed = px >= 24 || (px >= 18.66 && bold) ? 3 : 4.5
    if (ratio < needed - 0.05) {
      offenders.push({
        el,
        selector: cssPath(el),
        sample: text.slice(0, 60),
        fg: style.color,
        bg: `rgb(${bg.map(Math.round).join(', ')})`,
        ratio: Math.round(ratio * 100) / 100,
        needed
      })
    }
  }
  return offenders.sort((a, b) => a.ratio - b.ratio)
}

export function showContrastAudit(): void {
  document.getElementById('nvr-contrast-audit')?.remove()
  const offenders = runContrastAudit()
  const panel = document.createElement('div')
  panel.id = 'nvr-contrast-audit'
  panel.style.cssText =
    'position:fixed;top:16px;right:16px;z-index:200;width:360px;max-height:70vh;overflow:auto;' +
    'background:#0f172a;color:#e2e8f0;border-radius:10px;box-shadow:0 12px 40px rgba(0,0,0,.45);' +
    'font:12px/1.45 ui-sans-serif,system-ui;padding:12px 14px'
  const head = document.createElement('div')
  head.style.cssText =
    'display:flex;align-items:center;justify-content:space-between;margin-bottom:8px'
  head.innerHTML = `<b style="font-size:13px">Contrast audit — ${offenders.length} finding${offenders.length === 1 ? '' : 's'}</b>`
  const close = document.createElement('button')
  close.textContent = '✕'
  close.style.cssText = 'background:none;border:0;color:#94a3b8;cursor:pointer;font-size:14px'
  close.onclick = () => {
    panel.remove()
    for (const o of offenders) o.el.style.outline = ''
  }
  head.appendChild(close)
  panel.appendChild(head)
  if (offenders.length === 0) {
    const p = document.createElement('p')
    p.textContent = 'Every scanned text node passes WCAG contrast on this page.'
    panel.appendChild(p)
  }
  for (const o of offenders.slice(0, 50)) {
    o.el.style.outline = '2px dashed #f59e0b'
    const row = document.createElement('button')
    row.style.cssText =
      'display:block;width:100%;text-align:left;background:rgba(255,255,255,.04);border:0;' +
      'border-radius:6px;padding:6px 8px;margin-bottom:6px;color:inherit;cursor:pointer'
    row.innerHTML =
      `<span style="color:#f59e0b;font-weight:600">${o.ratio}:1</span>` +
      ` <span style="color:#64748b">(needs ${o.needed}:1)</span>` +
      `<div style="color:#cbd5e1;margin-top:2px">“${o.sample.replace(/</g, '&lt;')}”</div>` +
      `<div style="color:#64748b;font-family:ui-monospace,monospace;font-size:10.5px;margin-top:2px">${o.selector.replace(/</g, '&lt;')}</div>`
    row.onclick = () => {
      o.el.scrollIntoView({ block: 'center', behavior: 'smooth' })
      o.el.style.outline = '3px solid #ef4444'
      setTimeout(() => {
        o.el.style.outline = '2px dashed #f59e0b'
      }, 1500)
    }
    panel.appendChild(row)
  }
  document.body.appendChild(panel)
}
