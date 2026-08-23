/**
 * Grab decision pipeline (phase 3b, stories 5–8).
 *
 * Wanted item → candidate releases → comparison verdict event → grab
 * decision (auto or interactive) → client dispatch. Every step emits an
 * immutable event carrying the caller's correlationId, so the full chain
 * reconstructs from the log.
 *
 * Security invariants (ADR-0015):
 *  - tracker announce safety is asked of the tracker plugin; core stores no
 *    tracker rules and never sees passkeys;
 *  - a download may only be dispatched to a client whose tunnel binding is
 *    explicitly healthy (fail-closed kill switch).
 */
import {
  EventTypes,
  DownloadClientError,
  validateDownloadRequest,
  type CandidateRelease,
  type ComparisonVerdict,
  type DownloadRequest,
  type DownloadStatus,
  type QualityProfile,
} from "@tantalar/contracts";
import type { EventBus } from "../events.js";
import type { ServiceContainer } from "../container.js";
import { compareReleases, toCandidate } from "./comparer.js";

export interface GrabPipelineOptions {
  readonly bus: EventBus;
  readonly container: ServiceContainer;
}

export interface DecideInput {
  readonly itemKey: string;
  readonly candidates: ReadonlyArray<CandidateRelease>;
  readonly profile: QualityProfile;
  readonly blacklistedGuids?: readonly string[];
  /** interactive = operator picks the guid explicitly. */
  readonly mode: "automatic" | "interactive";
  /** Required for interactive mode: which candidate to grab. */
  readonly chosenGuid?: string;
  readonly correlationId?: string;
}

export interface DispatchResult {
  readonly grabbed: boolean;
  readonly verdict: ComparisonVerdict;
  readonly download?: DownloadStatus;
  readonly blockedReason?:
    | "no_qualifying_release"
    | "announce_not_allowed"
    | "tunnel_down"
    | "no_download_client"
    | "interactive_pick_missing";
}

const DOWNLOAD_CLIENT_CAP = "dev.tantalar.capability.download-client";
const TRACKER_RULES_CAP = "dev.tantalar.capability.tracker.rules";
const VPN_BINDING_CAP = "dev.tantalar.capability.vpn-binding";

export class GrabPipeline {
  readonly #opts: GrabPipelineOptions;
  /** In-memory blacklist (plugin-owned table in later phases). */
  readonly #blacklist = new Set<string>();

  constructor(opts: GrabPipelineOptions) {
    this.#opts = opts;
  }

