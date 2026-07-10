import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../worker";
import { MCPClientManager } from "../../mcp/client";
import { MCPClientConnection } from "../../mcp/client-connection";
import type { MCPServerRow } from "../../mcp/client-storage";

type RecordedRequest = {
  method: string;
  url: string;
  sessionId: string | null;
};

function createManagerStorage() {
  const rows = new Map<string, MCPServerRow>();
  const kv = new Map<string, unknown>();

  const exec = <T extends Record<string, SqlStorageValue>>(
    query: string,
    ...values: SqlStorageValue[]
  ) => {
    const results: T[] = [];
    const normalizedQuery = query.replace(/\s+/g, " ").trim();

    if (
      normalizedQuery.startsWith("INSERT OR REPLACE INTO cf_agents_mcp_servers")
    ) {
      const row: MCPServerRow = {
        id: values[0] as string,
        name: values[1] as string,
        server_url: values[2] as string,
        client_id: values[3] as string | null,
        auth_url: values[4] as string | null,
        callback_url: values[5] as string,
        server_options: values[6] as string | null
      };
      rows.set(row.id, row);
    } else if (
      normalizedQuery ===
      "SELECT id, name, server_url, client_id, auth_url, callback_url, server_options FROM cf_agents_mcp_servers"
    ) {
      results.push(...(Array.from(rows.values()) as unknown as T[]));
    } else if (
      normalizedQuery ===
      "SELECT server_options FROM cf_agents_mcp_servers WHERE id = ?"
    ) {
      const row = rows.get(values[0] as string);
      if (row) {
        results.push({
          server_options: row.server_options
        } as unknown as T);
      }
    } else if (
      normalizedQuery ===
      "UPDATE cf_agents_mcp_servers SET auth_url = NULL WHERE id = ?"
    ) {
      const row = rows.get(values[0] as string);
      if (row) {
        row.auth_url = null;
        rows.set(row.id, row);
      }
    } else if (
      normalizedQuery === "DELETE FROM cf_agents_mcp_servers WHERE id = ?"
    ) {
      rows.delete(values[0] as string);
    }

    return results[Symbol.iterator]();
  };

  const storage = {
    sql: { exec },
    get: async <T>(key: string) => kv.get(key) as T | undefined,
    put: async (key: string, value: unknown) => {
      kv.set(key, value);
    },
    kv: {
      get: <T>(key: string) => kv.get(key) as T | undefined,
      put: (key: string, value: unknown) => {
        kv.set(key, value);
      },
      list: vi.fn(),
      delete: vi.fn()
    }
  } as unknown as DurableObjectStorage;

  return { rows, storage };
}

function createRecordedFetch(): {
  fetch: typeof globalThis.fetch;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];

  const recordedFetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push({
      method: request.method,
      url: request.url,
      sessionId: request.headers.get("mcp-session-id")
    });

    const ctx = createExecutionContext();
    return worker.fetch(request, env, ctx);
  };

  return { fetch: recordedFetch, requests };
}

