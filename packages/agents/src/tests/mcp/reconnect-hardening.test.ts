import { afterEach, describe, expect, it, vi } from "vitest";
import type { MCPConnectionResult } from "../../mcp/client";
import { MCPClientManager } from "../../mcp/client";
import { MCPClientConnection } from "../../mcp/client-connection";
import type { MCPServerRow } from "../../mcp/client-storage";

function createMockStorage() {
  const rows = new Map<string, MCPServerRow>();
  const kv = new Map<string, unknown>();
  const exec = <T extends Record<string, SqlStorageValue>>(
    query: string,
    ...values: SqlStorageValue[]
  ) => {
    const results: T[] = [];
    if (query.includes("INSERT OR REPLACE")) {
      rows.set(values[0] as string, {
        id: values[0] as string,
        name: values[1] as string,
        server_url: values[2] as string,
        client_id: values[3] as string | null,
        auth_url: values[4] as string | null,
        callback_url: values[5] as string,
        server_options: values[6] as string | null
      });
    } else if (query.includes("UPDATE") && query.includes("SET id = ?")) {
      const [newId, oldId] = values as [string, string];
      const row = rows.get(oldId);
      if (row) {
        rows.delete(oldId);
        rows.set(newId, { ...row, id: newId });
      }
    } else if (query.includes("SELECT")) {
      if (query.includes("WHERE id = ?")) {
        const row = rows.get(values[0] as string);
        if (row) results.push(row as unknown as T);
      } else {
        results.push(...(Array.from(rows.values()) as unknown as T[]));
      }
    }
    return results[Symbol.iterator]();
  };
  const storage = {
    sql: { exec },
    get: async <T>(key: string) => kv.get(key) as T | undefined,
    put: async (key: string, value: unknown) => {
      kv.set(key, value);
    },
    list: async () => new Map(),
    kv: {
      get: <T>(key: string) => kv.get(key) as T | undefined,
      put: (key: string, value: unknown) => {
        kv.set(key, value);
      },
      list: vi.fn(),
      delete: vi.fn()
    }
  } as unknown as DurableObjectStorage;
  return { storage, rows };
}

function createDeferred<T>() {
  const bucket: { resolve?: (value: T | PromiseLike<T>) => void } = {};
  const promise = new Promise<T>((resolve) => {
    bucket.resolve = resolve;
  });
  return {
    promise,
    resolve: (value: T | PromiseLike<T>) => bucket.resolve?.(value)
  };
}

type ManagerInternals = {
  _trackConnection(serverId: string, promise: Promise<void>): void;
  _pendingConnections: Map<string, Promise<void>>;
  updateStoredSessionId(id: string, sessionId?: string): void;
};

