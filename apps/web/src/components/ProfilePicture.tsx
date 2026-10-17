import { useRef, useState, type CSSProperties } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Group, Stack, Text } from "@mantine/core";
import { api, type UserAvatar } from "../api";
import { ActionNotice, useActionFeedback } from "./ActionNotice";
import "./profile-picture.css";

const PRESETS = ["smile", "wink", "glasses", "robot", "cat", "owl"] as const;
const ARTWORK = Object.entries(import.meta.glob<string>("../assets/profile-artwork/*.jpg", { eager: true, query: "?url", import: "default" }))
  .map(([path, url]) => ({ id: `default:${path.split("/").pop()!.replace(".jpg", "")}`, url, name: path.split("/").pop()!.replace(".jpg", "").replaceAll("-", " ") }));

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
  const album = useQuery({ queryKey: ["profile-album"], queryFn: api.profileAlbum });
  const artwork = album.data ? [...ARTWORK.filter(picture => !album.data.hiddenDefaults.includes(picture.id)), ...album.data.pictures] : [];
  const [choice, setChoice] = useState<{ preset: string } | { image: string } | null>(null);
  const [preview, setPreview] = useState<UserAvatar | undefined>(avatar);
  const [busy, setBusy] = useState(false);
  const swipeStart = useRef<number | null>(null);
  const swiped = useRef(false);
  const [activeArtwork, setActiveArtwork] = useState(0);
  const activeIndex = Math.min(activeArtwork, Math.max(0, artwork.length - 1));
  const currentArtwork = artwork[activeIndex];
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [selectedArtwork, setSelectedArtwork] = useState<string | null>(null);
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
  const chooseArtwork = async (url: string, name: string) => {
    setBusy(true); setError(null);
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error("Artwork could not be loaded.");
      await upload(new File([await response.blob()], `${name}.jpg`, { type: "image/jpeg" }));
      setSelectedArtwork(url);
    } catch { setError("Artwork could not be loaded. Try again."); }
    finally { setBusy(false); }
  };
  const moveTo = (index: number) => {
    if (busy || !artwork.length) return;
    const next = (index + artwork.length) % artwork.length;
    setActiveArtwork(next);
    setDeleteId(null);
    void chooseArtwork(artwork[next]!.url, artwork[next]!.name);
  };
  const importPictures = async (files: File[]) => {
    setBusy(true); setError(null);
    let imported = 0;
    try {
      for (const file of files) {
        if (file.size > 2 * 1024 * 1024 || !["image/jpeg", "image/png", "image/webp"].includes(file.type)) throw new Error(`${file.name}: choose a JPEG, PNG, or WebP image under 2 MB.`);
        const image = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",")[1]!); reader.onerror = () => reject(new Error("The image could not be read.")); reader.readAsDataURL(file); });
        await api.importAlbumPicture(file.name.replace(/\.[^.]+$/, "").slice(0, 100), image);
        imported++;
      }
      setNotice(`${imported} picture${imported === 1 ? "" : "s"} imported.`);
    } catch (error) { setError(`${imported ? `${imported} imported. ` : ""}${(error as Error).message}`); }
    finally { await qc.invalidateQueries({ queryKey: ["profile-album"] }); setBusy(false); }
  };
  const deletePicture = async () => {
    if (!deleteId) return;
    setBusy(true); setError(null);
    try { await api.deleteAlbumPicture(deleteId); await qc.invalidateQueries({ queryKey: ["profile-album"] }); setDeleteId(null); setNotice("Picture removed from the album."); }
    catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  };
  const exportPicture = async () => {
    if (!currentArtwork) return;
    setBusy(true); setError(null);
    try {
      const response = await fetch(currentArtwork.url);
      if (!response.ok) throw new Error("Picture could not be exported.");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob), link = document.createElement("a");
      link.href = url; link.download = `${currentArtwork.name.replace(/[^a-z0-9 _-]/gi, "-")}.${blob.type === "image/png" ? "png" : "jpg"}`;
      document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  };
  return <Stack gap="md" className="tantalar-picture-editor">
    <ActionNotice message={notice} title="Profile" severity={severity} revision={revision} />
    <div className="tantalar-picture-editor__current">
      <div className="tantalar-picture-editor__preview" key={preview?.url ?? preview?.preset}><ProfilePicture avatar={preview} name={username} /></div>
      <div><Text size="sm" fw={600}>Profile picture</Text><Text size="xs" c="dimmed">{choice ? "Unsaved selection" : "Current picture"}</Text></div>
    </div>
    {currentArtwork ? <div className="tantalar-picture-editor__carousel" role="region" aria-roledescription="carousel" aria-label="Profile artwork">
      <button type="button" aria-label="Previous artwork" disabled={busy || artwork.length < 2} onClick={() => moveTo(activeIndex - 1)}>‹</button>
      <div role="group" aria-label="Choose an avatar" className="tantalar-picture-editor__choices"
        onKeyDown={event => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); moveTo(activeIndex + (event.key === "ArrowLeft" ? -1 : 1)); } }}
        onPointerDown={event => { swipeStart.current = event.clientX; swiped.current = false; }}
        onPointerCancel={() => { swipeStart.current = null; }}
        onPointerUp={event => { const start = swipeStart.current; swipeStart.current = null; if (start !== null && Math.abs(event.clientX - start) > 30) { swiped.current = true; moveTo(activeIndex + (event.clientX < start ? 1 : -1)); } }}>
        {artwork.map(({ id, url, name }, index) => {
          let offset = (index - activeIndex + artwork.length) % artwork.length;
          if (offset > Math.floor(artwork.length / 2)) offset -= artwork.length;
          const visible = Math.abs(offset) <= 2;
          return <button type="button" key={id} aria-label={`${name} avatar`} aria-pressed={selectedArtwork === url} aria-current={offset === 0 ? "true" : undefined} aria-hidden={!visible} tabIndex={offset === 0 ? 0 : -1} disabled={busy}
            style={{ "--position": `${Math.sign(offset) * (Math.abs(offset) === 1 ? 24 : Math.abs(offset) === 2 ? 42 : Math.abs(offset) * 24)}%`, "--scale": offset === 0 ? 1 : Math.abs(offset) === 1 ? 0.6 : 0.42, zIndex: 5 - Math.abs(offset) } as CSSProperties}
            onClick={event => { if (event.detail === 0 || !swiped.current) moveTo(index); }}><img src={url} alt="" width="88" height="88" draggable={false} /></button>;
        })}
      </div>
      <button type="button" aria-label="Next artwork" disabled={busy || artwork.length < 2} onClick={() => moveTo(activeIndex + 1)}>›</button>
    </div> : <Text size="sm" c="dimmed">{album.isPending ? "Loading profile album…" : album.isError ? "Profile album unavailable." : "The profile album is empty."}</Text>}
    {currentArtwork ? <Text size="xs" ta="center" aria-live="polite" className="tantalar-picture-editor__caption">{currentArtwork.name} · {activeIndex + 1} / {artwork.length}</Text> : null}
    <Group gap="xs" justify="center">
      {album.data?.canManage ? <Button component="label" size="xs" variant="default" disabled={busy}>Import pictures<input className="tantalar-picture-editor__file" type="file" aria-label="Import album pictures" multiple accept="image/jpeg,image/png,image/webp" disabled={busy} onChange={event => { const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ""; if (files.length) void importPictures(files); }} /></Button> : null}
      <Button size="xs" variant="subtle" disabled={busy || !currentArtwork} onClick={() => void exportPicture()}>Export picture</Button>
      {album.data?.canManage ? <Button size="xs" variant="subtle" disabled={busy || !currentArtwork} onClick={() => setDeleteId(currentArtwork!.id)}>Delete picture</Button> : null}
    </Group>
    {deleteId ? <div role="group" aria-label="Confirm album deletion"><Text size="sm">Remove this picture from the shared album? Existing profile pictures will stay unchanged.</Text><Group gap="xs" mt="xs"><Button size="xs" variant="default" disabled={busy} onClick={() => setDeleteId(null)}>Cancel</Button><Button size="xs" color="red" loading={busy} onClick={() => void deletePicture()}>Remove from album</Button></Group></div> : null}
    {album.isError ? <Text size="xs" role="alert">Album changes could not be loaded. <button type="button" onClick={() => void album.refetch()}>Retry album</button></Text> : null}
    <label className="tantalar-picture-editor__upload">Upload photo<input type="file" accept="image/jpeg,image/png,image/webp" disabled={busy} onChange={event => { setSelectedArtwork(null); void upload(event.currentTarget.files?.[0]); event.currentTarget.value = ""; }} /></label>
    <Text size="xs" c="dimmed">JPEG, PNG or WebP · Up to 2 MB · Cropped to a square</Text>
    {error ? <Text role="alert" c="var(--tantalar-color-danger)">{error}</Text> : null}
    <Group justify="flex-end"><Button type="button" variant="default" disabled={!choice || busy} onClick={() => { setChoice(null); setSelectedArtwork(null); setPreview(avatar); setError(null); }}>Revert</Button><Button type="button" disabled={!choice} loading={busy} onClick={() => void save()}>Save picture</Button></Group>
  </Stack>;
}