function getStoredSessionId(
  rows: Map<string, MCPServerRow>,
  serverId: string
): string | undefined {
  const serverOptions = JSON.parse(rows.get(serverId)?.server_options ?? "{}");
  return serverOptions.transport?.sessionId;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MCP streamable-http stale session recovery", () => {
  it("re-initializes without a session ID and rediscovers when the server expired a restored session", async () => {
    const { rows, storage } = createManagerStorage();
    const manager1 = new MCPClientManager("test-client", "1.0.0", {
      storage
    });
    const initialFetch = createRecordedFetch();
    const serverId = "stale-session-restore";
    const staleSessionId = "expired-session-id";
    let manager2: MCPClientManager | undefined;

    try {
      await manager1.registerServer(serverId, {
        url: "http://example.com/mcp",
        name: "Stale Session Server",
        callbackUrl: "http://localhost:3000/callback",
        client: {},
        transport: {
          type: "streamable-http",
          fetch: initialFetch.fetch
        }
      });

      const initialConnectResult = await manager1.connectToServer(serverId);
      expect(initialConnectResult.state).toBe("connected");
      expect(typeof getStoredSessionId(rows, serverId)).toBe("string");

      // Simulate hibernation: drop the live connection without terminating
      // the session, then replace the persisted session id with one the
      // server does not know — the server expired it while the DO slept.
      await manager1.mcpConnections[serverId].client.close();
      delete manager1.mcpConnections[serverId];

      const row = rows.get(serverId);
      expect(row?.server_options).not.toBeNull();
      const serverOptions = JSON.parse(row?.server_options ?? "{}");
      serverOptions.transport.sessionId = staleSessionId;
      if (row) {
        rows.set(serverId, {
          ...row,
          server_options: JSON.stringify(serverOptions)
        });
      }

      manager2 = new MCPClientManager("test-client", "1.0.0", {
        storage
      });
      const restoredFetch = createRecordedFetch();
      vi.stubGlobal("fetch", restoredFetch.fetch);

      await manager2.restoreConnectionsFromStorage("test-client");
      await manager2.waitForConnections({ timeout: 10000 });

      // The stale session was probed and rejected by the server...
      expect(
        restoredFetch.requests.some(
          (request) =>
            request.method === "POST" && request.sessionId === staleSessionId
        )
      ).toBe(true);

      // ...then exactly one fresh initialize ran without a session ID...
      expect(
        restoredFetch.requests.filter(
          (request) => request.method === "POST" && request.sessionId === null
        )
      ).toHaveLength(1);

      // ...and the connection came back healthy with discovered tools.
      const restoredConnection = manager2.mcpConnections[serverId];
      expect(restoredConnection).toBeDefined();
      expect(restoredConnection.connectionState).toBe("ready");
      expect(manager2.listTools().some((tool) => tool.name === "greet")).toBe(
        true
      );

      // Storage holds the new live session, not the expired one.
      const updatedSessionId = getStoredSessionId(rows, serverId);
      expect(typeof updatedSessionId).toBe("string");
      expect(updatedSessionId).not.toBe(staleSessionId);
    } finally {
      await manager1.closeAllConnections();
      if (manager2) {
        await manager2.closeAllConnections();
      }
    }
  });

  it("does not clear the session or re-initialize when a non-resumed session 404s during discovery", async () => {
    const { rows, storage } = createManagerStorage();
    const manager = new MCPClientManager("test-client", "1.0.0", {
      storage
    });
    const serverId = "non-resumed-404";
    const requests: RecordedRequest[] = [];
    let rejectSessionRequests = false;

    const fetchWithFailureMode: typeof globalThis.fetch = async (
      input,
      init
    ) => {
      const request = new Request(input, init);
      requests.push({
        method: request.method,
        url: request.url,
        sessionId: request.headers.get("mcp-session-id")
      });

      if (rejectSessionRequests && request.headers.get("mcp-session-id")) {
        return new Response("Not Found", { status: 404 });
      }

      const ctx = createExecutionContext();
      return worker.fetch(request, env, ctx);
    };

    try {
      await manager.registerServer(serverId, {
        url: "http://example.com/mcp",
        name: "Non-Resumed 404 Server",
        callbackUrl: "http://localhost:3000/callback",
        client: {},
        transport: {
          type: "streamable-http",
          fetch: fetchWithFailureMode
        }
      });

      const connectResult = await manager.connectToServer(serverId);
      expect(connectResult.state).toBe("connected");

      const persistedSessionId = getStoredSessionId(rows, serverId);
      expect(typeof persistedSessionId).toBe("string");

      rejectSessionRequests = true;
      const discoverResult = await manager.discoverIfConnected(serverId);

      // A 404 on a session negotiated in this lifetime is a plain discovery
      // failure — no self-heal, so no second initialize handshake runs.
      expect(discoverResult?.success).toBe(false);
      expect(discoverResult?.state).toBe("connected");
      expect(
        requests.filter(
          (request) => request.method === "POST" && request.sessionId === null
        )
      ).toHaveLength(1);
      expect(getStoredSessionId(rows, serverId)).toBe(persistedSessionId);
    } finally {
      rejectSessionRequests = false;
      await manager.closeAllConnections();
    }
  });

  it("does not mistake a JSON-RPC application error code for an HTTP 404", async () => {
    const connection = new MCPClientConnection(
      new URL("http://example.com/mcp"),
      { name: "test-client", version: "1.0.0" },
      {
        client: {},
        transport: {
          type: "streamable-http",
          sessionId: "live-restored-session"
        }
      }
    );

    connection.client.connect = vi.fn().mockResolvedValue(undefined);
    connection.client.getServerCapabilities = vi
      .fn()
      .mockReturnValue(undefined);
    connection.client.getInstructions = vi.fn().mockReturnValue(undefined);
    connection.client.listTools = vi
      .fn()
      .mockRejectedValue(new McpError(404, "Application resource not found"));
    connection.client.listResources = vi
      .fn()
      .mockResolvedValue({ resources: [] });
    connection.client.listPrompts = vi.fn().mockResolvedValue({ prompts: [] });
    connection.client.listResourceTemplates = vi
      .fn()
      .mockResolvedValue({ resourceTemplates: [] });
    connection.client.setNotificationHandler = vi.fn();

    await connection.init();
    const result = await connection.discover();

    expect(result.success).toBe(false);
    expect(result.error).toContain("Application resource not found");
    expect(result).not.toHaveProperty("staleSession");
  });

  it("clears storage before attempting the fresh connection", async () => {
    const { rows, storage } = createManagerStorage();
    const manager = new MCPClientManager("test-client", "1.0.0", {
      storage
    });
    const serverId = "offline-after-stale-session";

    await manager.registerServer(serverId, {
      url: "http://example.com/mcp",
      name: "Offline Stale Session Server",
      transport: { type: "streamable-http" }
    });

    const row = rows.get(serverId);
    const serverOptions = JSON.parse(row?.server_options ?? "{}");
    serverOptions.transport.sessionId = "expired-session-id";
    if (row) {
      rows.set(serverId, {
        ...row,
        server_options: JSON.stringify(serverOptions)
      });
    }

    const connection = manager.mcpConnections[serverId];
    connection.connectionState = "connected";
    connection.discover = vi.fn().mockResolvedValue({
      success: false,
      error: "Streamable HTTP error: unknown session",
      staleSession: true
    });
    const clearResumedSession = vi.spyOn(connection, "clearResumedSession");
    vi.spyOn(manager, "connectToServer").mockRejectedValue(
      new Error("server remained offline")
    );

    const result = await manager.discoverIfConnected(serverId);

    expect(result).toMatchObject({
      success: false,
      error: "server remained offline"
    });
    expect(clearResumedSession).toHaveBeenCalledOnce();
    expect(getStoredSessionId(rows, serverId)).toBeUndefined();
  });
});
