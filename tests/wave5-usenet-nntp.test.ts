import { afterEach, describe, expect, it } from "vitest";
import { appendFileSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer, type Server, type TLSSocket } from "node:tls";
import type { AddressInfo } from "node:net";

import {
  MemoryNntpEngine,
  MemoryNntpTransport,
  MemoryPar2Repairer,
  MemoryUnpacker,
  crc32,
  parseNzb,
  type NntpServerConfig,
} from "../plugins/usenet-native/src/engine.js";
import { encodeYenc } from "../plugins/usenet-native/src/fixtures.js";
import { NntpError, TlsNntpTransport } from "../plugins/usenet-native/src/nntp.js";

const CERT = readFileSync(resolve("tests/fixtures/usenet/localhost-cert.pem"), "utf8");
const KEY = readFileSync(resolve("tests/fixtures/usenet/localhost-key.pem"), "utf8");
const SECRET = "fixture-password-that-must-not-leak";

interface FixtureOptions {
  readonly article?: string;
  readonly password?: string;
  readonly authResponse?: string;
  readonly articleDelayMs?: number;
  readonly stallArticle?: boolean;
  readonly stallFirstArticle?: boolean;
}

interface NntpFixture {
  readonly port: number;
  readonly commands: string[];
  readonly connections: () => number;
  close(): Promise<void>;
}

const activeFixtures: NntpFixture[] = [];

async function startFixture(options: FixtureOptions = {}): Promise<NntpFixture> {
  const commands: string[] = [];
  const sockets = new Set<TLSSocket>();
  let connectionCount = 0;
  const server: Server = createServer({ key: KEY, cert: CERT }, (socket) => {
    connectionCount += 1;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.setEncoding("latin1");
    socket.write("200 fixture NNTP ready\r\n", "latin1");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const end = buffer.indexOf("\r\n");
        if (end < 0) break;
        const command = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        commands.push(command);
        if (command === "AUTHINFO USER fixture-user") {
          socket.write("381 password required\r\n", "latin1");
        } else if (command.startsWith("AUTHINFO PASS ")) {
          socket.write(
            options.authResponse ?? (command === `AUTHINFO PASS ${options.password ?? SECRET}`
              ? "281 authentication accepted\r\n"
              : "481 authentication rejected\r\n"),
            "latin1",
          );
        } else if (command === "ARTICLE <missing@fixture.invalid>") {
          socket.write("430 no such article\r\n", "latin1");
        } else if (command.startsWith("ARTICLE ")) {
          if (options.stallArticle || (options.stallFirstArticle && commands.filter(c => c.startsWith("ARTICLE ")).length === 1)) continue;
          const respond = () => {
            const body = (options.article ?? "fixture body")
              .split(/\r?\n/)
              .map((line) => (line.startsWith(".") ? `.${line}` : line))
              .join("\r\n");
            socket.write(`220 article follows\r\nMessage-ID: <fixture@fixture.invalid>\r\n\r\n${body}\r\n.\r\n`, "latin1");
          };
          if (options.articleDelayMs) setTimeout(respond, options.articleDelayMs);
          else respond();
        } else if (command === "QUIT") {
          socket.end("205 closing connection\r\n", "latin1");
        } else {
          socket.write("500 unsupported command\r\n", "latin1");
        }
      }
    });
  });
  server.on("tlsClientError", () => {});
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  const port = (server.address() as AddressInfo).port;
  const fixture: NntpFixture = {
    port,
    commands,
    connections: () => connectionCount,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    },
  };
  activeFixtures.push(fixture);
  return fixture;
}

function transportFor(fixture: NntpFixture, overrides: Record<string, unknown> = {}): TlsNntpTransport {
  return new TlsNntpTransport({
    name: "local fixture",
    host: "127.0.0.1",
    port: fixture.port,
    tls: true,
    username: "fixture-user",
    password: SECRET,
    priority: 0,
    maxConnections: 2,
    ca: CERT,
    ...overrides,
  });
}

afterEach(async () => {
  await Promise.all(activeFixtures.splice(0).map((fixture) => fixture.close()));
});

