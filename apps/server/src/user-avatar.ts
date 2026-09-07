import { createHash } from "node:crypto";
import { execFile } from "node:child_process";

export const AVATAR_PRESETS = ["smile", "wink", "glasses", "robot", "cat", "owl"] as const;

export function userAvatar(id: string, stored: string | null) {
  if (stored && /^data:image\/(?:png|webp);base64,/.test(stored)) {
    return { preset: null, url: `/api/v1/users/${encodeURIComponent(id)}/avatar?v=${createHash("sha256").update(stored).digest("hex").slice(0,16)}` };
  }
  return { preset: AVATAR_PRESETS.find(preset => preset === stored) ?? "smile" };
}

/** Decode and re-encode uploads; never store SVG, metadata, animation, or remote URLs. */
export async function normalizeAvatar(image: string): Promise<string> {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(image) || image.length % 4 !== 0) throw new Error("Invalid image.");
  const bytes = Buffer.from(image, "base64");
  if (bytes.length > 2 * 1024 * 1024) throw new Error("Choose an image smaller than 2 MB.");
  const format = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "png_pipe"
    : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? "jpeg_pipe"
    : bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP" ? "webp_pipe" : null;
  if (!format) throw new Error("Choose a JPEG, PNG, or WebP image.");
  // Use the existing external media tool; do not link libvips into core (ADR-0016).
  const result = await new Promise<Buffer>((resolve, reject) => {
    const child = execFile("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-max_alloc", "67108864",
      "-protocol_whitelist", "pipe", "-threads", "1", "-max_pixels", "16000000",
      "-f", format, "-i", "pipe:0", "-frames:v", "1", "-map_metadata", "-1",
      "-filter_threads", "1", "-vf", "scale=256:256:force_original_aspect_ratio=increase,crop=256:256",
      "-c:v", "png", "-threads", "1", "-f", "image2pipe", "pipe:1",
    ], { encoding: "buffer", timeout: 5000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error || !stdout.length) reject(new Error("Image conversion failed. Check the image and FFmpeg installation."));
      else resolve(stdout);
    });
    child.stdin?.on("error", () => {}); // Early decoder exit can close stdin; the callback reports that failure.
    child.stdin?.end(bytes);
  });
  return `data:image/png;base64,${result.toString("base64")}`;
}
