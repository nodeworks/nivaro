/**
 * The fault catalog's contents (#2827). Each area is one file with its `registerFault` calls;
 * a new area adds its file and ONE import line here. Importing this module fills the catalog.
 */
import './http.js'
import './socket.js'
import './redis.js'
import './cron.js'
import './partition.js'
import './outbound.js'
