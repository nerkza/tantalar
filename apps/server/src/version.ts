import { createRequire } from "node:module";

interface RootManifest {
  version: string;
  tantalarRelease: {
    label: string;
    channel: string;
  };
}

export interface VersionMetadata {
  version: string;
  label: string;
  channel: string;
  build: {
    version: string | null;
    commit: string | null;
    builtAt: string | null;
  };
}

const manifest = createRequire(import.meta.url)("../../../package.json") as RootManifest;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

if (!SEMVER.test(manifest.version)) throw new Error(`Invalid Tantalar version: ${manifest.version}`);
if (!manifest.tantalarRelease?.label?.trim()) throw new Error("Tantalar release label is missing");
if (!manifest.tantalarRelease?.channel?.trim()) throw new Error("Tantalar release channel is missing");

export const TANTALAR_RELEASE = Object.freeze({
  version: manifest.version,
  label: manifest.tantalarRelease.label,
  channel: manifest.tantalarRelease.channel,
});

function optionalEnv(env: NodeJS.ProcessEnv, name: string): string | null {
  return env[name]?.trim() || null;
}

export function getVersionMetadata(env: NodeJS.ProcessEnv = process.env): VersionMetadata {
  const buildVersion = optionalEnv(env, "TANTALAR_BUILD_VERSION");
  if (buildVersion && buildVersion !== TANTALAR_RELEASE.version) {
    throw new Error(
      `Build version ${buildVersion} does not match application version ${TANTALAR_RELEASE.version}`,
    );
  }

  return {
    ...TANTALAR_RELEASE,
    build: {
      version: buildVersion,
      commit: optionalEnv(env, "TANTALAR_BUILD_COMMIT"),
      builtAt: optionalEnv(env, "TANTALAR_BUILD_DATE"),
    },
  };
}

export function formatStartupBanner(address: string, env: NodeJS.ProcessEnv = process.env): string {
  const release = getVersionMetadata(env);
  return `Tantalar ${release.label} (${release.version}; ${release.build.commit ?? "development"}) listening on ${address}\n`;
}
