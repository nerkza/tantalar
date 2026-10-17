#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPaths = ["package.json", "apps/server/package.json", "apps/web/package.json"];
const derivedFiles = [
  ["Dockerfile", /ARG TANTALAR_BUILD_VERSION=([^\s]+)/],
  ["docker/compose.sqlite.yml", /TANTALAR_IMAGE_TAG:-([^}]+)/],
  ["docker/compose.postgres.yml", /TANTALAR_IMAGE_TAG:-([^}]+)/],
];
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function readJson(path) {
  return JSON.parse(readFileSync(resolve(root, path), "utf8"));
}

function writeJson(path, value) {
  writeFileSync(resolve(root, path), `${JSON.stringify(value, null, 2)}\n`);
}

function release() {
  const manifest = readJson("package.json");
  return {
    version: manifest.version,
    label: manifest.tantalarRelease?.label,
    channel: manifest.tantalarRelease?.channel,
  };
}

function check() {
  const current = release();
  const errors = [];
  if (!semver.test(current.version ?? "")) errors.push(`invalid SemVer: ${current.version}`);
  if (!current.label?.trim()) errors.push("missing tantalarRelease.label");
  if (!current.channel?.trim()) errors.push("missing tantalarRelease.channel");

  for (const path of manifestPaths.slice(1)) {
    const value = readJson(path).version;
    if (value !== current.version) errors.push(`${path} has ${value}; expected ${current.version}`);
  }
  for (const [path, pattern] of derivedFiles) {
    const match = readFileSync(resolve(root, path), "utf8").match(pattern);
    if (match?.[1] !== current.version) {
      errors.push(`${path} has ${match?.[1] ?? "no release version"}; expected ${current.version}`);
    }
  }
  for (const path of ["docker/compose.sqlite.yml", "docker/compose.postgres.yml"]) {
    const values = [...readFileSync(resolve(root, path), "utf8").matchAll(/TANTALAR_IMAGE_TAG:-([^}]+)/g)]
      .map((match) => match[1]);
    if (values.length !== 2 || values.some((value) => value !== current.version)) {
      errors.push(`${path} image versions are ${values.join(", ") || "missing"}; expected two ${current.version} values`);
    }
  }
  const releaseMarkers = [
    ["README.md", /^# Tantalar (.+)$/m, current.label],
    ["README.md", /\*\*Status\*\*: `([^`]+)`/, current.version],
    ["docs/release.md", /Current release: \*\*(.*?)\*\*/, current.label],
    ["docs/release.md", /Current release: .*?\(`([^`]+)`\)\./, current.version],
    ["docs/deploy.md", /Current release: \*\*(.*?)\*\*/, current.label],
    ["docs/deploy.md", /Current release: .*?\(`([^`]+)`\)\./, current.version],
  ];
  for (const [path, pattern, expected] of releaseMarkers) {
    const match = readFileSync(resolve(root, path), "utf8").match(pattern);
    if (match?.[1] !== expected) {
      errors.push(`${path} release marker has ${match?.[1] ?? "no value"}; expected ${expected}`);
    }
  }

  if (errors.length) {
    for (const error of errors) console.error(`version: ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`${current.label} (${current.version}, ${current.channel})`);
}

function replace(path, pattern, value) {
  const absolute = resolve(root, path);
  const source = readFileSync(absolute, "utf8");
  if (!source.match(pattern)) throw new Error(`Release marker missing from ${path}`);
  writeFileSync(absolute, source.replace(pattern, value));
}

function setRelease(version, label, channel) {
  if (!semver.test(version ?? "")) throw new Error(`Invalid SemVer: ${version ?? ""}`);
  if (!label?.trim()) throw new Error("A human release label is required");
  if (!channel?.trim()) throw new Error("A release channel is required");

  for (const path of manifestPaths) {
    const manifest = readJson(path);
    manifest.version = version;
    if (path === "package.json") manifest.tantalarRelease = { label, channel };
    writeJson(path, manifest);
  }
  replace("Dockerfile", /ARG TANTALAR_BUILD_VERSION=([^\s]+)/, `ARG TANTALAR_BUILD_VERSION=${version}`);
  for (const path of ["docker/compose.sqlite.yml", "docker/compose.postgres.yml"]) {
    replace(path, /TANTALAR_IMAGE_TAG:-([^}]+)/g, `TANTALAR_IMAGE_TAG:-${version}`);
  }
  replace("README.md", /^# Tantalar .*$/m, `# Tantalar ${label}`);
  replace(
    "README.md",
    /- \*\*Status\*\*: `.*?` \(\*\*.*?\*\*\) is under active development\./,
    `- **Status**: \`${version}\` (**${label}**) is under active development.`,
  );
  replace("docs/release.md", /Current release: \*\*.*?\*\* \(`.*?`\)\./, `Current release: **${label}** (\`${version}\`).`);
  replace("docs/deploy.md", /Current release: \*\*.*?\*\* \(`.*?`\)\./, `Current release: **${label}** (\`${version}\`).`);
  console.log(`Set Tantalar to ${label} (${version}, ${channel})`);
}

const [command = "show", ...args] = process.argv.slice(2);
if (command === "show") {
  const current = release();
  const field = args[0];
  if (field && !Object.hasOwn(current, field)) throw new Error(`Unknown version field: ${field}`);
  console.log(field ? current[field] : JSON.stringify(current));
}
else if (command === "check") check();
else if (command === "set") setRelease(args[0], args[1], args[2]);
else if (command === "assert") {
  const expected = release().version;
  if (args[0] !== expected) throw new Error(`Build version ${args[0] ?? ""} does not match ${expected}`);
}
else throw new Error(`Unknown version command: ${command}`);
