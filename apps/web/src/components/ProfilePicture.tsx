import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button, Group, Stack, Text } from "@mantine/core";
import { api, type UserAvatar } from "../api";
import { ActionNotice, useActionFeedback } from "./ActionNotice";
import "./profile-picture.css";

const PRESETS = ["smile", "wink", "glasses", "robot", "cat", "owl"] as const;

export function ProfilePicture({ avatar, name, decorative = false }: { avatar?: UserAvatar; name: string; decorative?: boolean }) {
  const preset = PRESETS.find(value => value === avatar?.preset) ?? "smile";
  return <span className="tantalar-profile-picture" data-preset={preset}>
    {avatar?.url ? <img src={avatar.url} alt={decorative ? "" : `${name}'s profile picture`} /> :
      <svg viewBox="0 0 100 100" role={decorative ? undefined : "img"} aria-label={decorative ? undefined : `${name}'s ${preset} avatar`} aria-hidden={decorative || undefined}>
        <rect width="100" height="100" fill="currentColor" />
        <g className="tantalar-profile-picture__face" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round">
          {preset === "cat" ? <path d="M20 48V22L38 36M80 48V22L62 36M15 62L32 66M85 62L68 66" /> : null}
          {preset === "robot" ? <><path d="M50 20V12M26 31H74V77H26Z" /><path d="M39 64H61" /></> : <path d="M35 65Q50 80 65 65" />}
          {preset === "glasses" || preset === "owl" ? <><circle cx="34" cy="45" r="13" /><circle cx="66" cy="45" r="13" /><path d="M47 44H53" /></> : null}
          <circle cx="35" cy="45" r="3" fill="currentColor" stroke="none" />
          {preset === "wink" ? <path d="M59 45Q65 39 71 45" /> : <circle cx="65" cy="45" r="3" fill="currentColor" stroke="none" />}
          {preset === "owl" ? <path d="M46 60L50 65L54 60" /> : null}
        </g>
      </svg>}
  </span>;
}

export function PictureEditor({ userId, username, avatar, onSaved }: { userId: string; username: string; avatar?: UserAvatar; onSaved: (avatar: UserAvatar) => void }) {
  const qc = useQueryClient();
  const [choice, setChoice] = useState<{ preset: string } | { image: string } | null>(null);
  const [preview, setPreview] = useState<UserAvatar | undefined>(avatar);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice, severity, revision] = useActionFeedback();
  const upload = async (file?: File) => {
    if (!file) return;
    if (file.size > 2 * 1024 * 1024 || !["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      setError("Choose a JPEG, PNG, or WebP image under 2 MB."); return;
    }
    setBusy(true);
    try {
      const image = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error("The image could not be read."));
        reader.readAsDataURL(file);
      });
      setChoice({ image: image.split(",")[1]! });
      setPreview({ preset: null, url: image });
      setError(null);
    } catch { setError("The image could not be read."); }
    finally { setBusy(false); }
  };
  const save = async () => {
    if (!choice) return;
    setBusy(true); setError(null);
    try { const result = await api.saveUserAvatar(userId, choice); setPreview(result.avatar); setChoice(null); onSaved(result.avatar); void qc.invalidateQueries({ queryKey: ["profile", userId] }); setNotice("Profile picture saved."); }
    catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  };
  return <Stack gap="md" className="tantalar-picture-editor">
    <ActionNotice message={notice} title="Profile" severity={severity} revision={revision} />
    <div className="tantalar-picture-editor__preview"><ProfilePicture avatar={preview} name={username} /></div>
    <div role="group" aria-label="Choose an avatar" className="tantalar-picture-editor__choices">
      {PRESETS.map(preset => <button type="button" key={preset} aria-label={`${preset[0]!.toUpperCase()}${preset.slice(1)} avatar`} aria-pressed={preview?.preset === preset || (!preview && preset === "smile")} disabled={busy}
        onClick={() => { setChoice({ preset }); setPreview({ preset }); setError(null); }}><ProfilePicture avatar={{ preset }} name={username} decorative /></button>)}
    </div>
    <label className="tantalar-picture-editor__upload">Upload photo<input type="file" accept="image/jpeg,image/png,image/webp" disabled={busy} onChange={event => { void upload(event.currentTarget.files?.[0]); event.currentTarget.value = ""; }} /></label>
    <Text size="xs" c="dimmed">JPEG, PNG or WebP · Up to 2 MB · Cropped to a square</Text>
    {error ? <Text role="alert" c="var(--tantalar-color-danger)">{error}</Text> : null}
    <Group justify="flex-end"><Button type="button" variant="default" disabled={!choice || busy} onClick={() => { setChoice(null); setPreview(avatar); setError(null); }}>Revert</Button><Button type="button" disabled={!choice} loading={busy} onClick={() => void save()}>Save picture</Button></Group>
  </Stack>;
}
