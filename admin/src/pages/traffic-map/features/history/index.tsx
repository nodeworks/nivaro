/**
 * tm-history — long history, playback and history-derived analysis (#2228 minute store switch,
 * #2183 time-lapse, #2175 search, #2193 latency modes, #2252 slow parameters, #2249 people
 * online, #2165 jobs against peaks, #2151 what-if capacity on the headroom tile).
 */
import { pagePanels } from '../../registry/pagePanels'
import { register } from '../../registry/registry'
import { HistoryPanel } from './HistoryPanel'
import './RouteLatency'
import './shared'

register(pagePanels, { id: 'history', order: 90, Component: HistoryPanel })
