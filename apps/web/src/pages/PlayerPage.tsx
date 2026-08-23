/**
 * Web player page: negotiation → direct play or HLS; quality + subtitle
 * selection; seek with resume reporting; autoplay next episode from the
 * library's series ordering; accessible keyboard controls and live regions.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, Group, NativeSelect, Paper, Slider, Stack, Text, Title } from "@mantine/core";
import { api, type PlaybackDecision, type SubtitleTrack } from "../api";
import { attachPlayback, BROWSER_RENDERABLE_SUBTITLE_FORMATS, srtToVtt } from "../player/engine";
import { ProgressReporter } from "../player/progress";

interface Quality {
  index: number;
  label: string;
}

export function PlayerPage({ fileId }: { fileId: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const engineRef = useRef<ReturnType<typeof attachPlayback> | null>(null);
  const reporterRef = useRef<ProgressReporter | null>(null);
  const seekWasUserRef = useRef(false);
  const pendingResumeMsRef = useRef<number | null>(null);

  const [qualities, setQualities] = useState<readonly Quality[]>([]);
  const [quality, setQuality] = useState<string>("-1");
  const [error, setError] = useState<string | null>(null);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [autoplayNext, setAutoplayNext] = useState(true);
  const [selectedTrackId, setSelectedTrackId] = useState("");

  const negotiate = useQuery({
    queryKey: ["negotiate", fileId],
    queryFn: () => api.negotiate(fileId),
  });
  const subtitles = useQuery({
    queryKey: ["subtitles", fileId],
    queryFn: () => api.subtitles(fileId),
  });

  const decision: PlaybackDecision | undefined = negotiate.data?.decision;

  // Attach playback once negotiation resolves.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !decision) return;
    setError(null);
    const engine = attachPlayback(video, decision, {
      onQualities: (qs: readonly Quality[]) => setQualities(qs),
      onError: (msg: string) => setError(msg),
    });
    engineRef.current = engine;

    const reporter = new ProgressReporter(fileId);
    reporterRef.current = reporter;

    // Resume: fetch the stored point and start there once metadata is known.
    let cancelled = false;
    void api
      .resumePoint(fileId)
      .then(({ resumePoint }) => {
        if (!cancelled && resumePoint && resumePoint.positionMs > 1000) {
          pendingResumeMsRef.current = resumePoint.positionMs;
          if (video.readyState >= 1 && video.duration > 0) {
            video.currentTime = Math.min(resumePoint.positionMs / 1000, Math.max(0, video.duration - 5));
            pendingResumeMsRef.current = null;
          }
        }
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      pendingResumeMsRef.current = null;
      clearSelectedTrack(video);
      reporter.stop();
      reporter.tick(video, false);
      engine.destroy();
      engineRef.current = null;
      reporterRef.current = null;
    };
  }, [decision, fileId]);

  useEffect(() => {
    if (reporterRef.current) reporterRef.current.start(videoRef.current!);
    return () => reporterRef.current?.stop();
  }, [decision]);

  // Autoplay next episode when this one ends.
  const nextFileId = useNextEpisode(fileId);
  const onEnded = useCallback(() => {
    const v = videoRef.current;
    if (v && reporterRef.current) reporterRef.current.tick(v, false);
    if (autoplayNext && nextFileId) {
      window.location.hash = `/watch/${encodeURIComponent(nextFileId)}`;
    }
  }, [autoplayNext, nextFileId]);

  if (negotiate.isPending) return <div aria-busy="true">Preparing playback…</div>;
  if (negotiate.isError) {
    return (
      <div role="alert">
        <Text>Playback unavailable.</Text>
        <Text size="sm" c="dimmed">{(negotiate.error as Error).message}</Text>
      </div>
    );
  }

  const tracks: readonly SubtitleTrack[] = subtitles.data?.tracks ?? [];
  return (
    <Stack gap="sm" data-testid="player-page" data-mode={decision?.mode ?? ""}>
      <Title order={4}>Now playing</Title>
      <Paper p="md" radius="md">
        <video
          ref={videoRef}
          data-testid="player-video"
          controls
          playsInline
          aria-label="Video player"
          style={{ width: "100%", borderRadius: 8, background: "#000", aspectRatio: "16/9" }}
          onLoadedMetadata={(e) => {
            const video = e.currentTarget;
            setDuration(Number.isFinite(video.duration) ? video.duration : 0);
            const pendingResumeMs = pendingResumeMsRef.current;
            if (pendingResumeMs !== null && video.duration > 0) {
              video.currentTime = Math.min(pendingResumeMs / 1000, Math.max(0, video.duration - 5));
              pendingResumeMsRef.current = null;
            }
            setPosition(video.currentTime);
          }}
          onTimeUpdate={(e) => {
            const v = e.currentTarget;
            setPosition(v.currentTime);
            setDuration(Number.isFinite(v.duration) ? v.duration : 0);
          }}
          onSeeked={(e) => {
            const v = e.currentTarget;
            const user = seekWasUserRef.current;
            seekWasUserRef.current = false;
            reporterRef.current?.tick(v, user);
          }}
          onEnded={onEnded}
        />

        {/* Accessible keyboard control hints; the native controls already
            respond to arrows/space. Slider mirrors position for AT users. */}
        <Group grow mt="md" align="center">
          <Slider
            data-testid="seek-slider"
            thumbLabel="Seek"
            value={duration > 0 ? (position / duration) * 100 : 0}
            onChange={(pct) => {
              const v = videoRef.current;
              if (!v || duration <= 0) return;
              seekWasUserRef.current = true;
              v.currentTime = (pct / 100) * duration;
            }}
          />
          <Text size="xs" c="dimmed" w={110} role="timer">
            {fmt(position)} / {fmt(duration)}
          </Text>
        </Group>

        <Group mt="sm" gap="sm" wrap="wrap">
          <NativeSelect
            aria-label="Quality"
            data-testid="quality-select"
            data={qualities.map((q) => ({ value: String(q.index), label: q.label }))}
            value={quality}
            onChange={(e) => {
              const idx = Number(e.currentTarget.value);
              setQuality(String(idx));
              engineRef.current?.setQuality(idx);
            }}
            disabled={qualities.length === 0}
          />
          <NativeSelect
            aria-label="Subtitles"
            data-testid="subtitle-select"
            data={[
              { value: "", label: "Off" },
              ...tracks.map((t) => ({
                value: t.trackId ?? "",
                label: `${t.lang} (${t.format}, ${t.source})${
                  BROWSER_RENDERABLE_SUBTITLE_FORMATS.has(t.format) ? "" : " — not renderable in browser"
                }`,
              })),
            ]}
            value={selectedTrackId}
            onChange={(e) => {
              const trackId = e.currentTarget.value;
              const track = tracks.find((item) => item.trackId === trackId);
              const renderable = !trackId || (track && BROWSER_RENDERABLE_SUBTITLE_FORMATS.has(track.format));
              setSelectedTrackId(renderable ? trackId : "");
              setError(renderable ? null : `Subtitle format ${track?.format ?? "unknown"} is not browser-renderable.`);
              selectTrack(videoRef.current, tracks, renderable ? trackId : "", (message) => {
                setError(message);
                if (message) setSelectedTrackId("");
              });
            }}
          />
          <Button
            variant={autoplayNext ? "light" : "default"}
            aria-pressed={autoplayNext}
            onClick={() => setAutoplayNext((v) => !v)}
          >
            Autoplay next: {autoplayNext ? "on" : "off"}
          </Button>
        </Group>

        <div aria-live="polite" className="visually-hidden-live">
          {error ? `Error: ${error}` : `Playing via ${decision?.mode}. Position ${fmt(position)}.`}
        </div>
        {error ? (
          <div role="alert" style={{ color: "var(--mantine-color-red-6)" }}>{error}</div>
        ) : null}
      </Paper>
    </Stack>
  );
}