describe("certificate-validating NNTP transport", () => {
  it("reconnects and retries a timed-out article without failing the download", async () => {
    const fixture = await startFixture({ stallFirstArticle: true });
    const transport = transportFor(fixture, { responseTimeoutMs: 250 });
    try {
      expect((await transport.article("fixture@fixture.invalid")).body).toBe("fixture body\r\n");
      expect(fixture.connections()).toBe(2);
    } finally { await transport.close(); }
  });
  it("authenticates and fetches an ARTICLE body over implicit TLS", async () => {
    const fixture = await startFixture({ article: "first\r\n..already-dot-stuffed" });
    const transport = transportFor(fixture);
    const article = await transport.article("fixture@fixture.invalid");
    await transport.close();

    expect(article.messageId).toBe("<fixture@fixture.invalid>");
    expect(article.body).toBe("first\r\n..already-dot-stuffed\r\n");
    expect(fixture.commands.slice(0, 3)).toEqual([
      "AUTHINFO USER fixture-user",
      `AUTHINFO PASS ${SECRET}`,
      "ARTICLE <fixture@fixture.invalid>",
    ]);
  });

  it("rejects an untrusted certificate", async () => {
    const fixture = await startFixture();
    const transport = transportFor(fixture, { ca: undefined });
    await expect(transport.connect()).rejects.toMatchObject({ code: "NNTP_CERTIFICATE" });
    await transport.close();
  });

  it.each([
    ["481 authentication rejected", "access rejected"],
    ["502 too many connections", "connection limit reached"],
    ["502 download limit exceeded", "account download limit reached"],
    ["502 account suspended", "account inactive"],
    ["481 invalid password", "credentials rejected"],
  ])("reports %s without exposing credentials", async (response, reason) => {
    const fixture = await startFixture({ authResponse: `${response} ${SECRET}\r\n` });
    const transport = transportFor(fixture);
    let error: NntpError | null = null;
    try {
      await transport.connect();
    } catch (caught) {
      error = caught as NntpError;
    }
    await transport.close();
    expect(error?.code).toBe("NNTP_AUTH_FAILED");
    expect(error?.message).toContain(reason);
    expect(error?.message).not.toContain(SECRET);
  });

  it("reuses the connection after missing articles instead of exhausting provider connections", async () => {
    const fixture = await startFixture();
    const transport = transportFor(fixture);
    try {
      for (let i = 0; i < 3; i++) {
        await expect(transport.article("missing@fixture.invalid")).rejects.toMatchObject({ code: "ARTICLE_MISSING" });
      }
      expect((await transport.article("fixture@fixture.invalid")).body).toContain("fixture body");
      expect(fixture.connections()).toBe(1);
    } finally {
      await transport.close();
    }
  });

  it("bounds stalled ARTICLE responses and oversized bodies", async () => {
    const stalled = await startFixture({ stallArticle: true });
    const timeoutTransport = transportFor(stalled, { responseTimeoutMs: 250 });
    await expect(timeoutTransport.article("fixture@fixture.invalid")).rejects.toMatchObject({
      code: "NNTP_RESPONSE_TIMEOUT",
    });
    await timeoutTransport.close();

    const large = await startFixture({ article: "x".repeat(2_048) });
    const sizeTransport = transportFor(large, { maxArticleBytes: 1_024 });
    await expect(sizeTransport.article("fixture@fixture.invalid")).rejects.toMatchObject({
      code: "NNTP_RESPONSE_TOO_LARGE",
    });
    await sizeTransport.close();
  });

  it("uses no more than the configured number of connections", async () => {
    const fixture = await startFixture({ article: "bounded", articleDelayMs: 50 });
    const transport = transportFor(fixture, { maxConnections: 2 });
    await Promise.all([
      transport.article("one@fixture.invalid"),
      transport.article("two@fixture.invalid"),
      transport.article("three@fixture.invalid"),
      transport.article("four@fixture.invalid"),
    ]);
    await transport.close();
    expect(fixture.connections()).toBe(2);
  });
});

function memoryServer(): NntpServerConfig {
  return {
    name: "memory fixture",
    host: "fixture.invalid",
    port: 563,
    tls: true,
    username: "fixture-user",
    password: SECRET,
    priority: 0,
    maxConnections: 1,
  };
}

function engineFor(articles: ReadonlyMap<string, string>): MemoryNntpEngine {
  const server = memoryServer();
  return new MemoryNntpEngine({
    servers: [server],
    transports: [new MemoryNntpTransport(server, articles)],
    repairer: new MemoryPar2Repairer(new Map()),
    unpacker: new MemoryUnpacker(new Map()),
  });
}

