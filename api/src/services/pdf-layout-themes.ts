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

function renderSections(sections: PdfLayoutData['sections']): string {
  return sections.map(s => `
    <div class="section">
      <div class="section-label">${escHtml(s.label)}</div>
      <table class="fields">
        ${s.fields.map(f => `
          <tr>
            <td class="field-label">${escHtml(f.label)}</td>
            <td class="field-value">${escHtml(f.value)}</td>
          </tr>`).join('')}
      </table>
    </div>`).join('')
}

export function classicTheme(data: PdfLayoutData): string {
  const cover = data.coverEnabled ? `
    <div class="cover">
      ${data.logoUrl ? `<img class="logo" src="${escHtml(data.logoUrl)}" alt="">` : ''}
      <div class="cover-body">
        <div class="cover-collection">${escHtml(data.collectionLabel)}</div>
        <div class="cover-title">${escHtml(data.coverTitle)}</div>
        ${data.coverSubtitle ? `<div class="cover-subtitle">${escHtml(data.coverSubtitle)}</div>` : ''}
      </div>
      <div class="cover-meta">Generated ${escHtml(data.generatedAt)} · ${escHtml(data.generatedBy)}</div>
    </div>` : ''

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: Georgia, 'Times New Roman', serif; font-size: 10.5pt; color: #1a2a40; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.cover { background: #1a3a5c; color: white; padding: 60px; min-height: 100vh; display: flex; flex-direction: column; page-break-after: always; }
.cover .logo { max-height: 44px; margin-bottom: 48px; }
.cover-body { flex: 1; display: flex; flex-direction: column; justify-content: center; }
.cover-collection { font-family: Arial, sans-serif; font-size: 10pt; opacity: 0.55; letter-spacing: 0.12em; text-transform: uppercase; margin-bottom: 18px; }
.cover-title { font-size: 36pt; font-weight: bold; line-height: 1.1; margin-bottom: 18px; }
.cover-subtitle { font-size: 13pt; opacity: 0.7; margin-top: 6px; }
.cover-meta { font-family: Arial, sans-serif; font-size: 9pt; opacity: 0.45; margin-top: 48px; }
.content { padding: 52px; }
.page-header { display: flex; justify-content: space-between; align-items: center; padding-bottom: 14px; border-bottom: 2.5px solid #1a3a5c; margin-bottom: 40px; }
.page-header .col-name { font-family: Arial, sans-serif; font-size: 10pt; font-weight: bold; color: #1a3a5c; letter-spacing: 0.06em; text-transform: uppercase; }
.page-header .logo-small { max-height: 28px; }
.section { margin-bottom: 36px; }
.section-label { font-family: Arial, sans-serif; font-size: 7.5pt; font-weight: bold; text-transform: uppercase; letter-spacing: 0.14em; color: #7a8fa6; padding-bottom: 8px; border-bottom: 1px solid #e2e8f0; margin-bottom: 14px; }
.fields { width: 100%; border-collapse: collapse; }
.fields td { padding: 8px 0; border-bottom: 1px solid #f1f5f9; vertical-align: top; }
.field-label { width: 210px; font-family: Arial, sans-serif; font-weight: bold; color: #4a6070; font-size: 9.5pt; padding-right: 20px; }
.field-value { color: #1a2a40; font-size: 10pt; }
.page-footer { position: fixed; bottom: 22px; left: 52px; right: 52px; border-top: 1px solid #e2e8f0; padding-top: 8px; font-family: Arial, sans-serif; font-size: 8.5pt; color: #9ab0c4; display: flex; justify-content: space-between; }
</style>
</head>
<body>
${cover}
<div class="content">
  <div class="page-header">
    <span class="col-name">${escHtml(data.collectionLabel)}</span>
    ${data.logoUrl ? `<img class="logo-small" src="${escHtml(data.logoUrl)}" alt="">` : ''}
  </div>
  ${renderSections(data.sections)}
  <div class="page-footer">
    <span>${escHtml(data.collectionLabel)} — ${escHtml(data.coverTitle)}</span>
    <span>Generated ${escHtml(data.generatedAt)}</span>
  </div>
</div>
</body>
</html>`
}

export function minimalTheme(data: PdfLayoutData): string {
  const cover = data.coverEnabled ? `
    <div class="cover">
      ${data.logoUrl ? `<img class="logo" src="${escHtml(data.logoUrl)}" alt="">` : ''}
      <div class="cover-body">
        <div class="cover-collection">${escHtml(data.collectionLabel)}</div>
        <div class="cover-title">${escHtml(data.coverTitle)}</div>
        ${data.coverSubtitle ? `<div class="cover-subtitle">${escHtml(data.coverSubtitle)}</div>` : ''}
      </div>
      <div class="cover-meta">Generated ${escHtml(data.generatedAt)} by ${escHtml(data.generatedBy)}</div>
    </div>` : ''

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, 'Helvetica Neue', Arial, sans-serif; font-size: 10.5pt; color: #1c1c1c; }
.cover { background: white; padding: 72px 64px; min-height: 100vh; display: flex; flex-direction: column; page-break-after: always; border-top: 3px solid #1c1c1c; }
.cover .logo { max-height: 36px; margin-bottom: 80px; }
.cover-body { flex: 1; display: flex; flex-direction: column; justify-content: center; }
.cover-collection { font-size: 9pt; color: #999; letter-spacing: 0.1em; text-transform: uppercase; margin-bottom: 24px; }
.cover-title { font-size: 40pt; font-weight: 200; line-height: 1.1; color: #1c1c1c; margin-bottom: 20px; letter-spacing: -0.02em; }
.cover-subtitle { font-size: 13pt; color: #555; font-weight: 300; }
.cover-meta { font-size: 8.5pt; color: #aaa; margin-top: auto; padding-top: 40px; }
.content { padding: 56px 64px; }
.page-header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 40px; padding-bottom: 16px; border-bottom: 1px solid #e8e8e8; }
.page-header .col-name { font-size: 9pt; color: #aaa; letter-spacing: 0.08em; text-transform: uppercase; }
.page-header .logo-small { max-height: 24px; }
.section { margin-bottom: 40px; }
.section-label { font-size: 8pt; color: #bbb; letter-spacing: 0.14em; text-transform: uppercase; margin-bottom: 18px; }
.fields { width: 100%; border-collapse: collapse; }
.fields td { padding: 9px 0; border-bottom: 1px solid #f0f0f0; vertical-align: top; }
.field-label { width: 200px; font-size: 9pt; color: #888; padding-right: 20px; }
.field-value { font-size: 10pt; color: #1c1c1c; }
.page-footer { position: fixed; bottom: 24px; left: 64px; right: 64px; border-top: 1px solid #eeeeee; padding-top: 8px; font-size: 8pt; color: #ccc; display: flex; justify-content: space-between; }
</style>
</head>
<body>
${cover}
<div class="content">
  <div class="page-header">
    <span class="col-name">${escHtml(data.collectionLabel)}</span>
    ${data.logoUrl ? `<img class="logo-small" src="${escHtml(data.logoUrl)}" alt="">` : ''}
  </div>
  ${renderSections(data.sections)}
  <div class="page-footer">
    <span>${escHtml(data.coverTitle)}</span>
    <span>${escHtml(data.generatedAt)}</span>
  </div>
</div>
</body>
</html>`
}

export function executiveTheme(data: PdfLayoutData): string {
  const cover = data.coverEnabled ? `
    <div class="cover">
      <div class="cover-accent"></div>
      <div class="cover-inner">
        ${data.logoUrl ? `<img class="logo" src="${escHtml(data.logoUrl)}" alt="">` : ''}
        <div class="cover-body">
          <div class="cover-collection">${escHtml(data.collectionLabel)}</div>
          <div class="cover-title">${escHtml(data.coverTitle)}</div>
          ${data.coverSubtitle ? `<div class="cover-subtitle">${escHtml(data.coverSubtitle)}</div>` : ''}
        </div>
        <div class="cover-meta">
          <div class="cover-meta-row"><span class="meta-label">Prepared by</span><span>${escHtml(data.generatedBy)}</span></div>
          <div class="cover-meta-row"><span class="meta-label">Date</span><span>${escHtml(data.generatedAt)}</span></div>
        </div>
      </div>
    </div>` : ''

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, 'Helvetica Neue', Arial, sans-serif; font-size: 10.5pt; color: #0f172a; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.cover { background: #0f172a; min-height: 100vh; page-break-after: always; display: flex; flex-direction: column; }
.cover-accent { height: 5px; background: linear-gradient(90deg, #00ceff 0%, #0080ff 100%); }
.cover-inner { flex: 1; display: flex; flex-direction: column; padding: 56px; }
.cover .logo { max-height: 40px; margin-bottom: 80px; filter: brightness(0) invert(1) opacity(0.7); }
.cover-body { flex: 1; display: flex; flex-direction: column; justify-content: center; }
.cover-collection { font-size: 9pt; color: #00ceff; letter-spacing: 0.16em; text-transform: uppercase; margin-bottom: 20px; }
.cover-title { font-size: 38pt; font-weight: 700; line-height: 1.1; color: white; margin-bottom: 16px; }
.cover-subtitle { font-size: 13pt; color: #94a3b8; margin-top: 8px; }
.cover-meta { margin-top: 60px; }
.cover-meta-row { display: flex; gap: 20px; padding: 8px 0; border-top: 1px solid #1e293b; font-size: 9pt; color: #94a3b8; }
.meta-label { width: 100px; color: #475569; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; font-size: 8pt; }
.content { padding: 52px; }
.page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 36px; padding-bottom: 14px; border-bottom: 1px solid #e2e8f0; }
.page-header .col-name { font-size: 9pt; font-weight: 700; color: #0f172a; letter-spacing: 0.08em; text-transform: uppercase; }
.page-header .logo-small { max-height: 28px; }
.section { margin-bottom: 36px; }
.section-label { font-size: 7.5pt; font-weight: 700; text-transform: uppercase; letter-spacing: 0.16em; color: #00b3e0; padding-bottom: 9px; border-bottom: 2px solid #00ceff; margin-bottom: 14px; }
.fields { width: 100%; border-collapse: collapse; }
.fields td { padding: 8px 0; border-bottom: 1px solid #f1f5f9; vertical-align: top; }
.field-label { width: 200px; font-size: 9pt; font-weight: 600; color: #475569; padding-right: 20px; }
.field-value { font-size: 10pt; color: #0f172a; }
.page-footer { position: fixed; bottom: 22px; left: 52px; right: 52px; border-top: 1px solid #e2e8f0; padding-top: 8px; font-size: 8.5pt; color: #94a3b8; display: flex; justify-content: space-between; }
</style>
</head>
<body>
${cover}
<div class="content">
  <div class="page-header">
    <span class="col-name">${escHtml(data.collectionLabel)}</span>
    ${data.logoUrl ? `<img class="logo-small" src="${escHtml(data.logoUrl)}" alt="">` : ''}
  </div>
  ${renderSections(data.sections)}
  <div class="page-footer">
    <span>${escHtml(data.collectionLabel)} — ${escHtml(data.coverTitle)}</span>
    <span>Generated ${escHtml(data.generatedAt)}</span>
  </div>
</div>
</body>
</html>`
}
