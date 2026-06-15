import knex, { type Knex } from 'knex'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { getOrCreateTenantPool, runWithTenantDb } from '../db/tenant-context.js'

// Single Knex connection to the Nivaro Cloud meta DB (cloud_tenants table).
// Created lazily on first request. Never used in self-hosted mode.
let _metaDb: Knex | null = null

export function getMetaDb(): Knex {
  if (!_metaDb) {
    _metaDb = knex({
      client: 'pg',
      connection: process.env.CLOUD_META_DB_URL!,
      pool: { min: 1, max: 3 }
    })
  }
  return _metaDb
}

// Subdomains that are not tenant slugs — route through without tenant resolution.
const RESERVED = new Set(['www', 'control', 'api', 'admin', 'status', 'mail'])

// Paths that work without a tenant DB (health check, Inngest, admin provision).
const TENANT_FREE_PATHS = ['/health', '/api/inngest', '/admin/provision', '/admin/migrate', '/admin/migration-status', '/admin/configure-storage']

// ---------------------------------------------------------------------------
// HTML error pages
// ---------------------------------------------------------------------------

function suspendedPage(name: string, slug: string): string {
  const gatewayUrl = process.env.GATEWAY_URL ?? 'https://app.nivaro.dev'
  const marketingUrl = process.env.CLOUD_MARKETING_URL ?? 'https://nivaro.dev'
  const billingUrl = `${gatewayUrl}/account/${encodeURIComponent(slug)}/reactivate`
  const learnUrl = `${marketingUrl}/suspended`

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Account Suspended — Nivaro</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet" />
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --cyan: #00ceff;
      --navy: #0a1628;
      --navy-mid: #0f2040;
      --text-primary: #f0f6ff;
      --text-muted: #8ba4c8;
      --border: rgba(0, 206, 255, 0.15);
    }

    html, body {
      min-height: 100%;
      font-family: 'Inter', system-ui, sans-serif;
      background: var(--navy);
      color: var(--text-primary);
      -webkit-font-smoothing: antialiased;
    }

    body {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 24px;
      position: relative;
      overflow: hidden;
    }

    body::before {
      content: '';
      position: fixed;
      inset: 0;
      background:
        radial-gradient(ellipse 80% 60% at 20% 10%, rgba(0, 206, 255, 0.08) 0%, transparent 60%),
        radial-gradient(ellipse 60% 50% at 80% 80%, rgba(0, 206, 255, 0.06) 0%, transparent 55%),
        radial-gradient(ellipse 100% 80% at 50% 50%, rgba(15, 32, 64, 0.8) 0%, transparent 100%);
      z-index: 0;
      animation: bgShift 12s ease-in-out infinite alternate;
    }

    @keyframes bgShift {
      0%   { opacity: 1; transform: scale(1); }
      100% { opacity: 0.8; transform: scale(1.04); }
    }

    body::after {
      content: '';
      position: fixed;
      inset: 0;
      background-image:
        linear-gradient(rgba(0, 206, 255, 0.04) 1px, transparent 1px),
        linear-gradient(90deg, rgba(0, 206, 255, 0.04) 1px, transparent 1px);
      background-size: 48px 48px;
      z-index: 0;
    }

    .container {
      position: relative;
      z-index: 1;
      width: 100%;
      max-width: 520px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 32px;
    }

    .logo {
      display: flex;
      align-items: center;
      gap: 10px;
      text-decoration: none;
    }

    .logo-mark {
      width: 36px;
      height: 36px;
      background: linear-gradient(135deg, var(--cyan) 0%, rgba(0, 206, 255, 0.6) 100%);
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 0 20px rgba(0, 206, 255, 0.4);
    }

    .logo-mark svg {
      width: 20px;
      height: 20px;
      fill: var(--navy);
    }

    .logo-text {
      font-size: 18px;
      font-weight: 700;
      color: var(--text-primary);
      letter-spacing: -0.3px;
    }

    .card {
      width: 100%;
      background: rgba(15, 32, 64, 0.6);
      border: 1px solid var(--border);
      border-radius: 20px;
      padding: 40px;
      backdrop-filter: blur(24px);
      -webkit-backdrop-filter: blur(24px);
      box-shadow:
        0 0 0 1px rgba(0, 206, 255, 0.08),
        0 24px 64px rgba(0, 0, 0, 0.5),
        inset 0 1px 0 rgba(255, 255, 255, 0.06);
    }

    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      background: rgba(255, 80, 80, 0.12);
      border: 1px solid rgba(255, 80, 80, 0.3);
      border-radius: 100px;
      padding: 5px 14px;
      font-size: 12px;
      font-weight: 600;
      color: #ff8080;
      letter-spacing: 0.5px;
      text-transform: uppercase;
      margin-bottom: 24px;
    }

    .status-badge::before {
      content: '';
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #ff6060;
      box-shadow: 0 0 6px rgba(255, 80, 80, 0.8);
      animation: pulse 2s ease-in-out infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }

    .headline {
      font-size: 28px;
      font-weight: 700;
      line-height: 1.2;
      color: var(--text-primary);
      margin-bottom: 8px;
      letter-spacing: -0.5px;
    }

    .tenant-name { color: var(--cyan); }

    .subhead {
      font-size: 15px;
      color: var(--text-muted);
      line-height: 1.6;
      margin-bottom: 32px;
    }

    .divider {
      height: 1px;
      background: linear-gradient(90deg, transparent, var(--border), transparent);
      margin-bottom: 32px;
    }

    .actions {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .btn {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 14px 20px;
      border-radius: 12px;
      font-size: 14px;
      font-weight: 600;
      text-decoration: none;
      transition: all 0.18s ease;
      cursor: pointer;
      border: none;
    }

    .btn-primary {
      background: linear-gradient(135deg, var(--cyan) 0%, rgba(0, 206, 255, 0.8) 100%);
      color: var(--navy);
      box-shadow: 0 4px 20px rgba(0, 206, 255, 0.3);
    }

    .btn-primary:hover {
      transform: translateY(-1px);
      box-shadow: 0 8px 28px rgba(0, 206, 255, 0.45);
      filter: brightness(1.06);
    }

    .btn-secondary {
      background: rgba(255, 255, 255, 0.06);
      color: var(--text-primary);
      border: 1px solid rgba(255, 255, 255, 0.1);
    }

    .btn-secondary:hover {
      background: rgba(255, 255, 255, 0.1);
      border-color: rgba(255, 255, 255, 0.18);
      transform: translateY(-1px);
    }

    .btn-ghost {
      background: transparent;
      color: var(--text-muted);
      font-weight: 500;
    }

    .btn-ghost:hover { color: var(--text-primary); }

    .btn svg {
      width: 16px;
      height: 16px;
      flex-shrink: 0;
    }

    .safety-note {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      background: rgba(0, 206, 255, 0.06);
      border: 1px solid rgba(0, 206, 255, 0.12);
      border-radius: 10px;
      padding: 14px 16px;
      margin-top: 28px;
    }

    .safety-note svg {
      width: 16px;
      height: 16px;
      flex-shrink: 0;
      margin-top: 1px;
      color: var(--cyan);
    }

    .safety-note p {
      font-size: 13px;
      color: var(--text-muted);
      line-height: 1.5;
    }

    .safety-note strong {
      color: var(--text-primary);
      font-weight: 500;
    }

    .page-footer {
      font-size: 13px;
      color: var(--text-muted);
      text-align: center;
    }

    .page-footer a {
      color: var(--cyan);
      text-decoration: none;
    }

    .page-footer a:hover { text-decoration: underline; }

    @media (max-width: 560px) {
      .card { padding: 28px 24px; }
      .headline { font-size: 22px; }
    }
  </style>
</head>
<body>
  <div class="container">
    <a href="https://nivaro.dev" class="logo">
      <div class="logo-mark">
        <svg viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">
          <path d="M10 2L3 7v6l7 5 7-5V7L10 2zm0 2.4l5 3.57v4.06l-5 3.57-5-3.57V7.97L10 4.4z"/>
        </svg>
      </div>
      <span class="logo-text">Nivaro</span>
    </a>

    <div class="card">
      <div class="status-badge">Account Suspended</div>

      <h1 class="headline">
        <span class="tenant-name">${escapeHtml(name)}</span> has been suspended
      </h1>
      <p class="subhead">
        This workspace is currently unavailable due to a billing issue or an administrative action.
        Please update your billing details to restore access immediately.
      </p>

      <div class="divider"></div>

      <div class="actions">
        <a href="${escapeHtml(billingUrl)}" class="btn btn-primary">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="1" y="4" width="22" height="16" rx="2" ry="2"/>
            <line x1="1" y1="10" x2="23" y2="10"/>
          </svg>
          Update Billing
        </a>
        <a href="mailto:support@nivaro.dev" class="btn btn-secondary">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/>
            <polyline points="22,6 12,13 2,6"/>
          </svg>
          Contact Support
        </a>
        <a href="${escapeHtml(learnUrl)}" class="btn btn-ghost">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"/>
            <line x1="12" y1="8" x2="12" y2="12"/>
            <line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
          Learn More
        </a>
      </div>

      <div class="safety-note">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
        </svg>
        <p><strong>Your data is safe.</strong> Accounts are permanently deleted only after 30 days of suspension.</p>
      </div>
    </div>

    <p class="page-footer">
      Need help? <a href="mailto:support@nivaro.dev">support@nivaro.dev</a> &nbsp;&middot;&nbsp;
      <a href="https://nivaro.dev">nivaro.dev</a>
    </p>
  </div>
</body>
</html>`
}

function provisioningPage(name: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="refresh" content="30" />
  <title>Setting Up Your Workspace — Nivaro</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet" />
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --cyan: #00ceff;
      --navy: #0a1628;
      --text-primary: #f0f6ff;
      --text-muted: #8ba4c8;
      --border: rgba(0, 206, 255, 0.15);
    }

    html, body {
      min-height: 100%;
      font-family: 'Inter', system-ui, sans-serif;
      background: var(--navy);
      color: var(--text-primary);
      -webkit-font-smoothing: antialiased;
    }

    body {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 24px;
      position: relative;
      overflow: hidden;
    }

    body::before {
      content: '';
      position: fixed;
      inset: 0;
      background:
        radial-gradient(ellipse 70% 60% at 30% 20%, rgba(0, 206, 255, 0.1) 0%, transparent 60%),
        radial-gradient(ellipse 60% 50% at 70% 70%, rgba(0, 206, 255, 0.07) 0%, transparent 55%);
      z-index: 0;
      animation: breathe 8s ease-in-out infinite alternate;
    }

    @keyframes breathe {
      0%   { opacity: 0.6; transform: scale(1); }
      100% { opacity: 1; transform: scale(1.06); }
    }

    body::after {
      content: '';
      position: fixed;
      inset: 0;
      background-image:
        linear-gradient(rgba(0, 206, 255, 0.03) 1px, transparent 1px),
        linear-gradient(90deg, rgba(0, 206, 255, 0.03) 1px, transparent 1px);
      background-size: 48px 48px;
      z-index: 0;
    }

    .container {
      position: relative;
      z-index: 1;
      width: 100%;
      max-width: 480px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 32px;
    }

    .logo {
      display: flex;
      align-items: center;
      gap: 10px;
      text-decoration: none;
    }

    .logo-mark {
      width: 36px;
      height: 36px;
      background: linear-gradient(135deg, var(--cyan) 0%, rgba(0, 206, 255, 0.6) 100%);
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 0 20px rgba(0, 206, 255, 0.4);
    }

    .logo-mark svg {
      width: 20px;
      height: 20px;
      fill: var(--navy);
    }

    .logo-text {
      font-size: 18px;
      font-weight: 700;
      color: var(--text-primary);
      letter-spacing: -0.3px;
    }

    .card {
      width: 100%;
      background: rgba(15, 32, 64, 0.6);
      border: 1px solid var(--border);
      border-radius: 20px;
      padding: 48px 40px;
      backdrop-filter: blur(24px);
      -webkit-backdrop-filter: blur(24px);
      box-shadow:
        0 0 0 1px rgba(0, 206, 255, 0.08),
        0 24px 64px rgba(0, 0, 0, 0.5),
        inset 0 1px 0 rgba(255, 255, 255, 0.06);
      text-align: center;
      display: flex;
      flex-direction: column;
      align-items: center;
    }

    .spinner-wrap {
      position: relative;
      width: 80px;
      height: 80px;
      margin-bottom: 32px;
    }

    .spinner-ring {
      position: absolute;
      inset: 0;
      border-radius: 50%;
      border: 2px solid transparent;
    }

    .spinner-ring:nth-child(1) {
      border-top-color: var(--cyan);
      animation: spin 1.2s linear infinite;
      box-shadow: 0 0 16px rgba(0, 206, 255, 0.3);
    }

    .spinner-ring:nth-child(2) {
      inset: 10px;
      border-top-color: rgba(0, 206, 255, 0.4);
      animation: spin 1.6s linear infinite reverse;
    }

    .spinner-ring:nth-child(3) {
      inset: 20px;
      border-top-color: rgba(0, 206, 255, 0.2);
      animation: spin 2s linear infinite;
    }

    .spinner-dot {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .spinner-dot::after {
      content: '';
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: var(--cyan);
      box-shadow: 0 0 12px rgba(0, 206, 255, 0.8);
      animation: dotPulse 1.2s ease-in-out infinite;
    }

    @keyframes spin { to { transform: rotate(360deg); } }

    @keyframes dotPulse {
      0%, 100% { transform: scale(1); opacity: 1; }
      50% { transform: scale(0.7); opacity: 0.5; }
    }

    .headline {
      font-size: 24px;
      font-weight: 700;
      color: var(--text-primary);
      margin-bottom: 10px;
      letter-spacing: -0.4px;
    }

    .tenant-name { color: var(--cyan); }

    .subhead {
      font-size: 15px;
      color: var(--text-muted);
      line-height: 1.6;
      margin-bottom: 36px;
      max-width: 340px;
    }

    .steps {
      width: 100%;
      display: flex;
      flex-direction: column;
      text-align: left;
    }

    .step {
      display: flex;
      align-items: center;
      gap: 14px;
      padding: 14px 0;
      border-bottom: 1px solid rgba(0, 206, 255, 0.08);
    }

    .step:last-child { border-bottom: none; }

    .step-icon {
      width: 32px;
      height: 32px;
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }

    .step-icon.done {
      background: rgba(0, 206, 255, 0.15);
      border: 1px solid rgba(0, 206, 255, 0.3);
    }

    .step-icon.active {
      background: rgba(0, 206, 255, 0.2);
      border: 1px solid rgba(0, 206, 255, 0.5);
      animation: iconPulse 1.5s ease-in-out infinite;
    }

    .step-icon.pending {
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.08);
    }

    @keyframes iconPulse {
      0%, 100% { box-shadow: 0 0 0 0 rgba(0, 206, 255, 0.3); }
      50% { box-shadow: 0 0 0 4px rgba(0, 206, 255, 0.1); }
    }

    .step-icon svg {
      width: 15px;
      height: 15px;
    }

    .step-icon.done svg { color: var(--cyan); }
    .step-icon.active svg { color: var(--cyan); }
    .step-icon.pending svg { color: rgba(255,255,255,0.3); }

    .step-label {
      font-size: 14px;
      font-weight: 500;
      color: var(--text-primary);
      flex: 1;
    }

    .step-label.pending { color: var(--text-muted); }

    .step-status {
      font-size: 12px;
      font-weight: 500;
    }

    .step-status.done { color: var(--cyan); }
    .step-status.active { color: var(--cyan); animation: blink 1.4s step-start infinite; }
    .step-status.pending { color: rgba(255,255,255,0.2); }

    @keyframes blink {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.3; }
    }

    .refresh-note {
      margin-top: 28px;
      font-size: 13px;
      color: var(--text-muted);
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .refresh-note svg {
      width: 13px;
      height: 13px;
      animation: spin 3s linear infinite;
    }

    .page-footer {
      font-size: 13px;
      color: var(--text-muted);
      text-align: center;
    }

    .page-footer a {
      color: var(--cyan);
      text-decoration: none;
    }

    .page-footer a:hover { text-decoration: underline; }

    @media (max-width: 520px) {
      .card { padding: 36px 24px; }
      .headline { font-size: 20px; }
    }
  </style>
</head>
<body>
  <div class="container">
    <a href="https://nivaro.dev" class="logo">
      <div class="logo-mark">
        <svg viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">
          <path d="M10 2L3 7v6l7 5 7-5V7L10 2zm0 2.4l5 3.57v4.06l-5 3.57-5-3.57V7.97L10 4.4z"/>
        </svg>
      </div>
      <span class="logo-text">Nivaro</span>
    </a>

    <div class="card">
      <div class="spinner-wrap">
        <div class="spinner-ring"></div>
        <div class="spinner-ring"></div>
        <div class="spinner-ring"></div>
        <div class="spinner-dot"></div>
      </div>

      <h1 class="headline">
        Setting up <span class="tenant-name">${escapeHtml(name)}</span>
      </h1>
      <p class="subhead">
        Your workspace is being provisioned. This usually takes about a minute.
        This page will refresh automatically.
      </p>

      <div class="steps">
        <div class="step">
          <div class="step-icon done">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
          </div>
          <span class="step-label">Workspace created</span>
          <span class="step-status done">Done</span>
        </div>
        <div class="step">
          <div class="step-icon active">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <ellipse cx="12" cy="5" rx="9" ry="3"/>
              <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/>
              <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>
            </svg>
          </div>
          <span class="step-label">Provisioning database</span>
          <span class="step-status active">In progress&hellip;</span>
        </div>
        <div class="step">
          <div class="step-icon pending">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
              <polyline points="14 2 14 8 20 8"/>
              <line x1="16" y1="13" x2="8" y2="13"/>
              <line x1="16" y1="17" x2="8" y2="17"/>
              <polyline points="10 9 9 9 8 9"/>
            </svg>
          </div>
          <span class="step-label pending">Running migrations</span>
          <span class="step-status pending">Waiting</span>
        </div>
        <div class="step">
          <div class="step-icon pending">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
              <polyline points="22 4 12 14.01 9 11.01"/>
            </svg>
          </div>
          <span class="step-label pending">Ready to use</span>
          <span class="step-status pending">Soon</span>
        </div>
      </div>

      <p class="refresh-note">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="23 4 23 10 17 10"/>
          <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
        </svg>
        Auto-refreshing in 30 seconds
      </p>
    </div>

    <p class="page-footer">
      Taking longer than expected? <a href="mailto:support@nivaro.dev">Contact support</a>
    </p>
  </div>
</body>
</html>`
}

