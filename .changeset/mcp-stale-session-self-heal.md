---
"agents": patch
---

Recover MCP streamable-http connections whose persisted session expired on the server.

A streamable-http session id is persisted on connect and fed back into the transport when the Agent wakes from hibernation. The MCP SDK skips the initialize handshake when resuming a session, so if the server had restarted or expired that session in the meantime, the connection reported `connected` while every request — including discovery — was rejected with HTTP 404. The stale session id was never cleared, so the connection stayed wedged with no tools across every subsequent wake until the server was removed and re-added.

Discovery on a resumed session that fails with a 404 now clears the stale session id from memory and storage and reconnects — performing a fresh initialize handshake without a session ID, as the MCP spec requires — then runs discovery once on the new session. A 404 on a session negotiated in the current lifetime is still reported as a plain discovery failure and does not trigger reconnection.
