import { expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The download worker saves the resume state every 250 ms. A worker save
// that read the state before a new job was added must not erase that job.
it("keeps a newly added Usenet job when the worker saves the resume state concurrently", async () => {
  const root = mkdtempSync(join(tmpdir(), "tantalar-resume-race-"));
  process.env.TANTALAR_SECRET_TEST_USENET_PASSWORD = "fixture-password";
  process.env.TANTALAR_PLUGIN_CONFIG = JSON.stringify({
    downloadRoots: [root],
    servers: [{ id: "fixture", name: "Fixture", host: "127.0.0.1", port: 9, tls: "implicit", username: "fixture", passwordEnv: "TANTALAR_SECRET_TEST_USENET_PASSWORD", priority: 0, connections: 1 }],
  });
  const { default: plugin } = await import("../plugins/usenet-native/src/plugin.js");
  const client = plugin.handlers["dev.tantalar.capability.download-client"]!;

  // Storage applies writes in arrival order, like the core storage channel.
  // The first write that contains the new job is held until the worker has
  // read the state twice, which reproduces the lost-update interleaving.
  const docs = new Map<string, unknown>();
  let reads = 0;
  let releaseAt = Number.POSITIVE_INFINITY;
  let release: (() => void) | undefined;
  let held = false;
  let writes: Promise<void> = Promise.resolve();
  const storage = {
    get: async (key: string) => {
      reads++;
      if (reads >= releaseAt) release?.();
      const doc = docs.get(key);
      return doc === undefined ? null : { doc: structuredClone(doc), updatedAt: new Date().toISOString() };
    },
    put: (key: string, doc: unknown) => {
      const snapshot = structuredClone(doc) as { jobs?: Record<string, unknown> };
      let gate = Promise.resolve();
      if (key === "resume-state" && snapshot.jobs?.["un-0001"] && !held) {
        held = true;
        releaseAt = reads + 2;
        gate = new Promise<void>(done => { release = done; setTimeout(done, 1500); });
      }
      const write = writes.then(() => gate).then(() => { docs.set(key, snapshot); });
      writes = write;
      return write;
    },
    delete: async (key: string) => docs.delete(key),
  };
  const ctx = {
    pluginId: "dev.tantalar.plugin.usenet-native",
    config: {},
    emit: async () => undefined,
    log: () => undefined,
    invoke: async () => ({ allowDispatch: true }),
    storage,
  } as unknown as Parameters<NonNullable<typeof plugin.mount>>[0];

  const nzbPath = join(root, "fixture.nzb");
  writeFileSync(nzbPath, '<nzb><file subject="Fixture.zip"><segments><segment number="1" bytes="10">fixture@fixture.invalid</segment></segments></file></nzb>');
  await plugin.mount!(ctx);
  try {
    const added = await client("add", { kind: "nzb", itemKey: "movie-fixture", title: "Fixture", sourceUrl: nzbPath }) as { downloadId: string };
    expect(added.downloadId).toBe("un-0001");
    // Let the worker run a few more cycles after the held write is released.
    await new Promise(done => setTimeout(done, 2000));
    await writes;
    expect(Object.keys((docs.get("resume-state") as { jobs: Record<string, unknown> }).jobs)).toContain("un-0001");
    await expect(client("status", { downloadId: "un-0001" })).resolves.toMatchObject({ downloadId: "un-0001" });
  } finally {
    await plugin.unmount!(ctx);
    rmSync(root, { recursive: true, force: true });
  }
});
