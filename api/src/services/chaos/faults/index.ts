/**
 * The fault catalog's contents (#2827). Each area is one file with its `registerFault` calls;
 * a new area adds its file and ONE import line here. Importing this module fills the catalog.
 */
import './http.js'
import './socket.js'
import './db.js'
import './pool.js'
import './partner.js'
import './storage.js'
import './process.js'
import './clock.js'
// #1773 — records what readiness and the alerts said during each run (rides the catalog load).
import '../monitors.js'
import './gameday.js'
import './redis.js'
import './cron.js'
import './partition.js'
import './outbound.js'