/** Minimal HTML-escape for values injected into HTML strings. */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// ---------------------------------------------------------------------------
// Tenant resolution — discriminated union result
// ---------------------------------------------------------------------------

type TenantResult =
  | { found: false }
  | { found: true; suspended: true; row: { name: string; slug: string; status: string } }
  | { found: true; suspended: false; provisioning: true; row: { name: string; slug: string } }
  | { found: true; suspended: false; provisioning: false; db: Knex; slug: string; tenantId: string }

/** Resolves the tenant from the request hostname.
 *  Returns a discriminated union indicating not-found, suspended, provisioning, or active. */
async function resolveTenant(hostname: string): Promise<TenantResult> {
  // When behind Cloudflare Worker, the original host is passed via X-Forwarded-Host
  const sub = hostname.split('.')[0]
  if (!sub || RESERVED.has(sub)) return { found: false }

  const row = await getMetaDb()('cloud_tenants')
    .where({ subdomain: sub })
    .first('id', 'slug', 'name', 'status', 'db_client', 'db_connection_string')
    .catch(() => null)

  if (!row) return { found: false }

  if (row.status === 'provisioning') {
    return {
      found: true,
      suspended: false,
      provisioning: true,
      row: { name: row.name as string, slug: row.slug as string },
    }
  }

  if (row.status !== 'active') {
    return {
      found: true,
      suspended: true,
      row: { name: row.name as string, slug: row.slug as string, status: row.status as string },
    }
  }

  return {
    found: true,
    suspended: false,
    provisioning: false,
    db: getOrCreateTenantPool(row.db_connection_string, row.db_client),
    slug: row.slug as string,
    tenantId: row.id as string,
  }
}

