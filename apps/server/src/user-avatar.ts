import { createHash } from "node:crypto";
import sharp from "sharp";

export const AVATAR_PRESETS = ["smile", "wink", "glasses", "robot", "cat", "owl"] as const;

export function userAvatar(id: string, stored: string | null) {
  if (stored?.startsWith("data:image/webp;base64,")) {
    return { preset: null, url: `/api/v1/users/${encodeURIComponent(id)}/avatar?v=${createHash("sha256").update(stored).digest("hex").slice(0,16)}` };
  }
  return { preset: AVATAR_PRESETS.find(preset => preset === stored) ?? "smile" };
}

/** Decode and re-encode uploads; never store SVG, metadata, animation, or remote URLs. */
export async function normalizeAvatar(image: string): Promise<string> {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(image) || image.length % 4 !== 0) throw new Error("Invalid image.");
  const bytes = Buffer.from(image, "base64");
  if (bytes.length > 2 * 1024 * 1024) throw new Error("Choose an image smaller than 2 MB.");
  const raster = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    || (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP");
  if (!raster) throw new Error("Choose a JPEG, PNG, or WebP image.");
  const input = sharp(bytes, { limitInputPixels: 16_000_000, animated: false }).timeout({ seconds: 5 });
  const metadata = await input.metadata();
  if (!["jpeg", "png", "webp"].includes(metadata.format ?? "")) throw new Error("Choose a JPEG, PNG, or WebP image.");
  const result = await input.rotate().resize(256, 256, { fit: "cover" }).webp({ quality: 85 }).toBuffer();
  return `data:image/webp;base64,${result.toString("base64")}`;
}
