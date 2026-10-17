/**
 * Playback engine for the web player.
 *
 * - direct play: <video src=/api/v1/stream/:fileId> with byte-range seeking
 *   (the browser issues the ranges; ffmpeg is bypassed entirely);
 * - HLS fallback: hls.js attaches to the negotiated manifest; quality level
 *   selection maps onto the manifest's rendition list;
 * - subtitles: embedded/external tracks from the inventory are rendered as
 *   text tracks (SRT converted to VTT client-side); PGS/ASS are listed but
 *   flagged as not browser-renderable and fall back to "off";
 * - progress reporting: throttled set-resume posts with allowRewind on user
 *   seeks, monotonic otherwise.
 */
import Hls, { type Level } from "hls.js";

export interface EngineHooks {
  onQualities: (levels: readonly { index: number; label: string }[]) => void;
  onError: (message: string) => void;
}

export interface AttachResult {
  destroy: () => void;
  /** Select an HLS quality level (-1 = auto). No-op in direct mode. */
  setQuality: (index: number) => void;
}

/** Convert a simple SRT subtitle payload into WebVTT text. */
export function srtToVtt(srt: string): string {
  const body = srt
    .replace(/\r+/g, "")
    .replace(/^\uFEFF/, "")
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2");
  return "WEBVTT\n\n" + body;
}

export const BROWSER_RENDERABLE_SUBTITLE_FORMATS = new Set(["srt"]);

export function attachPlayback(
  video: HTMLVideoElement,
  decision: { mode: "direct"; streamUrl: string } | { mode: "hls"; manifestUrl: string },
  hooks: EngineHooks,
): AttachResult {
  if (decision.mode === "direct") {
    video.src = decision.streamUrl;
    hooks.onQualities([{ index: -1, label: "Direct (original)" }]);
    return {
      destroy: () => {
        video.removeAttribute("src");
        video.load();
      },
      setQuality: () => undefined,
    };
  }

  const hls = new Hls({ capLevelToPlayerSize: false });
  let destroyed = false;
  hls.on(Hls.Events.MANIFEST_PARSED, (_e, data) => {
    if (destroyed) return;
    const levels: Level[] = data.levels ?? [];
    hooks.onQualities([
      ...levels.map((l, index) => ({
        index,
        label: l.height ? `${l.height}p` : `${Math.round((l.bitrate ?? 0) / 1000)} kbps`,
      })),
      { index: -1, label: "Auto" },
    ]);
  });
  hls.on(Hls.Events.ERROR, (_e, data) => {
    if (!data.fatal || destroyed) return;
    if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
      hls.startLoad();
      return;
    }
    hooks.onError(`playback error: ${data.details}`);
  });
  hls.loadSource(decision.manifestUrl);
  hls.attachMedia(video);

  return {
    destroy: () => {
      destroyed = true;
      hls.destroy();
    },
    setQuality: (index: number) => {
      hls.currentLevel = index;
    },
  };
}
