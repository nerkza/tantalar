#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const runJson = (args) => JSON.parse(execFileSync("pnpm", args, { encoding: "utf8" }));
const roots = runJson(["--recursive", "list", "--prod", "--json", "--depth", "Infinity"]);
const licensesByNameVersion = new Map();
const licenseGroups = runJson(["licenses", "list", "--prod", "--json"]);
const forbiddenLicenses = Object.keys(licenseGroups).filter((expression) =>
  /(?:^|[^A-Z])(?:AGPL|GPL|LGPL)(?:-|\b)/i.test(expression),
);
if (forbiddenLicenses.length > 0) {
  throw new Error(`GPL-family license expressions found: ${forbiddenLicenses.join(", ")}`);
}

for (const [expression, packages] of Object.entries(licenseGroups)) {
  for (const pkg of packages) {
    for (const version of pkg.versions ?? []) {
      licensesByNameVersion.set(`${pkg.name}@${version}`, expression);
    }
  }
}

const encodePackageName = (name) => name.split("/").map(encodeURIComponent).join("/");
const purl = (name, version) => `pkg:npm/${encodePackageName(name)}@${encodeURIComponent(version)}`;
const components = new Map();
const dependencyEdges = new Map();

function record(name, node, type = "library") {
  const version = String(node.version ?? "0.0.0");
  const ref = purl(name, version);
  if (!components.has(ref)) {
    const license = licensesByNameVersion.get(`${name}@${version}`);
    const component = {
      type,
      "bom-ref": ref,
      name,
      version,
      purl: ref,
    };
    if (license) {
      component.licenses = [/[()\s]/.test(license) ? { expression: license } : { license: { id: license } }];
    }
    components.set(ref, component);
  }

  const children = dependencyEdges.get(ref) ?? new Set();
  for (const [childName, child] of Object.entries(node.dependencies ?? {})) {
    const childRef = record(childName, child);
    children.add(childRef);
  }
  dependencyEdges.set(ref, children);
  return ref;
}

const rootRefs = [];
for (const root of roots) {
  rootRefs.push(record(root.name ?? "tantalar-workspace", root, root.private ? "application" : "library"));
}

const lockHash = createHash("sha256").update(readFileSync("pnpm-lock.yaml")).digest("hex");
const uuid = `${lockHash.slice(0, 8)}-${lockHash.slice(8, 12)}-4${lockHash.slice(13, 16)}-a${lockHash.slice(17, 20)}-${lockHash.slice(20, 32)}`;
const componentList = [...components.values()].sort((a, b) => a["bom-ref"].localeCompare(b["bom-ref"]));
const dependencies = [...dependencyEdges.entries()]
  .map(([ref, children]) => ({ ref, dependsOn: [...children].sort() }))
  .sort((a, b) => a.ref.localeCompare(b.ref));

const bom = {
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  serialNumber: `urn:uuid:${uuid}`,
  version: 1,
  metadata: {
    component: {
      type: "application",
      "bom-ref": "pkg:npm/tantalar@0.1.0",
      name: "tantalar",
      version: "0.1.0",
      purl: "pkg:npm/tantalar@0.1.0",
    },
  },
  components: componentList,
  dependencies,
};

mkdirSync("artifacts", { recursive: true });
writeFileSync("artifacts/sbom.json", `${JSON.stringify(bom, null, 2)}\n`);
writeFileSync("artifacts/licenses.json", `${JSON.stringify(licenseGroups, null, 2)}\n`);
const summary = Object.entries(licenseGroups)
  .map(([license, packages]) => `${license}: ${packages.length}`)
  .sort()
  .join("\n");
writeFileSync("artifacts/licenses-summary.txt", `${summary}\n`);
console.log(`SBOM components: ${componentList.length}; workspace roots: ${rootRefs.length}`);
