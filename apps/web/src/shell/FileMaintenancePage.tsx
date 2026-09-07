import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Alert, Button, Group, NumberInput, Select, Stack, Text } from "@mantine/core";
import { api, type FileMaintenancePreview } from "../api";
import { DenseGrid } from "../admin/DenseGrid";
import { ActionNotice, useActionFeedback } from "../components/ActionNotice";

export function FileMaintenancePage() {
  const libraries = useQuery({ queryKey: ["libraries"], queryFn: api.libraries });
  const [libraryId, setLibraryId] = useState<string | null>(null);
  const [kind, setKind] = useState<"rename" | "recycle">("rename");
  const [page, setPage] = useState<number | string>(1);
  const [scheme, setScheme] = useState("default");
  const schemes = useQuery({ queryKey: ["naming", "schemes"], queryFn: api.namingSchemes });
  const [preview, setPreview] = useState<FileMaintenancePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage, severity, revision] = useActionFeedback();
  const reset = () => setPreview(null);
  async function loadPreview() {
    if (!libraryId) return;
    reset(); setBusy(true);
    try { setPreview(await api.filePreview({ libraryId, kind, scheme, page: Number(page) || 1 })); }
    catch (error) { setMessage((error as Error).message, "error"); }
    finally { setBusy(false); }
  }
  async function apply() {
    if (!preview) return;
    setBusy(true);
    try { await api.applyFilePreview(preview.token); reset(); setMessage("File maintenance started. Check Runs for its result."); }
    catch (error) { setMessage((error as Error).message, "error"); }
    finally { setBusy(false); }
  }
  const changes = preview?.kind === "rename" ? preview.items.filter(i => i.source !== i.destination).length : preview?.entries.filter(i => i.expired).length ?? 0;
  return <Stack gap="md">
    <ActionNotice title="File maintenance" message={message} severity={severity} revision={revision} />
    {libraries.isError && <Alert color="red" title="Libraries unavailable">{(libraries.error as Error).message}</Alert>}
    <Group align="end">
      <Select label="Library" value={libraryId} onChange={id => { setLibraryId(id); reset(); }} data={(libraries.data?.libraries ?? []).filter(l => l.enabled).map(l => ({ value: l.id, label: l.name }))} maw={300} searchable />
      <Select label="Operation" value={kind} onChange={v => { setKind(v === "recycle" ? "recycle" : "rename"); reset(); }} data={[{ value: "rename", label: "Rename files" }, { value: "recycle", label: "Recycle-bin cleanup" }]} />
      {kind === "rename" && <><Select label="Naming scheme" value={scheme} onChange={v => { setScheme(v ?? "default"); reset(); }} data={schemes.data?.schemes.map(s => s.name) ?? ["default"]} /><NumberInput label="Batch (100 files)" value={page} min={1} max={100000} allowDecimal={false} w={150} onChange={v => { setPage(v); reset(); }} /></>}
      <Button variant="default" disabled={!libraryId} loading={busy} onClick={() => void loadPreview()}>Preview</Button>
    </Group>
    {kind === "rename" ? <Text size="sm" c="dimmed">Preview expires after 24 hours. Unidentified media must be matched before renaming. Each batch contains up to 100 files.</Text>
      : <Text size="sm" c="dimmed">Only expired files in Tantalar’s recycle bin can be removed. Cleanup permanently deletes those files.</Text>}
    {preview?.kind === "rename" && <DenseGrid testId="rename-preview" ariaLabel="Rename preview" data={preview.items} columns={[
      { id: "source", header: "Current path", accessorKey: "source", size: 360 }, { id: "destination", header: "New path", accessorKey: "destination", size: 360 },
      { id: "result", header: "Result", accessorFn: i => i.error ?? (i.source === i.destination ? "Unchanged" : "Rename"), size: 280 },
    ]} />}
    {preview?.kind === "recycle" && <DenseGrid testId="recycle-preview" ariaLabel="Recycle-bin preview" data={preview.entries} columns={[
      { id: "name", header: "File", accessorKey: "name", size: 350 }, { id: "recycledAt", header: "Recycled", accessorKey: "recycledAt", size: 200, cell: c => new Date(String(c.getValue())).toLocaleString() },
      { id: "size", header: "Size (MB)", accessorKey: "size", size: 130, cell: c => (Number(c.getValue()) / 1048576).toFixed(1) }, { id: "expired", header: "Action", accessorFn: i => i.expired ? "Permanently delete" : "Keep", size: 160 },
    ]} />}
    {preview && <Group><Text size="sm">{changes} files will change.</Text><Button color={kind === "recycle" ? "red" : undefined} loading={busy} disabled={!changes || preview.items.some(i => i.error)} onClick={() => void apply()}>{kind === "rename" ? "Apply rename plan" : "Delete expired files"}</Button></Group>}
  </Stack>;
}