it("completes intact video when optional NFO articles are missing and PAR2 files are present", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tantalar-usenet-sidecars-"));
  const nzbPath = join(dir, "release.nzb");
  const payload = Buffer.from("verified synthetic video payload");
  writeFileSync(nzbPath, `<nzb>${["release.nfo", "release.par2", "release.mkv"].map((file, i) => `<file subject="${file}"><segments><segment bytes="${payload.length}" number="1">part-${i}@fixture.invalid</segment></segments></file>`).join("")}</nzb>`);
  const articles = new Map([["part-2@fixture.invalid", encodeYenc(payload, "release.mkv", 1, 1)]]);
  const first = engineFor(articles);
  const added = await first.add({ sourceKind: "nzb-path", sourcePath: nzbPath, downloadPath: join(dir, "download") });
  await first.advance(added.id);
  expect(first.get(added.id)?.state).not.toBe("failed");
  const resume = first.snapshot(added.id);
  await first.close();
  const engine = engineFor(articles);
  const restored = await engine.add({ sourceKind: "nzb-path", sourcePath: nzbPath, downloadPath: join(dir, "download"), resume });
  for (let i = 0; i < 3; i++) await engine.advance(restored.id);
  expect(engine.get(restored.id)?.state).toBe("completed");
  expect(engine.get(restored.id)?.outputFiles).toEqual(["release.mkv"]);
  expect(readFileSync(join(dir, "download/release.mkv"))).toEqual(payload);
  await engine.close();

  const missing = engineFor(new Map());
  const bad = await missing.add({ sourceKind: "nzb-path", sourcePath: nzbPath, downloadPath: join(dir, "missing") });
  for (let i = 0; i < 3; i++) await missing.advance(bad.id);
  expect(missing.get(bad.id)?.state).toBe("failed");
  expect(missing.get(bad.id)?.failureReason).toMatch(/unavailable on all configured servers/);
  await missing.close();
});

function twoSegmentFixture(dir: string): { nzbPath: string; articles: Map<string, string>; payload: Buffer; fileName: string } {
  const fileName = "resume-fixture.bin";
  const first = Buffer.from("first legal fixture segment\n", "utf8");
  const second = Buffer.from("second legal fixture segment\n", "utf8");
  const payload = Buffer.concat([first, second]);
  const firstBody = encodeYenc(first, fileName, 1, 2).replace(
    `crc32=${crc32(first)}`,
    `pcrc32=${crc32(first)}`,
  );
  const secondBody = encodeYenc(second, fileName, 2, 2).replace(
    `crc32=${crc32(second)}`,
    `pcrc32=${crc32(second)} crc32=${crc32(payload)}`,
  );
  const nzbPath = join(dir, "resume.nzb");
  writeFileSync(
    nzbPath,
    `<nzb><file subject="${fileName} (1/2)"><groups><group>alt.binaries.fixture</group></groups><segments>` +
      `<segment bytes="${first.length}" number="1">&lt;one@fixture.invalid&gt;</segment>` +
      `<segment bytes="${second.length}" number="2">&lt;two@fixture.invalid&gt;</segment>` +
      `</segments></file></nzb>`,
  );
  return {
    nzbPath,
    articles: new Map([
      ["<one@fixture.invalid>", firstBody],
      ["<two@fixture.invalid>", secondBody],
    ]),
    payload,
    fileName,
  };
}

it("keeps the event loop responsive during final file verification", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tantalar-usenet-checksum-"));
  const fixture = twoSegmentFixture(dir);
  const engine = engineFor(fixture.articles);
  const added = await engine.add({ sourceKind: "nzb-path", sourcePath: fixture.nzbPath, downloadPath: join(dir, "download") });
  try {
    await engine.advance(added.id);
    let responsive = false;
    setImmediate(() => { responsive = true; });
    await engine.advance(added.id);
    expect(engine.get(added.id)?.state).toBe("completed");
    expect(responsive).toBe(true);
  } finally {
    await engine.close();
  }
});