// ---------------------------------------------------------------------------
// Fastify hook
// ---------------------------------------------------------------------------

/** Returns true when the request is from a browser and should receive HTML. */
function wantsHtml(req: FastifyRequest): boolean {
  // Requests to /api/* are always JSON API calls
  if (req.url.startsWith('/api/')) return false
  const accept = (req.headers['accept'] ?? '') as string
  return accept.includes('text/html') || accept.includes('*/*')
}

/** Fastify `onRequest` hook — only registered when CLOUD_META_DB_URL is set.
 *  Resolves the tenant DB for this request and sets it in AsyncLocalStorage
 *  by calling done() from within store.run(), propagating the context to all
 *  subsequent async operations in this request's lifecycle. */
export function tenantHook(req: FastifyRequest, reply: FastifyReply, done: (err?: Error) => void) {
  // X-Tenant-Host is set by the Cloudflare Worker and won't be overridden by Railway's proxy
  const hostname = (req.headers['x-tenant-host'] as string | undefined)
    ?? (req.headers['x-forwarded-host'] as string | undefined)
    ?? req.hostname
  // Tenant-free paths bypass resolution entirely
  if (TENANT_FREE_PATHS.some(p => req.url === p || req.url.startsWith(p + '/'))) {
    return done()
  }

  resolveTenant(hostname)
    .then((result) => {
      if (!result.found) {
        // Unknown subdomain — redirect to marketing start page
        const target = `${process.env.CLOUD_MARKETING_URL ?? 'https://nivaro.dev'}/start`
        reply.redirect(target, 302)
        return
      }

      if (result.suspended) {
        const { row } = result
        if (wantsHtml(req)) {
          reply
            .code(503)
            .header('content-type', 'text/html; charset=utf-8')
            .header('cache-control', 'no-store')
            .send(suspendedPage(row.name, row.slug))
        } else {
          reply.code(503).send({ error: 'Account suspended', slug: row.slug })
        }
        return
      }

      if (result.provisioning) {
        const { row } = result
        if (wantsHtml(req)) {
          reply
            .code(503)
            .header('content-type', 'text/html; charset=utf-8')
            .header('cache-control', 'no-store')
            .send(provisioningPage(row.name))
        } else {
          reply.code(503).send({ error: 'Workspace is being provisioned', slug: row.slug, status: 'provisioning' })
        }
        return
      }

      runWithTenantDb(result.db, result.slug, done, result.tenantId)
    })
    .catch((err: unknown) => done(err instanceof Error ? err : new Error(String(err))))
}