function fmt(s: number): string {
  if (!Number.isFinite(s)) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60).toString().padStart(2, "0");
  return `${m}:${sec}`;
}

interface SubtitleSelectionState {
  controller: AbortController;
  elements: Set<HTMLTrackElement>;
}

const subtitleSelections = new WeakMap<HTMLVideoElement, SubtitleSelectionState>();

function clearSelectedTrack(video: HTMLVideoElement): void {
  const state = subtitleSelections.get(video);
  if (!state) return;
  state.controller.abort();
  for (const element of state.elements) element.remove();
  subtitleSelections.delete(video);
}

function selectTrack(
  video: HTMLVideoElement | null,
  tracks: readonly SubtitleTrack[],
  trackId: string,
  onError: (message: string | null) => void,
): void {
  if (!video) return;
  clearSelectedTrack(video);
  for (let i = 0; i < video.textTracks.length; i++) {
    const tt = video.textTracks[i];
    if (tt) tt.mode = "disabled";
  }
  if (!trackId) {
    onError(null);
    return;
  }
  const track = tracks.find((t) => t.trackId === trackId);
  if (!track || !BROWSER_RENDERABLE_SUBTITLE_FORMATS.has(track.format)) return; // caller keeps non-renderable formats off
  const state: SubtitleSelectionState = {
    controller: new AbortController(),
    elements: new Set(),
  };
  subtitleSelections.set(video, state);
  // Fetch the SRT payload from the authorized subtitle-content route,
  // convert to VTT and register it as a text track.
  fetch(`/api/v1/library/subtitles/${encodeURIComponent(trackId)}`, { signal: state.controller.signal })
    .then(async (res) => {
      if (!res.ok) throw new Error(`subtitle request failed (${res.status})`);
      return res.text();
    })
    .then((srt) => {
      if (!srt || state.controller.signal.aborted) return;
      const el = document.createElement("track");
      el.kind = "subtitles";
      el.label = track.lang;
      el.srclang = track.lang;
      el.src = `data:text/vtt;charset=utf-8,${encodeURIComponent(srtToVtt(srt))}`;
      state.elements.add(el);
      video.appendChild(el);
      const added = video.textTracks[video.textTracks.length - 1];
      if (added) added.mode = "showing";
      onError(null);
    })
    .catch((error: unknown) => {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        clearSelectedTrack(video);
        onError(error instanceof Error ? error.message : "subtitle request failed");
      }
    });
}

/** Find the next episode of the same series from library ordering. */
function useNextEpisode(fileId: string): string | null {
  const q = useQuery({ queryKey: ["library"], queryFn: () => api.browse() });
  return useMemo(() => {
    const items = q.data?.items ?? [];
    const me = items.find((i) => i.fileId === fileId);
    if (!me) return null;
    const siblings = items.filter((i) => i.itemKey.split("/")[0] === me.itemKey.split("/")[0]);
    const idx = siblings.findIndex((i) => i.fileId === fileId);
    return idx >= 0 ? siblings[idx + 1]?.fileId ?? null : null;
  }, [q.data, fileId]);
}
