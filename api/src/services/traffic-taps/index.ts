// api/src/services/traffic-taps/index.ts
/**
 * Topology taps (Traffic Map group C). Importing this module registers every tap; the
 * topology route plugin imports it so they exist from boot. The senders (mail, sms, push,
 * Teams, AI, webhooks, Redis) import their `note*` function from the specific file.
 */
import './sources.js'
import './partners.js'
import './pool.js'
import './redis.js'
import './channels.js'
import './ai.js'
import './webhooks.js'