describe("MCP reconnect hardening", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("per-server retry on connection failure", () => {
    it("restore retries a transiently failing connection until it connects", async () => {
      const { storage } = createMockStorage();
      const managerA = new MCPClientManager("test-client", "1.0.0", {
        storage
      });
      await managerA.registerServer("srv-retry", {
        url: "http://example.com/mcp",
        name: "example",
        retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 }
      });

      // Fresh manager over the same storage simulates a hibernation wake
      const managerB = new MCPClientManager("test-client", "1.0.0", {
        storage
      });
      const connectSpy = vi
        .spyOn(managerB, "connectToServer")
        .mockResolvedValueOnce({ state: "failed", error: "transient 500" })
        .mockResolvedValueOnce({ state: "failed", error: "transient 500" })
        .mockResolvedValueOnce({ state: "connected" });
      const discoverSpy = vi
        .spyOn(managerB, "discoverIfConnected")
        .mockResolvedValue({ success: true, state: "ready" });

      await managerB.restoreConnectionsFromStorage("test-client");
      await managerB.waitForConnections();

      expect(connectSpy).toHaveBeenCalledTimes(3);
      expect(discoverSpy).toHaveBeenCalledWith("srv-retry");
    });

    it("gives up after the configured attempts and leaves the failure resolved", async () => {
      const { storage } = createMockStorage();
      const managerA = new MCPClientManager("test-client", "1.0.0", {
        storage
      });
      await managerA.registerServer("srv-down", {
        url: "http://example.com/mcp",
        name: "example",
        retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 2 }
      });

      const managerB = new MCPClientManager("test-client", "1.0.0", {
        storage
      });
      const connectSpy = vi
        .spyOn(managerB, "connectToServer")
        .mockResolvedValue({ state: "failed", error: "server down" });
      const discoverSpy = vi
        .spyOn(managerB, "discoverIfConnected")
        .mockResolvedValue({ success: true, state: "ready" });

      await managerB.restoreConnectionsFromStorage("test-client");
      await managerB.waitForConnections();

      expect(connectSpy).toHaveBeenCalledTimes(2);
      expect(discoverSpy).not.toHaveBeenCalled();
    });

    it("does not retry a connection parked on OAuth", async () => {
      const { storage } = createMockStorage();
      const managerA = new MCPClientManager("test-client", "1.0.0", {
        storage
      });
      await managerA.registerServer("srv-oauth", {
        url: "http://example.com/mcp",
        name: "example",
        retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 }
      });

      const managerB = new MCPClientManager("test-client", "1.0.0", {
        storage
      });
      const connectSpy = vi
        .spyOn(managerB, "connectToServer")
        .mockResolvedValue({
          state: "authenticating",
          authUrl: "https://auth.example.com/authorize"
        });
      const discoverSpy = vi
        .spyOn(managerB, "discoverIfConnected")
        .mockResolvedValue({ success: true, state: "ready" });

      await managerB.restoreConnectionsFromStorage("test-client");
      await managerB.waitForConnections();

      expect(connectSpy).toHaveBeenCalledTimes(1);
      expect(discoverSpy).not.toHaveBeenCalled();
    });

    it("establishConnection retries through the same budget", async () => {
      const { storage } = createMockStorage();
      const manager = new MCPClientManager("test-client", "1.0.0", {
        storage
      });
      await manager.registerServer("srv-est", {
        url: "http://example.com/mcp",
        name: "example",
        retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 }
      });
      const conn = manager.mcpConnections["srv-est"];
      const discover = vi.fn(async () => {
        conn.connectionState = "ready";
        return { success: true };
      });
      conn.discover = discover;
      const connectSpy = vi
        .spyOn(manager, "connectToServer")
        .mockResolvedValueOnce({ state: "failed", error: "transient" })
        .mockResolvedValueOnce({ state: "connected" });

      await manager.establishConnection("srv-est");

      expect(connectSpy).toHaveBeenCalledTimes(2);
      expect(discover).toHaveBeenCalledTimes(1);
    });
  });

  describe("migrateServerId vs in-flight restore", () => {
    it("waits for the background restore so discovery lands before the rename", async () => {
      const { storage } = createMockStorage();
      const managerA = new MCPClientManager("test-client", "1.0.0", {
        storage
      });
      await managerA.registerServer("old-id", {
        url: "http://example.com/mcp",
        name: "example"
      });

      const managerB = new MCPClientManager("test-client", "1.0.0", {
        storage
      });
      const gate = createDeferred<MCPConnectionResult>();
      vi.spyOn(managerB, "connectToServer").mockImplementation(
        () => gate.promise
      );
      await managerB.restoreConnectionsFromStorage("test-client");

      const restored = managerB.mcpConnections["old-id"];
      expect(restored).toBeDefined();
      const discover = vi.fn(async () => {
        restored.connectionState = "ready";
        return { success: true };
      });
      restored.discover = discover;

      // onStart adopts a stable id while the restore is still mid-connect
      const migration = managerB.migrateServerId(
        "old-id",
        "github",
        "test-client"
      );
      gate.resolve({ state: "connected" });
      await migration;
      await managerB.waitForConnections();

      expect(discover).toHaveBeenCalledTimes(1);
      expect(managerB.mcpConnections.github).toBe(restored);
      expect(restored.connectionState).toBe("ready");
    });

    it("waits for connection work registered while migration is already waiting", async () => {
      const { storage } = createMockStorage();
      const manager = new MCPClientManager("test-client", "1.0.0", {
        storage
      });
      const internals = manager as unknown as ManagerInternals;

      const first = createDeferred<void>();
      internals._trackConnection("old-id", first.promise);

      let migrated = false;
      const migration = manager
        .migrateServerId("old-id", "github", "test-client")
        .then(() => {
          migrated = true;
        });

      // This task starts while migration is waiting on the first one. It also
      // closes over old-id, so migration must let it settle before renaming.
      const second = createDeferred<void>();
      internals._trackConnection("old-id", second.promise);
      first.resolve();
      await first.promise;
      await Promise.resolve();
      expect(migrated).toBe(false);

      second.resolve();
      await migration;

      expect(internals._pendingConnections.size).toBe(0);
    });

    it("completes the rename even if the tracked connection promise rejects", async () => {
      const { storage } = createMockStorage();
      const manager = new MCPClientManager("test-client", "1.0.0", {
        storage
      });
      await manager.registerServer("old-id", {
        url: "http://example.com/mcp",
        name: "example"
      });
      const internals = manager as unknown as ManagerInternals;

      // establishConnection promises are tracked in the same map as restores
      // and, unlike restores, can reject
      let rejectPending: ((error: Error) => void) | undefined;
      internals._trackConnection(
        "old-id",
        new Promise<void>((_, reject) => {
          rejectPending = reject;
        })
      );

      const migration = manager.migrateServerId(
        "old-id",
        "github",
        "test-client"
      );
      rejectPending?.(new Error("network connection lost"));

      await expect(migration).resolves.toBeUndefined();
      expect(manager.mcpConnections.github).toBeDefined();
      expect(manager.mcpConnections["old-id"]).toBeUndefined();
    });
  });

  describe("connect() drop-and-recreate", () => {
    it("closes the replaced connection instead of leaking its transport", async () => {
      const { storage } = createMockStorage();
      const manager = new MCPClientManager("test-client", "1.0.0", {
        storage
      });

      const replaced = new MCPClientConnection(
        new URL("http://example.com/mcp"),
        { name: "test-client", version: "1.0.0" },
        { transport: { type: "streamable-http" }, client: {} }
      );
      replaced.connectionState = "connected";
      const closeSpy = vi.fn(async () => {});
      replaced.close = closeSpy;
      manager.mcpConnections.dup = replaced;

      vi.spyOn(MCPClientConnection.prototype, "init").mockResolvedValue(
        undefined
      );
      vi.spyOn(manager, "discoverIfConnected").mockResolvedValue({
        success: true,
        state: "ready"
      });

      await manager.connect("http://example.com/mcp", {
        reconnect: { id: "dup" }
      });

      expect(manager.mcpConnections.dup).toBeDefined();
      expect(manager.mcpConnections.dup).not.toBe(replaced);
      expect(closeSpy).toHaveBeenCalledTimes(1);
    });

    it("clears the persisted sessionId when the replaced connection is closed", async () => {
      const { storage, rows } = createMockStorage();
      const manager = new MCPClientManager("test-client", "1.0.0", {
        storage
      });
      await manager.registerServer("dup", {
        url: "http://example.com/mcp",
        name: "example",
        transport: { type: "streamable-http" }
      });
      const internals = manager as unknown as ManagerInternals;
      internals.updateStoredSessionId("dup", "session-1");
      const before = JSON.parse(rows.get("dup")?.server_options ?? "{}");
      expect(before.transport?.sessionId).toBe("session-1");

      const replaced = manager.mcpConnections.dup;
      replaced.connectionState = "connected";
      replaced.close = vi.fn(async () => {});

      vi.spyOn(MCPClientConnection.prototype, "init").mockResolvedValue(
        undefined
      );
      vi.spyOn(manager, "discoverIfConnected").mockResolvedValue({
        success: true,
        state: "ready"
      });

      await manager.connect("http://example.com/mcp", {
        reconnect: { id: "dup" }
      });

      // close() terminated the session server-side — resuming session-1 on a
      // later restore would wedge, so the row must no longer carry it
      const after = JSON.parse(rows.get("dup")?.server_options ?? "{}");
      expect(after.transport?.sessionId).toBeUndefined();
    });
  });
});
