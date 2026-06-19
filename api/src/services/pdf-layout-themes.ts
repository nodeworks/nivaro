// api/src/services/pdf-layout-themes.ts

export interface PdfLayoutData {
  coverTitle: string
  coverSubtitle: string
  logoUrl: string | null
  collectionLabel: string
  generatedAt: string
  generatedBy: string
  coverEnabled: boolean
  sections: Array<{
    label: string
    fields: Array<{ label: string; value: string }>
  }>
}

export function escHtml(str: string): string {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ─── Meridian (Classic) ───────────────────────────────────────────────────────
// Deep navy cover · amber accent · Georgia serif · ruled 2-col field table
// Authoritative, board-room, annual-report quality

export function classicTheme(data: PdfLayoutData): string {
  const totalFields = data.sections.reduce((n, s) => n + s.fields.length, 0)
  const initial = data.collectionLabel.charAt(0).toUpperCase()

  const coverHtml = data.coverEnabled ? `
<div class="cover">
  <div class="cover-header">
    ${data.logoUrl
      ? `<img class="cover-logo" src="${escHtml(data.logoUrl)}" alt="">`
      : `<div class="cover-badge"><span>${escHtml(initial)}</span></div>`
    }
    <span class="cover-collection-label">${escHtml(data.collectionLabel)}</span>
  </div>

  <div class="cover-body">
    <h1 class="cover-title">${escHtml(data.coverTitle)}</h1>
    ${data.coverSubtitle ? `<p class="cover-subtitle">${escHtml(data.coverSubtitle)}</p>` : ''}
    <div class="cover-rule"></div>
  </div>

  <div class="cover-meta">
    <div class="meta-item">
      <span class="meta-label">Generated</span>
      <span class="meta-value">${escHtml(data.generatedAt)}</span>
    </div>
    <div class="meta-divider"></div>
    <div class="meta-item">
      <span class="meta-label">Prepared by</span>
      <span class="meta-value">${escHtml(data.generatedBy)}</span>
    </div>
    <div class="meta-divider"></div>
    <div class="meta-item">
      <span class="meta-label">Fields</span>
      <span class="meta-value">${totalFields}</span>
    </div>
  </div>
</div>` : ''

  const sectionsHtml = data.sections.map(s => `
<div class="section">
  <div class="section-header">
    <h2 class="section-title">${escHtml(s.label)}</h2>
    <div class="section-rule"></div>
  </div>
  <table class="fields">
    <tbody>
      ${s.fields.map(f => `
      <tr class="field-row">
        <td class="field-label">${escHtml(f.label)}</td>
        <td class="field-value">${escHtml(f.value)}</td>
      </tr>`).join('')}
    </tbody>
  </table>
</div>`).join('')

  const contentHeaderHtml = `
<div class="content-header">
  <span class="ch-collection">${escHtml(data.collectionLabel)}</span>
  <span class="ch-meta">${escHtml(data.coverTitle)} &middot; ${escHtml(data.generatedAt)}</span>
</div>`

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  @page { size: A4; margin: 0; }
  html, body {
    font-family: Helvetica, Arial, sans-serif;
    font-size: 11pt;
    color: #1a1f36;
    background: #fff;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }

  /* ── Cover ── */
  .cover {
    width: 210mm;
    height: 297mm;
    background: #0c1829;
    display: flex;
    flex-direction: column;
    padding: 28mm 22mm 18mm;
    page-break-after: always;
    overflow: hidden;
    position: relative;
  }
  .cover::before {
    content: '';
    position: absolute;
    top: -140px; right: -140px;
    width: 480px; height: 480px;
    border-radius: 50%;
    border: 1px solid rgba(200,162,92,0.13);
    pointer-events: none;
  }
  .cover::after {
    content: '';
    position: absolute;
    top: -50px; right: -50px;
    width: 300px; height: 300px;
    border-radius: 50%;
    border: 1px solid rgba(200,162,92,0.1);
    pointer-events: none;
  }
  .cover-header {
    display: flex;
    align-items: center;
    gap: 14px;
    margin-bottom: auto;
  }
  .cover-badge {
    width: 46px; height: 46px;
    border-radius: 10px;
    border: 1.5px solid rgba(200,162,92,0.55);
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
  }
  .cover-badge span {
    font-family: Georgia, 'Times New Roman', serif;
    font-size: 22px; font-weight: 400; color: #c8a25c;
  }
  .cover-logo {
    height: 38px; width: auto; object-fit: contain;
    filter: brightness(0) invert(1); flex-shrink: 0;
  }
  .cover-collection-label {
    font-size: 8.5pt; font-weight: 600;
    letter-spacing: 0.2em; text-transform: uppercase; color: #c8a25c;
  }
  .cover-body { margin-bottom: 20mm; }
  .cover-title {
    font-family: Georgia, 'Times New Roman', serif;
    font-size: 46pt; font-weight: 400; line-height: 1.08;
    letter-spacing: -0.025em; color: #ffffff; margin-bottom: 18px; max-width: 500px;
  }
  .cover-subtitle {
    font-size: 13pt; font-weight: 300;
    color: rgba(255,255,255,0.5); margin-bottom: 28px; line-height: 1.4;
  }
  .cover-rule { width: 52px; height: 3px; background: #c8a25c; border-radius: 2px; }
  .cover-meta {
    display: flex; align-items: flex-start;
    border-top: 1px solid rgba(255,255,255,0.1); padding-top: 18px;
  }
  .meta-item {
    flex: 1; display: flex; flex-direction: column; gap: 4px; padding: 0 18px;
  }
  .meta-item:first-child { padding-left: 0; }
  .meta-item:last-child { padding-right: 0; }
  .meta-divider { width: 1px; background: rgba(255,255,255,0.1); align-self: stretch; }
  .meta-label {
    font-size: 7pt; font-weight: 600;
    letter-spacing: 0.12em; text-transform: uppercase; color: rgba(255,255,255,0.3);
  }
  .meta-value { font-size: 9pt; color: rgba(255,255,255,0.72); font-weight: 400; line-height: 1.3; }

  /* ── Content header (non-repeating, appears once at top of content) ── */
  .content-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 0 0 10px; margin-bottom: 12mm;
    border-bottom: 1px solid #e5e7eb;
  }
  .ch-collection {
    font-size: 7.5pt; font-weight: 700;
    letter-spacing: 0.14em; text-transform: uppercase; color: #c8a25c;
  }
  .ch-meta { font-size: 7.5pt; color: #9ca3af; font-weight: 400; }

  /* ── Content ── */
  .content { padding: 14mm 22mm 18mm; }

  /* ── Sections ── */
  .section { margin-bottom: 12mm; }
  .section-header { margin-bottom: 7mm; page-break-inside: avoid; page-break-after: avoid; }
  .section-title {
    font-family: Georgia, 'Times New Roman', serif;
    font-size: 17pt; font-weight: 400; color: #0c1829;
    letter-spacing: -0.015em; margin-bottom: 8px;
  }
  .section-rule {
    height: 2px;
    background: linear-gradient(90deg, #c8a25c 0px, rgba(200,162,92,0.25) 80px, transparent 180px);
  }

  /* ── Fields ── */
  .fields { width: 100%; border-collapse: collapse; }
  .field-row { border-bottom: 1px solid #f3f4f6; page-break-inside: avoid; }
  .field-label {
    width: 34%; padding: 8px 14px 8px 0;
    font-size: 8pt; font-weight: 600; color: #6b7280;
    letter-spacing: 0.02em; vertical-align: top; line-height: 1.5;
  }
  .field-value {
    padding: 8px 0; font-size: 10pt; color: #111827;
    vertical-align: top; line-height: 1.55; word-break: break-word;
  }
</style>
</head>
<body>

${coverHtml}

<div class="content">
  ${contentHeaderHtml}
  ${sectionsHtml}
</div>

</body>
</html>`
}

// ─── Signal (Minimal) ─────────────────────────────────────────────────────────
// White cover · single cyan stripe · extreme weight contrast · pure typography
// Confident, architectural, Swiss design sensibility

export function minimalTheme(data: PdfLayoutData): string {
  const initial = data.collectionLabel.charAt(0).toUpperCase()

  const coverHtml = data.coverEnabled ? `
<div class="cover">
  <div class="cover-stripe"></div>
  <div class="cover-inner">
    <div class="cover-top">
      ${data.logoUrl
        ? `<img class="cover-logo" src="${escHtml(data.logoUrl)}" alt="">`
        : `<div class="cover-badge">${escHtml(initial)}</div>`
      }
      <span class="cover-collection">${escHtml(data.collectionLabel)}</span>
    </div>
    <div class="cover-body">
      <h1 class="cover-title">${escHtml(data.coverTitle)}</h1>
      <div class="cover-rule"></div>
      ${data.coverSubtitle ? `<p class="cover-subtitle">${escHtml(data.coverSubtitle)}</p>` : ''}
    </div>
    <div class="cover-bottom">
      <span class="cover-date">${escHtml(data.generatedAt)}</span>
      <span class="cover-by">${escHtml(data.generatedBy)}</span>
    </div>
  </div>
</div>` : ''

  const sectionsHtml = data.sections.map(s => `
<div class="section">
  <div class="section-header">
    <span class="section-marker"></span>
    <h2 class="section-title">${escHtml(s.label)}</h2>
  </div>
  <div class="fields">
    ${s.fields.map(f => `
    <div class="field-row">
      <div class="field-label">${escHtml(f.label)}</div>
      <div class="field-value">${escHtml(f.value)}</div>
    </div>`).join('')}
  </div>
</div>`).join('')

  const contentHeaderHtml = `
<div class="content-header">
  <div class="ch-left">
    <span class="ch-stripe"></span>
    <span class="ch-label">${escHtml(data.collectionLabel)}</span>
  </div>
  <span class="ch-date">${escHtml(data.generatedAt)}</span>
</div>`

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  @page { size: A4; margin: 0; }
  html, body {
    font-family: Helvetica, Arial, sans-serif;
    font-size: 11pt; color: #111111; background: #ffffff;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }

  /* ── Cover ── */
  .cover {
    width: 210mm; height: 297mm;
    background: #ffffff;
    display: flex;
    page-break-after: always;
  }
  .cover-stripe { width: 5px; background: #00ceff; flex-shrink: 0; }
  .cover-inner {
    flex: 1; display: flex; flex-direction: column;
    padding: 28mm 22mm 18mm 20mm;
  }
  .cover-top {
    display: flex; align-items: center; gap: 12px; margin-bottom: auto;
  }
  .cover-badge {
    width: 36px; height: 36px; border-radius: 50%; background: #00ceff;
    display: flex; align-items: center; justify-content: center;
    font-size: 15px; font-weight: 900; color: #ffffff; flex-shrink: 0;
  }
  .cover-logo { height: 32px; width: auto; object-fit: contain; flex-shrink: 0; }
  .cover-collection {
    font-size: 9pt; font-weight: 500; letter-spacing: 0.08em;
    color: #6b7280; text-transform: uppercase;
  }
  .cover-body { margin-bottom: auto; }
  .cover-title {
    font-size: 58pt; font-weight: 900; line-height: 0.95;
    letter-spacing: -0.04em; color: #111111;
    margin-bottom: 20px; word-break: break-word; hyphens: auto;
  }
  .cover-rule { width: 100%; height: 3px; background: #00ceff; margin-bottom: 22px; }
  .cover-subtitle {
    font-size: 12pt; font-weight: 300; color: #6b7280; line-height: 1.45; max-width: 420px;
  }
  .cover-bottom {
    display: flex; justify-content: space-between; align-items: flex-end;
    padding-top: 20px; border-top: 1px solid #e5e7eb;
  }
  .cover-date { font-size: 8.5pt; color: #9ca3af; }
  .cover-by   { font-size: 8.5pt; color: #9ca3af; }

  /* ── Content header ── */
  .content-header {
    display: flex; align-items: center; justify-content: space-between;
    padding-bottom: 10px; margin-bottom: 14mm;
    border-bottom: 1px solid #e5e7eb;
  }
  .ch-left { display: flex; align-items: center; gap: 8px; }
  .ch-stripe { display: inline-block; width: 3px; height: 14px; background: #00ceff; border-radius: 2px; }
  .ch-label {
    font-size: 7.5pt; font-weight: 700;
    letter-spacing: 0.1em; text-transform: uppercase; color: #374151;
  }
  .ch-date { font-size: 7.5pt; color: #9ca3af; }

  /* ── Content ── */
  .content { padding: 14mm 22mm 18mm; }

  /* ── Sections ── */
  .section { margin-bottom: 14mm; }
  .section-header {
    display: flex; align-items: center; gap: 10px;
    margin-bottom: 8mm; page-break-inside: avoid; page-break-after: avoid;
  }
  .section-marker {
    display: inline-block; width: 8px; height: 8px;
    background: #00ceff; border-radius: 2px; flex-shrink: 0;
  }
  .section-title {
    font-size: 15pt; font-weight: 700; color: #111111;
    letter-spacing: -0.02em; line-height: 1;
  }

  /* ── Fields ── */
  .fields { display: flex; flex-direction: column; }
  .field-row {
    display: flex; border-bottom: 1px solid #f3f4f6;
    padding: 7px 0; page-break-inside: avoid;
  }
  .field-label {
    width: 36%; flex-shrink: 0; font-size: 8.5pt; font-weight: 600;
    color: #6b7280; padding-right: 16px; line-height: 1.55;
  }
  .field-value {
    flex: 1; font-size: 10.5pt; color: #111111;
    font-weight: 400; line-height: 1.55; word-break: break-word;
  }
</style>
</head>
<body>

${coverHtml}

<div class="content">
  ${contentHeaderHtml}
  ${sectionsHtml}
</div>

</body>
</html>`
}

// ─── Obsidian (Executive) ─────────────────────────────────────────────────────
// Full dark-mode PDF · near-black pages · cyan accent · Georgia headings
// Premium and unexpected — dark-mode PDFs are rare and immediately striking

export function executiveTheme(data: PdfLayoutData): string {
  const initial = data.collectionLabel.charAt(0).toUpperCase()

  const coverHtml = data.coverEnabled ? `
<div class="cover">
  <div class="cover-top-bar"></div>
  <div class="cover-content">
    <div class="cover-header">
      ${data.logoUrl
        ? `<img class="cover-logo" src="${escHtml(data.logoUrl)}" alt="">`
        : `<div class="cover-badge"><span>${escHtml(initial)}</span></div>`
      }
      <span class="cover-collection">${escHtml(data.collectionLabel)}</span>
    </div>
    <div class="cover-body">
      <div class="cover-eyeline">
        <span class="cover-divider-line"></span>
        <span class="cover-tag">Confidential document</span>
      </div>
      <h1 class="cover-title">${escHtml(data.coverTitle)}</h1>
      ${data.coverSubtitle ? `<p class="cover-subtitle">${escHtml(data.coverSubtitle)}</p>` : ''}
    </div>
    <div class="cover-meta">
      <div class="meta-block">
        <span class="meta-label">Date</span>
        <span class="meta-val">${escHtml(data.generatedAt)}</span>
      </div>
      <div class="meta-block">
        <span class="meta-label">Author</span>
        <span class="meta-val">${escHtml(data.generatedBy)}</span>
      </div>
      <div class="meta-block">
        <span class="meta-label">Collection</span>
        <span class="meta-val">${escHtml(data.collectionLabel)}</span>
      </div>
    </div>
  </div>
</div>` : ''

  const sectionsHtml = data.sections.map(s => `
<div class="section">
  <div class="section-header">
    <h2 class="section-title">${escHtml(s.label)}</h2>
  </div>
  <table class="fields">
    <tbody>
      ${s.fields.map((f, i) => `
      <tr class="field-row${i % 2 === 1 ? ' field-row-alt' : ''}">
        <td class="field-label">${escHtml(f.label)}</td>
        <td class="field-value">${escHtml(f.value)}</td>
      </tr>`).join('')}
    </tbody>
  </table>
</div>`).join('')

  const contentHeaderHtml = `
<div class="content-header">
  <span class="ch-label">${escHtml(data.collectionLabel)}</span>
  <span class="ch-meta">${escHtml(data.generatedAt)} &middot; ${escHtml(data.generatedBy)}</span>
</div>`

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  @page { size: A4; margin: 0; background: #07090f; }
  html, body {
    font-family: Helvetica, Arial, sans-serif;
    font-size: 11pt; color: #e2e8f0; background: #07090f;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }

  /* ── Cover ── */
  .cover {
    width: 210mm; height: 297mm;
    background: #07090f;
    display: flex; flex-direction: column;
    page-break-after: always;
  }
  .cover-top-bar { height: 4px; background: #00ceff; flex-shrink: 0; }
  .cover-content {
    flex: 1; display: flex; flex-direction: column; padding: 26mm 22mm 18mm;
  }
  .cover-header {
    display: flex; align-items: center; gap: 14px; margin-bottom: auto;
  }
  .cover-badge {
    width: 48px; height: 48px; background: #0f1623;
    border: 1px solid #1e2d47; border-radius: 10px;
    display: flex; align-items: center; justify-content: center; flex-shrink: 0;
  }
  .cover-badge span {
    font-family: Georgia, 'Times New Roman', serif;
    font-size: 22px; font-weight: 400; color: #00ceff;
  }
  .cover-logo {
    height: 36px; width: auto; object-fit: contain;
    filter: brightness(0) invert(1); opacity: 0.9; flex-shrink: 0;
  }
  .cover-collection {
    font-size: 8.5pt; font-weight: 600;
    letter-spacing: 0.2em; text-transform: uppercase; color: #00ceff;
  }
  .cover-body { margin-bottom: 24mm; }
  .cover-eyeline {
    display: flex; align-items: center; gap: 12px; margin-bottom: 24px;
  }
  .cover-divider-line {
    display: inline-block; width: 28px; height: 1px;
    background: rgba(0,206,255,0.4); flex-shrink: 0;
  }
  .cover-tag {
    font-size: 8pt; font-weight: 500;
    letter-spacing: 0.15em; text-transform: uppercase; color: rgba(0,206,255,0.6);
  }
  .cover-title {
    font-family: Georgia, 'Times New Roman', serif;
    font-size: 48pt; font-weight: 400; line-height: 1.05;
    letter-spacing: -0.025em; color: #ffffff;
    margin-bottom: 20px; max-width: 500px;
  }
  .cover-subtitle {
    font-size: 13pt; font-weight: 300; color: rgba(255,255,255,0.4); line-height: 1.4;
  }
  .cover-meta {
    display: flex; border-top: 1px solid #1a2336; padding-top: 20px;
  }
  .meta-block {
    flex: 1; display: flex; flex-direction: column; gap: 5px; padding: 0 20px;
  }
  .meta-block:first-child { padding-left: 0; }
  .meta-block:last-child { padding-right: 0; }
  .meta-block + .meta-block { border-left: 1px solid #1a2336; }
  .meta-label {
    font-size: 7pt; font-weight: 600;
    letter-spacing: 0.14em; text-transform: uppercase; color: rgba(255,255,255,0.22);
  }
  .meta-val { font-size: 9pt; color: rgba(255,255,255,0.65); line-height: 1.3; }

  /* ── Content header ── */
  .content-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 0 10px; margin-bottom: 12mm;
    border-top: 2px solid #00ceff;
    border-bottom: 1px solid #1a2336;
  }
  .ch-label {
    font-size: 7.5pt; font-weight: 600;
    letter-spacing: 0.14em; text-transform: uppercase; color: #00ceff;
  }
  .ch-meta { font-size: 7.5pt; color: rgba(255,255,255,0.28); }

  /* ── Content ── */
  .content { padding: 14mm 22mm 18mm; }

  /* ── Sections ── */
  .section { margin-bottom: 12mm; }
  .section-header {
    margin-bottom: 5mm; page-break-inside: avoid; page-break-after: avoid;
    padding-bottom: 8px; border-bottom: 1px solid #1a2336;
  }
  .section-title {
    font-family: Georgia, 'Times New Roman', serif;
    font-size: 14pt; font-weight: 400; color: #00ceff; letter-spacing: -0.01em;
  }

  /* ── Fields ── */
  .fields { width: 100%; border-collapse: collapse; }
  .field-row { border-bottom: 1px solid #0f1623; page-break-inside: avoid; }
  .field-row-alt { background: #0b0f1a; }
  .field-label {
    width: 34%; padding: 8px 14px 8px 8px;
    font-size: 8pt; font-weight: 500; color: #4b6184;
    letter-spacing: 0.01em; vertical-align: top; line-height: 1.5;
  }
  .field-value {
    padding: 8px 8px; font-size: 10pt; color: #c8d6e8;
    vertical-align: top; line-height: 1.55; word-break: break-word; font-weight: 300;
  }
</style>
</head>
<body>

${coverHtml}

<div class="content">
  ${contentHeaderHtml}
  ${sectionsHtml}
</div>

</body>
</html>`
}
