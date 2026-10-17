# Your first Tantalar plugin in under 30 minutes

This guide builds a working out-of-process plugin from scratch. You never
need to read Tantalar core source. Everything here uses only the public
contract (`@tantalar/contracts`), the SDK (`@tantalar/plugin-sdk`), and the
conformance testkit (`@tantalar/testkit`).

Prerequisites: Node 22 and pnpm 11.

## 0. Scaffold (2 minutes)

Create a directory anywhere outside the Tantalar repository:

```
my-weather/
  package.json
  pnpm-workspace.yaml
  tsconfig.json
  manifest.json
  src/plugin.ts
  test/conformance.test.ts
```

`package.json`:

```json
{
  "name": "dev.example.weather",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@11.22.0",
  "bin": { "weather-plugin": "./dist/plugin.js" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run"
  },
  "dependencies": {
    "@tantalar/plugin-sdk": "^0.1.0",
    "@tantalar/contracts": "^0.1.0",
    "@tantalar/testkit": "^0.1.0"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "typescript": "^5.9.0",
    "vitest": "^3.2.0"
  }
}
```

`pnpm-workspace.yaml`:

```yaml
packages:
  - "."
allowBuilds:
  esbuild: true
```

The version ranges above are for external consumers. Inside the Tantalar
monorepo, replace them with `workspace:*`.

> **Publication status:** the `@tantalar/*` packages are not published yet.
> External installation becomes available after the package-publication gate.
> Until then, run this guide as a workspace fixture or use tarballs produced by
> `pnpm pack`. Always publish with pnpm: it rewrites internal `workspace:*`
> ranges to real versions. Do not publish these packages with plain npm.

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "types": ["node"],
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

Inside the Tantalar monorepo, a plugin can instead extend
`../../tsconfig.base.json` and keep only `outDir` and `rootDir` locally.

## 1. Manifest (3 minutes)

`manifest.json` — ids and capability names are reverse-DNS (ADR-0006):

```json
{
  "id": "dev.example.weather",
  "version": "0.1.0",
  "protocolVersion": 1,
  "provides": ["dev.example.capability.weather.current"],
  "requires": ["dev.tantalar.capability.event.emit"],
  "subscriptions": [],
  "entry": { "command": "node dist/plugin.js" }
}
```

Rules the loader enforces:

- `id` must be reverse-DNS and unique; a collision with a mounted plugin is
  rejected at mount.
- `protocolVersion` must equal the host's contract major (currently `1`).
  A mismatch is rejected before spawn.
- Only capabilities you declare in `provides` can be registered; only those
  in `requires` can be invoked. Undeclared use is refused.
- `entry.command` may be a bare `bin` name on PATH or a script path inside
  the package (`node dist/plugin.js`). A path escaping the package root is
  rejected.

## 2. Plugin source (7 minutes)

`src/plugin.ts`:

```ts
import { runPlugin, definePlugin, type PluginDefinition } from "@tantalar/plugin-sdk";
import { PROTOCOL_VERSION, validateManifest } from "@tantalar/contracts";

const plugin: PluginDefinition = definePlugin({
  manifest: validateManifest({
    id: "dev.example.weather",
    version: "0.1.0",
    protocolVersion: PROTOCOL_VERSION,
    provides: ["dev.example.capability.weather.current"],
    requires: ["dev.tantalar.capability.event.emit"],
    subscriptions: [],
    entry: { command: "node dist/plugin.js" },
  }),
  mount(ctx) {
    ctx.log("info", "weather mounted");
  },
  unmount(ctx) {
    ctx.log("info", "weather unmounted");
  },
  handlers: {
    "dev.example.capability.weather.current": async (_op, payload) => {
      const city = (payload.city as string) ?? "london";
      return { city, tempC: 18 }; // fixture — replace with a real fetch
    },
  },
});

runPlugin(plugin);
```

That is the whole plugin. `runPlugin` implements the control-channel framing
(handshake, mount, unmount, ping, call, emit, invoke, introspect) so you
never touch protocol code. The plugin runs in its own process; a crash is
isolated and restarted under the supervisor's policy.

## 3. Conformance-test it locally (5 minutes)

Add `test/conformance.test.ts`:

```ts
import { it, expect } from "vitest";
import { runConformanceSuite } from "@tantalar/testkit";

it("passes the Tantalar conformance suite", async () => {
  const report = await runConformanceSuite({ packageDir: new URL("..", import.meta.url).pathname });
  expect(report.failed).toBe(0);
}, 60_000);
```

Run `pnpm install && pnpm build && pnpm test`. The suite
mounts your plugin as a real child process and checks the handshake,
manifest validity, capability round-trip, event emission, unmount
reversibility, and crash-recovery behaviour. Third-party plugins ship this
same suite green.

## 4. Package it (5 minutes)

```ts
import { packPlugin, verifyTpkEntries } from "@tantalar/plugin-sdk";
import { writeFileSync } from "node:fs";

const { entries, sha256 } = await packPlugin("./my-weather");
writeFileSync("weather-0.1.0.tpk", JSON.stringify({ entries, sha256 }));
// Receiver side verifies before touching disk:
await verifyTpkEntries(entries);
```

Packaging rejects path traversal, absolute member paths, symlinks, special
files, and oversized archives. `installDirFor` maps a validated plugin id to
a safe install directory; `extractTo` writes verified entries only.

## 5. Install, run, disable, swap — config only (5 minutes)

No code or CLI in core changes. Add the plugin to the layered config
(`packages/config`, ADR-0010) plugins set:

```yaml
plugins:
  dev.example.weather:
    enabled: true
    manifestPath: /opt/tantalar/plugins/weather-0.1.0/manifest.json
```

On boot (or on a config reload) the lifecycle manager diff-applies the set:
new enabled entries mount, removed or disabled entries unmount reversibly
(capabilities deregistered), and a failed mount never disturbs healthy
plugins. To upgrade, point `manifestPath` at the new version's manifest; to
roll back, point it back. To disable, set `enabled: false` or delete the
key.

## 6. Done — checklist

- [ ] `pnpm build` compiles clean
- [ ] conformance suite green against your package
- [ ] `.tpk` packs and verifies
- [ ] config enables it; the server shows it healthy
- [ ] disabling the config key unmounts it; re-enabling mounts it again

You have now created, tested, packaged, installed, run, disabled, and
replaced a plugin without reading Tantalar core source — the Phase 2 exit
criterion.
