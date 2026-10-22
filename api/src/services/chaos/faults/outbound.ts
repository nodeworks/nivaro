import { registerFault } from '../catalog.js'

/**
 * Outbound dependency faults (#2834). One point each, at the one place the call leaves:
 *   ai.call     services/ai-client.ts buildAiClient (every per-model client of the factory)
 *   oidc.call   auth/oidc.ts discovery + the authorization-code grant (primary and extra providers)
 *   graph.call  services/graph-directory.ts (token + every Graph read) and the sign-in profile/photo
 * The errors are the real failures' shapes (services/chaos/outbound-points.ts).
 */

registerFault({
  key: 'ai_gateway_fault',
  label: 'AI gateway failing',
  area: 'outbound',
  proves:
    'When the AI gateway fails, people get the plain "AI is unavailable" answer (503), a refused model id falls back to the next model in the chain and the fallback is counted, and nothing else in Nivaro slows down.',
  claim_keys: ['ai.unavailable_503', 'ai.model_fallback'],
  targets: ['all', 'share'],
  params: {
    mode: {
      type: 'enum',
      label: 'Failure',
      options: ['error_5xx', 'timeout', 'model_refused', 'slow'],
      default: 'error_5xx'
    },
    status: { type: 'number', label: 'Status (5xx)', min: 500, max: 504, default: 503 },
    delay_ms: {
      type: 'number',
      label: 'Wait (timeout / slow)',
      min: 100,
      max: 60_000,
      default: 10_000,
      unit: 'ms'
    }
  },
  max_seconds: 600,
  default_seconds: 120,
  points: ['ai.call'],
  danger: 'low'
})

registerFault({
  key: 'oidc_down',
  label: 'Sign-in provider down',
  area: 'outbound',
  proves:
    'With the identity provider down or slow, everyone already signed in keeps working (a session never calls the provider), and the sign-in page says the provider is not answering — no raw error, no redirect loop.',
  claim_keys: ['signin.idp_down_sessions_hold', 'auth.signin_clear_error'],
  targets: ['all'],
  params: {
    mode: { type: 'enum', label: 'Failure', options: ['down', 'slow'], default: 'down' },
    step: {
      type: 'enum',
      label: 'Where',
      options: ['discovery', 'token', 'both'],
      default: 'both'
    },
    delay_ms: {
      type: 'number',
      label: 'Wait (slow)',
      min: 100,
      max: 30_000,
      default: 8000,
      unit: 'ms'
    }
  },
  max_seconds: 600,
  default_seconds: 120,
  points: ['oidc.call'],
  danger: 'medium'
})

registerFault({
  key: 'graph_down',
  label: 'Microsoft Graph down',
  area: 'outbound',
  proves:
    'With Microsoft Graph down or slow, directory lookups answer a clear "Graph did not answer" error, sign-in still completes without the org profile or photo, and nothing waits past its timeout.',
  claim_keys: ['graph.fails_clean'],
  targets: ['all'],
  params: {
    mode: { type: 'enum', label: 'Failure', options: ['down', 'slow'], default: 'down' },
    delay_ms: {
      type: 'number',
      label: 'Wait (slow)',
      min: 100,
      max: 30_000,
      default: 6000,
      unit: 'ms'
    }
  },
  max_seconds: 600,
  default_seconds: 120,
  points: ['graph.call'],
  danger: 'low'
})
