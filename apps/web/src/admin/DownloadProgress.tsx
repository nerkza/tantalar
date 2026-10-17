import { Progress, Text } from "@mantine/core";
import type { DownloadJob } from "../api";
import { formatBytes } from "../format-bytes";

export function downloadRate(previous: DownloadJob | undefined, current: DownloadJob): number | null {
  if (current.state !== "downloading" || current.removed) return 0;
  if (!previous || previous.state !== "downloading" || previous.retryCount !== current.retryCount) return null;
  const elapsed = Date.parse(current.updatedAt) - Date.parse(previous.updatedAt);
  const bytes = current.receivedBytes - previous.receivedBytes;
  // Discard stale samples after navigation, pause, restart, or counter resets.
  return elapsed > 0 && elapsed <= 10_000 && bytes >= 0 ? bytes * 1_000 / elapsed : null;
}

export function DownloadProgress({ job, bytesPerSecond }: { job: DownloadJob; bytesPerSecond: number | null }) {
  const percent = Math.max(0, Math.min(100, Number.isFinite(job.progressPercent) ? job.progressPercent : 0));
  const active = job.state === "downloading" && !job.removed;
  return <div style={{ minWidth: 0, maxWidth: 280, width: "100%" }}>
    <Text size="xs" mb={4}>{percent}%{active ? ` · ${bytesPerSecond === null ? "Measuring…" : `${formatBytes(bytesPerSecond)}/s`}` : ""}</Text>
    <Progress value={percent} size={5} radius={0} color={job.state === "failed" ? "var(--tantalar-color-danger)" : "var(--tantalar-color-text-dimmed)"} aria-label={`${job.media?.title ?? job.title} download progress`} />
    {job.sizeBytes > 0 ? <Text size="xs" c="dimmed" mt={4}>{formatBytes(job.receivedBytes)} / {formatBytes(job.sizeBytes)}</Text> : null}
  </div>;
}