  blacklist(): readonly string[] {
    return [...this.#blacklist];
  }

  addToBlacklist(guid: string): void {
    this.#blacklist.add(guid);
  }

  async decide(input: DecideInput): Promise<DispatchResult> {
    const emit = (type: string, payload: Record<string, unknown>): Promise<void> =>
      this.#opts.bus
        .publish({
          type,
          producer: "core",
          payload,
          ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
        })
        .then(() => undefined);

    const verdict = compareReleases({
      candidates: input.candidates,
      profile: input.profile,
      blacklistedGuids: [...new Set([...(input.blacklistedGuids ?? []), ...this.#blacklist])],
    });
    await emit(EventTypes.ComparisonVerdict, {
      itemKey: input.itemKey,
      winnerGuid: verdict.winnerGuid,
      rankedGuids: verdict.rankedGuids,
      rejected: verdict.rejected,
    });

    let chosenGuid: string | null;
    if (input.mode === "interactive") {
      chosenGuid = input.chosenGuid ?? null;
      if (chosenGuid === null || !verdict.rankedGuids.includes(chosenGuid)) {
        if (chosenGuid === null) {
          await emit(EventTypes.GrabDecision, { itemKey: input.itemKey, decided: false, reason: "interactive_pick_missing" });
          return { grabbed: false, verdict, blockedReason: "interactive_pick_missing" };
        }
        throw new DownloadClientError("invalid_request", `chosen guid ${chosenGuid} not among candidates`);
      }
    } else {
      chosenGuid = verdict.winnerGuid;
    }

    if (chosenGuid === null) {
      await emit(EventTypes.GrabDecision, { itemKey: input.itemKey, decided: false, reason: "no_qualifying_release" });
      return { grabbed: false, verdict, blockedReason: "no_qualifying_release" };
    }

    const chosen = input.candidates.find((c) => c.release.guid === chosenGuid);
    if (!chosen) throw new DownloadClientError("invalid_request", "candidate vanished between steps");

    // Announce safety: ask the tracker plugin when the release names one.
    if (chosen.release.kind === "torrent" && chosen.release.downloadUrl.startsWith("magnet:") === false) {
      const allowed = await this.#checkAnnounce(chosen);
      if (!allowed.allowed) {
        await emit(EventTypes.GrabDecision, {
          itemKey: input.itemKey,
          decided: false,
          reason: "announce_not_allowed",
          code: allowed.reason,
        });
        return { grabbed: false, verdict, blockedReason: "announce_not_allowed" };
      }
    }

    await emit(EventTypes.GrabDecision, { itemKey: input.itemKey, decided: true, guid: chosenGuid, mode: input.mode });

    const status = await this.#dispatch(chosen, emit, input.correlationId);
    return { grabbed: true, verdict, ...(status ? { download: status } : {}) };
  }

  async #checkAnnounce(candidate: CandidateRelease): Promise<{ allowed: boolean; reason: string }> {
    const indexerId = candidate.release.indexerId;
    if (!this.#opts.container.hasProviders(TRACKER_RULES_CAP)) {
      // No tracker plugin declared: fixture/public trackers pass through.
      return { allowed: true, reason: "host_allowed" };
    }
    try {
      const provider = this.#opts.container.resolve(TRACKER_RULES_CAP);
      const out = (await provider.invoke("check-announce", {
        downloadUrl: candidate.release.downloadUrl,
        trackerId: indexerId,
      })) as { allowed?: boolean; reason?: string };
      return { allowed: Boolean(out?.allowed), reason: String(out?.reason ?? "host_not_declared") };
    } catch {
      return { allowed: false, reason: "host_not_declared" };
    }
  }

  /**
   * Fail-closed dispatch: resolve the tunnel binding FIRST; a bound client
   * with anything other than explicit healthy state blocks the grab BEFORE
   * any transfer could fall back to the default route.
   */
  async #dispatch(
    candidate: CandidateRelease,
    emit: (type: string, payload: Record<string, unknown>) => Promise<void>,
    correlationId?: string,
  ): Promise<DownloadStatus> {
    let clientProvider;
    try {
      clientProvider = this.#opts.container.resolve(DOWNLOAD_CLIENT_CAP);
    } catch {
      await emit(EventTypes.GrabDecision, { itemKey: candidate.release.guid, decided: false, reason: "no_download_client" });
      throw new DownloadClientError("unavailable", "no provider for dev.tantalar.capability.download-client");
    }

    // Fail-closed dispatch: resolve the tunnel binding FIRST; a bound client
    // with anything other than explicit healthy state blocks the grab BEFORE
    // any transfer could fall back to the default route. The gate identity is
    // the DOWNLOAD CLIENT's plugin id, never the release's indexer id.
    if (this.#opts.container.hasProviders(VPN_BINDING_CAP)) {
      const vpn = this.#opts.container.resolve(VPN_BINDING_CAP);
      const clientId = clientProvider.pluginId;
      const check = (await vpn.invoke("pre-dispatch-check", {
        clientId,
      })) as { allowDispatch?: boolean; health?: string; profileId?: string | null };
      if (!check?.allowDispatch) {
        await emit(EventTypes.TunnelHealthChanged, {
          clientId,
          profileId: check?.profileId ?? null,
          health: check?.health ?? "down",
          dispatchBlocked: true,
        });
        throw new DownloadClientError(
          "blocked",
          `kill switch: dispatch blocked, tunnel ${String(check?.profileId ?? "?")} health=${String(check?.health ?? "down")}`,
        );
      }
    }

    const request: DownloadRequest = validateDownloadRequest({
      itemKey: candidate.release.guid,
      title: candidate.release.title,
      kind: candidate.release.kind,
      sourceUrl: candidate.release.downloadUrl,
      trackerId: candidate.release.indexerId,
      correlationId,
    });

    const status = (await clientProvider.invoke("add", request as unknown as Record<string, unknown>)) as DownloadStatus;
    await emit(EventTypes.ClientDispatch, {
      itemKey: request.itemKey,
      clientId: clientProvider.pluginId,
      downloadId: status.downloadId,
    });
    await emit(EventTypes.DownloadQueued, {
      itemKey: request.itemKey,
      downloadId: status.downloadId,
      state: status.state,
    });
    return status;
  }

  /** Handle a failed download: blacklist + auto re-search signal (story 7). */
  async handleFailure(itemKey: string, guid: string): Promise<{ blacklisted: boolean }> {
    this.addToBlacklist(guid);
    await this.#opts.bus.publish({
      type: EventTypes.BlacklistAdded,
      producer: "core",
      payload: { itemKey, guid },
    });
    return { blacklisted: true };
  }
}

export { compareReleases, toCandidate };