describe("safe segment-boundary persistence", () => {
  it("keeps a restored paused job idle until explicitly resumed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tantalar-paused-resume-"));
    const fixture = twoSegmentFixture(dir);
    const first = engineFor(fixture.articles);
    const source = { sourceKind: "nzb-path" as const, sourcePath: fixture.nzbPath, downloadPath: join(dir, "download") };
    const added = await first.add(source);
    await first.advance(added.id);
    first.pause(added.id);
    const resume = first.snapshot(added.id);
    await first.close();
    const restored = engineFor(fixture.articles);
    try {
      const job = await restored.add({ ...source, resume });
      await restored.advance(job.id);
      expect(restored.get(job.id)).toMatchObject({ state: "paused", receivedBytes: resume.receivedBytes });
      restored.resume(job.id);
      await restored.advance(job.id);
      expect(restored.get(job.id)?.state).toBe("completed");
    } finally { await restored.close(); }
  });

  it("fails without a configured transport instead of generating bytes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tantalar-usenet-no-transport-"));
    const fixture = twoSegmentFixture(dir);
    const engine = new MemoryNntpEngine({
      servers: [],
      transports: [],
      repairer: new MemoryPar2Repairer(new Map()),
      unpacker: new MemoryUnpacker(new Map()),
    });
    const added = await engine.add({
      sourceKind: "nzb-path",
      sourcePath: fixture.nzbPath,
      downloadPath: join(dir, "job-1"),
    });
    await engine.advance(added.id);
    expect(engine.get(added.id)).toMatchObject({
      state: "failed",
      failureReason: "no NNTP servers are configured",
      receivedBytes: 0,
    });
    await engine.close();
  });

  it("resumes from the durable segment checkpoint without duplicate bytes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tantalar-usenet-resume-"));
    const jobRoot = join(dir, "job-1");
    const fixture = twoSegmentFixture(dir);
    const firstEngine = engineFor(fixture.articles);
    const added = await firstEngine.add({
      sourceKind: "nzb-path",
      sourcePath: fixture.nzbPath,
      downloadPath: jobRoot,
    });
    await firstEngine.advance(added.id);
    const resume = firstEngine.snapshot(added.id);
    expect(resume.segmentsDone).toBe(1);
    appendFileSync(join(jobRoot, fixture.fileName), "uncommitted-tail");
    await firstEngine.close();

    const resumedEngine = engineFor(fixture.articles);
    const resumed = await resumedEngine.add({
      sourceKind: "nzb-path",
      sourcePath: fixture.nzbPath,
      downloadPath: jobRoot,
      resume,
    });
    await resumedEngine.advance(resumed.id);
    expect(resumedEngine.get(resumed.id)?.state).toBe("completed");
    expect(readFileSync(join(jobRoot, fixture.fileName)).equals(fixture.payload)).toBe(true);
    await resumedEngine.close();
  });

  it("rejects traversal and duplicate NZB output names", () => {
    expect(() =>
      parseNzb(
        `<nzb><file subject="../escape.bin (1/1)"><segments><segment bytes="1" number="1">x</segment></segments></file></nzb>`,
      ),
    ).toThrow(/unsafe output filename/);
    expect(() =>
      parseNzb(
        `<nzb><file subject="same.bin (1/1)"><segments><segment bytes="1" number="1">x</segment></segments></file>` +
          `<file subject="SAME.BIN (1/1)"><segments><segment bytes="1" number="1">y</segment></segments></file></nzb>`,
      ),
    ).toThrow(/duplicate output filename/);
  });

  it("decodes XML entities and accepts standard segment attribute order", () => {
    const parsed = parseNzb(
      `<nzb><file subject="poster &quot;safe-file.bin&quot; (1/1)"><segments>` +
        `<segment number="1" bytes="12">&lt;safe&amp;id@fixture.invalid&gt;</segment>` +
        `</segments></file></nzb>`,
    );
    expect(parsed.files[0]).toMatchObject({
      fileName: "safe-file.bin",
      segments: [{ bytes: 12, number: 1, messageId: "<safe&id@fixture.invalid>" }],
    });
  });

  it("refuses a symlink output target before any article is fetched", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tantalar-usenet-symlink-"));
    const jobRoot = join(dir, "job-1");
    const fixture = twoSegmentFixture(dir);
    writeFileSync(join(dir, "outside.bin"), "outside");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(jobRoot);
    symlinkSync(join(dir, "outside.bin"), join(jobRoot, fixture.fileName));
    const engine = engineFor(fixture.articles);
    await expect(
      engine.add({ sourceKind: "nzb-path", sourcePath: fixture.nzbPath, downloadPath: jobRoot }),
    ).rejects.toThrow(/not a regular file/);
    await engine.close();
  });
});
