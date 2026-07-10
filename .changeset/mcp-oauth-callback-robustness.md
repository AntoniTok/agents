---
"agents": patch
---

Harden the MCP client OAuth callback state machine against stray callbacks and stale auth URLs.

Previously, a stray or invalid GET to the OAuth callback URL carrying a well-formed but unverifiable state nonce — with either an `error` or a `code` param — flipped an in-flight `authenticating` connection to `failed` and cleared its `auth_url`, after which the user's genuine callback was rejected and the authorization could never complete for the lifetime of the Durable Object. `handleCallbackRequest` now verifies the state nonce via `authProvider.checkState()` before failing the connection: callbacks whose nonce cannot be verified are logged and answered with an error without touching the connection state, and a genuine callback can still complete a connection that was spuriously moved to `failed`.

Separately, `addMcpServer` on an `authenticating` connection kept returning an auth URL whose embedded state nonce had expired (the nonce TTL is 10 minutes) — both the persisted URL after a hibernation and the connection's live in-memory URL when the flow simply sat idle — so an OAuth flow not completed within the TTL became unrecoverable. An auth URL is now only returned while its nonce is still redeemable; otherwise `addMcpServer` reconnects and mints a fresh one.
