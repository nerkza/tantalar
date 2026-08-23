import { boot, dumpConfig } from "./kernel.js";

const args = process.argv.slice(2);
const dumpIdx = args.indexOf("--dump-config");
if (dumpIdx >= 0) {
  const { config } = await import("@tantalar/config").then((m) => m.loadConfig());
  process.stdout.write(dumpConfig(config));
  process.exit(0);
}

// Containers supply the host config layer (bind address, port, DB dialect)
// via TANTALAR_CONFIG_FILE pointing at a YAML file (see Dockerfile entrypoint).
const kernel = await boot(
  process.env["TANTALAR_CONFIG_FILE"]
    ? { hostFile: process.env["TANTALAR_CONFIG_FILE"] }
    : {},
);
const addr = await kernel.listen();
process.stdout.write(`tantalar listening on ${addr}\n`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void kernel.shutdown().then(() => process.exit(0));
  });
}
