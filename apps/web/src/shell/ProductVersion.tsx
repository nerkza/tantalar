import { useEffect, useState } from "react";
import { Text } from "@mantine/core";

interface VersionResponse {
  readonly label?: string;
  readonly version?: string;
}

export function ProductVersion() {
  const [version, setVersion] = useState<VersionResponse | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/v1/version", { signal: controller.signal })
      .then((response) => response.ok ? response.json() as Promise<VersionResponse> : null)
      .then((value) => setVersion(value))
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  if (!version?.label) return null;
  return (
    <Text className="tantalar-version" size="xs" title={version.version ?? version.label}>
      {version.label}
    </Text>
  );
}
