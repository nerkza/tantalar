import { expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArchiveUnpacker, Par2FileRepairer, postprocessTools } from "../plugins/usenet-native/src/postprocess.js";
import { MemoryNntpEngine, MemoryNntpTransport, crc32, type NntpServerConfig } from "../plugins/usenet-native/src/engine.js";
import { encodeYenc } from "../plugins/usenet-native/src/fixtures.js";

const limit = 64 * 1024 * 1024;

it("extracts a real RAR5 archive", async () => {
  const root = mkdtempSync(join(tmpdir(), "tantalar-rar5-"));
  try {
    // Tiny generated fixture from libarchive/libarchive: test_read_format_rar5_stored.rar.uu.
    const data = "UmFyIRoHAQAzkrXlCgEFBgAFAQGAgAA4MAZjLAIDC50ABJ0ApIMCtEOglYAAAQ5oZWxsb3dvcmxkLnR4dAoDE34Oq1tW6Q4aaGVsbG8gbGliYXJjaGl2ZSB0ZXN0IHN1aXRlIQodd1ZRAwUEAA==";
    writeFileSync(join(root, "fixture.rar"), Buffer.from(data, "base64"));
    const result = await new ArchiveUnpacker(limit, 0).unpack(join(root, "fixture.rar"), root);
    expect(result.unpacked).toBe(true);
    expect(readFileSync(join(root, "helloworld.txt"), "utf8")).toBe("hello libarchive test suite!\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("repairs a damaged multipart archive, extracts it, and completes with exact video bytes", async () => {
  expect(postprocessTools.par2, "Install par2cmdline for the integration tests").toBeTruthy();
  expect(postprocessTools.archive, "Install 7-Zip for the integration tests").toBeTruthy();
  const root = mkdtempSync(join(tmpdir(), "tantalar-postprocess-"));
  const payload = randomBytes(128 * 1024);
  writeFileSync(join(root, "movie.mp4"), payload);
  execFileSync(postprocessTools.archive!, ["a", "-v32k", "movie.7z", "movie.mp4"], { cwd: root, stdio: "pipe" });
  const volumes = readdirSync(root).filter(name => /^movie\.7z\.\d+$/.test(name));
  execFileSync(postprocessTools.par2!, ["c", "-q", "-s4096", "-r100", "movie.par2", ...volumes], { cwd: root, stdio: "pipe" });
  const files = readdirSync(root).filter(name => /\.par2$|\.7z\.\d+$/.test(name)).sort();
  const articles = new Map<string, string>();
  let id = 0;
  const xml = files.map(name => {
    const data = readFileSync(join(root, name));
    const chunks = Array.from({ length: Math.ceil(data.length / 4096) }, (_, n) => data.subarray(n * 4096, (n + 1) * 4096));
    return `<file subject="${name}"><segments>${chunks.map((chunk, n) => {
      const messageId = `part-${id++}@fixture.invalid`;
      if (!(name === volumes[0] && n === 1)) articles.set(messageId, encodeYenc(chunk, name, n + 1, chunks.length).replace(`crc32=${crc32(chunk)}`, `pcrc32=${crc32(chunk)}${n === chunks.length - 1 ? ` crc32=${crc32(data)}` : ""}`));
      return `<segment number="${n + 1}" bytes="${chunk.length}">${messageId}</segment>`;
    }).join("")}</segments></file>`;
  }).join("");
  writeFileSync(join(root, "movie.nzb"), `<nzb>${xml}</nzb>`);
  const server: NntpServerConfig = { name: "fixture", host: "localhost", port: 563, tls: true, username: "fixture", password: "fixture", priority: 0, maxConnections: 1 };
  const deps = { servers: [server], transports: [new MemoryNntpTransport(server, articles)], repairer: new Par2FileRepairer(limit, 0), unpacker: new ArchiveUnpacker(limit, 0) };
  let engine = new MemoryNntpEngine(deps);
  try {
    const source = { sourceKind: "nzb-path" as const, sourcePath: join(root, "movie.nzb"), downloadPath: join(root, "download") };
    const job = await engine.add(source);
    await engine.advance(job.id);
    await engine.advance(job.id);
    const resume = engine.snapshot(job.id);
    expect(resume.needsRepair).toBe(true);
    await engine.close();
    engine = new MemoryNntpEngine(deps);
    await engine.add({ ...source, resume });
    for (let i = 0; i <= job.segmentsTotal + 1; i++) await engine.advance(job.id);
    expect(engine.get(job.id)?.failureReason).toBeUndefined();
    expect(engine.get(job.id)?.state).toBe("completed");
    expect(engine.get(job.id)?.repair?.repaired).toBe(true);
    expect(engine.get(job.id)?.outputFiles).toContain("movie.mp4");
    expect(readFileSync(join(root, "download/movie.mp4"))).toEqual(payload);
    const again = await new ArchiveUnpacker(limit, 0).unpack(join(root, "download", volumes[0]!), join(root, "download"));
    expect(again.unpacked).toBe(true);
  } finally { await engine.close(); rmSync(root, { recursive: true, force: true }); }
});

it("rejects archive links, oversized extraction, and PAR2 references outside the download", async () => {
  const root = mkdtempSync(join(tmpdir(), "tantalar-postprocess-safety-"));
  try {
    writeFileSync(join(root, "data.mp4"), randomBytes(1024));
    execFileSync(postprocessTools.archive!, ["a", "data.zip", "data.mp4"], { cwd: root, stdio: "pipe" });
    await expect(new ArchiveUnpacker(10, 0).unpack(join(root, "data.zip"), root)).rejects.toThrow(/size limit/);
    symlinkSync("/tmp", join(root, "outside"));
    execFileSync(postprocessTools.archive!, ["a", "-snl", "links.7z", "outside"], { cwd: root, stdio: "pipe" });
    await expect(new ArchiveUnpacker(limit, 0).unpack(join(root, "links.7z"), root)).rejects.toThrow(/links|special/);
    execFileSync(postprocessTools.par2!, ["c", "-q", "-s256", "-r100", "data.par2", "data.mp4"], { cwd: root, stdio: "pipe" });
    await expect(new Par2FileRepairer(limit, 0).repair(root, ["unrelated.mp4"])).rejects.toThrow(/outside this download/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("cancels extraction before pausing or removing a job", async () => {
  const root = mkdtempSync(join(tmpdir(), "tantalar-postprocess-cancel-"));
  const server: NntpServerConfig = { name: "fixture", host: "localhost", port: 563, tls: true, username: "fixture", password: "fixture", priority: 0, maxConnections: 1 };
  const articles = new Map([["archive@fixture.invalid", encodeYenc(Buffer.from("fixture"), "movie.zip")]]);
  writeFileSync(join(root, "movie.nzb"), '<nzb><file subject="movie.zip"><segments><segment number="1" bytes="7">archive@fixture.invalid</segment></segments></file></nzb>');
  let entered!: () => void;
  let started = new Promise<void>(done => { entered = done; });
  const signals: AbortSignal[] = [];
  const engine = new MemoryNntpEngine({ servers: [server], transports: [new MemoryNntpTransport(server, articles)], repairer: new Par2FileRepairer(limit, 0), unpacker: { unpack: async (_path, _root, signal) => {
    signals.push(signal!);
    entered();
    return new Promise((_done, reject) => signal!.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
  } } });
  try {
    const job = await engine.add({ sourceKind: "nzb-path", sourcePath: join(root, "movie.nzb"), downloadPath: join(root, "download") });
    const first = engine.advance(job.id);
    await started;
    engine.pause(job.id);
    await first;
    expect(signals[0]?.aborted).toBe(true);
    expect(engine.get(job.id)?.state).toBe("paused");
    started = new Promise<void>(done => { entered = done; });
    engine.resume(job.id);
    const second = engine.advance(job.id);
    await started;
    await engine.remove(job.id, { keepFiles: false });
    await second;
    expect(signals[1]?.aborted).toBe(true);
    expect(engine.get(job.id)).toBeUndefined();
  } finally { await engine.close(); rmSync(root, { recursive: true, force: true }); }
});
