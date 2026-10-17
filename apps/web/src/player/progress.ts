/**
 * Progress reporting: throttled monotonic updates with an explicit
 * allowRewind escape on user seeks, matching the 5A race guard contract.
 */
import { api } from "../api";

export class ProgressReporter {
  private lastSent = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly fileId: string,
    private readonly intervalMs = 10_000,
  ) {}

  start(video: HTMLVideoElement): void {
    this.stop();
    this.timer = setInterval(() => this.tick(video, false), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Immediate update; userSeek marks rewinds as explicit (allowRewind). */
  tick(video: HTMLVideoElement, userSeek: boolean): void {
    const positionMs = Math.round(video.currentTime * 1000);
    const durationMs = Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : undefined;
    // Monotonic guard mirrors the server rule; a genuine user seek back is
    // sent with allowRewind so it is accepted.
    if (!userSeek && positionMs < this.lastSent - 1000 && !video.ended) return;
    this.lastSent = Math.max(this.lastSent, positionMs);
    void api.setResume(this.fileId, positionMs, durationMs, userSeek || undefined).catch(() => {
      /* transient failures are retried on the next tick */
    });
  }
}
