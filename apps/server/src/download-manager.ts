import { validateDownloadStatus } from "@tantalar/contracts";
import type { DownloadJobStore } from "@tantalar/db";
import type { DownloadJobRecord } from "@tantalar/contracts";
import type { CapabilityProvider, ServiceContainer } from "./container.js";

/** Mirror active provider jobs into the one core-owned queue. */
export async function syncDownloadJobs(
  jobs: DownloadJobStore,
  container: ServiceContainer,
  onCompleted?: (job: DownloadJobRecord, provider: CapabilityProvider) => Promise<string>,
): Promise<number> {
  const active = (await jobs.list()).filter(
    (job) => !job.removed && job.state !== "cancelled" && (job.state !== "completed" || !job.importHandoffPath),
  );
  let synced = 0;
  for (const job of active) {
    if (!job.providerJobId) {
      await jobs.updateProgress(job.jobId, { warning: "Legacy job has no provider identity." });
      continue;
    }
    try {
      const provider = container.resolveProvider("dev.tantalar.capability.download-client", job.providerPluginId);
      const status = validateDownloadStatus(
        await provider.invoke("status", { downloadId: job.providerJobId }),
        { downloadId: job.providerJobId, itemKey: job.itemKey },
      );
      const updated = await jobs.updateProgress(job.jobId, {
        state: status.state,
        progressPercent: status.progressPercent,
        sizeBytes: status.sizeBytes,
        receivedBytes: status.receivedBytes ?? Math.round(status.sizeBytes * (status.progressPercent / 100)),
        ...(status.error ? { warning: "Download provider reported a failure." } : {}),
      });
      if (status.state === "failed") {
        // Provider text can contain URLs or credentials; persist only reviewed recovery copy.
        const error = status.error ?? "";
        const reason = /timed out|ECONNRESET|connection closed|ETIMEDOUT|EPIPE/.test(error)
          ? "The Usenet connection timed out or closed after retries. Retry to resume the saved download."
          : /authentication failed/.test(error)
            ? "The Usenet server rejected authentication. Check credentials and the provider connection limit, then retry."
          : /unavailable on all configured servers/.test(error)
          ? "A Usenet article is missing on all configured servers. Search for another release or add a fill server."
          : /CRC|checksum/i.test(error)
            ? "Downloaded data failed its integrity check. Retry or search for another release."
            : /requires (?:par2cmdline|7-Zip)/.test(error)
              ? "Post-processing tools are unavailable. Install par2cmdline and 7-Zip, then restart Tantalar."
              : /password/i.test(error)
                ? "This archive requires a password. Search for an unencrypted release."
                : /PAR2|recovery/.test(error)
                  ? "Recovery data could not repair this release. Search for another release or add a fill server."
                  : /archive/i.test(error)
                    ? "Archive extraction failed. The release may be incomplete or unsupported. Search for another release."
                    : /free space|size limit/i.test(error)
                      ? "The download exceeded its storage limit. Check free space and download limits, then retry."
                      : "The download provider failed. Check its connection and settings, then retry.";
        if (job.failureReason !== reason) await jobs.markFailed(job.jobId, reason);
      }
      synced++;
      if (status.state === "completed" && !updated.importHandoffPath && onCompleted) {
        try {
          await jobs.recordImportHandoff(job.jobId, await onCompleted(updated, provider));
        } catch (error) {
          const message = String((error as Error).message ?? "");
          const reason = /outside_root|destination library|no import roots/.test(message)
            ? "Select an enabled destination library and check the configured download roots."
            : /collision|review_stale/.test(message)
              ? "A destination file or import review conflicts with this download. Review the library before retrying."
              : /no supported video/.test(message)
                ? "No supported video was found in the completed download. Check extraction output."
                : /ERR_FS_FILE_TOO_LARGE/.test(message)
                  ? "The importer cannot process this file size. Update the library importer."
                  : /ENOSPC|disk full/.test(message)
                    ? "The destination has insufficient free space. Free space before retrying."
                    : /timed out/.test(message)
                      ? "The importer timed out. Check storage performance and importer health."
                      : /EACCES|EPERM/.test(message)
                        ? "The importer cannot access the source or destination. Check folder permissions."
                        : "The library importer failed. Check importer health and destination settings.";
          await jobs.updateProgress(job.jobId, { warning: `Import failed: ${reason}` });
        }
      }
    } catch (error) {
      const code = String((error as { code?: unknown }).code ?? "");
      const message = String((error as Error).message ?? "");
      if (code === "unknown_download" || message.startsWith("unknown_download:")) {
        await jobs.remove(job.jobId);
        synced++;
        continue;
      }
      await jobs.updateProgress(job.jobId, { warning: "Download provider status unavailable." });
      continue;
    }
  }
  return synced;
}
