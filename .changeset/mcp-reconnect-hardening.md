---
"agents": patch
---

MCP client: reconnect hardening — retry failed connections, settle in-flight restores before id migration, close replaced connections

- The per-server `retry` options (and their defaults) now apply to actual
  connection failures. `connectToServer` reports a failed connect as a
  resolved value rather than a throw, so the retry wrapper never engaged and a
  single transient error during hibernation restore or post-OAuth reconnect
  left the connection failed for the lifetime of the Durable Object. Failed
  attempts now retry with the configured backoff before settling; connections
  parked on OAuth (`authenticating`) are not retried.
- `migrateServerId` now waits for an in-flight background restore of the old
  id to settle before renaming. Previously, adopting a stable id via
  `addMcpServer(name, url, { id })` on the same wake could rename the
  connection out from under the restore's discovery step, leaving the server
  connected but with no tools until the next wake. Pending-connection
  tracking now also follows the rename, so `waitForConnections()` keeps
  accounting for the migrated server.
- `connect()` now closes an existing connection before replacing it, instead
  of dropping it from the connection map with its transport (and any
  server-side session) still open.
