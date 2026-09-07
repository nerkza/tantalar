import { DenseGrid, initialExplorerQuery, type ExplorerQuery } from "../admin/DenseGrid";
import { useEffect, useState } from "react";
import { ActionNotice, useActionFeedback } from "../components/ActionNotice";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Group, NativeSelect, Stack, Text, TextInput } from "@mantine/core";
import { api, type CatalogItem, type MediaSearchCandidate } from "../api";
import { MediaArtwork } from "../components/MovieMetadata";
import "./media-management.css";

export function LocalCatalogFiles() {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [explorer, setExplorer] = useState<ExplorerQuery>(initialExplorerQuery);
  const [file, setFile] = useState<CatalogItem | null>(null);
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<"movie" | "series">("movie");
  const [episode, setEpisode] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice, noticeSeverity, noticeRevision] = useActionFeedback();
  const files = useQuery({ queryKey: ["admin", "catalog", "files", explorer], queryFn: () => api.catalogPage({ page: explorer.page, pageSize: explorer.pageSize, search: explorer.search, sort: explorer.sort, dir: explorer.desc ? "desc" : "asc", quality: explorer.filters.quality }), placeholderData: keepPreviousData, enabled: open });
  const managed = useQuery({ queryKey: ["admin", "media", "managed"], queryFn: ({ signal }) => api.managedMedia(signal), enabled: open });
  useEffect(() => { const timer = window.setTimeout(() => setQuery(input.trim()), 350); return () => window.clearTimeout(timer); }, [input]);
  const matches = useQuery({ queryKey: ["media", "identify", kind, query], queryFn: ({ signal }) => api.searchMedia(query, kind, signal), enabled: Boolean(file) && query.length >= 2, retry: false });
  const identify = (selected: CatalogItem) => {
    const name = selected.path.split(/[\\/]/).at(-1) ?? "";
    const marker = /\bS(\d{1,3})E(\d{1,4})\b/i.exec(name);
    setFile(selected); setKind(marker || selected.itemKey.startsWith("series-") ? "series" : "movie");
    setEpisode(marker ? `S${marker[1]!.padStart(2, "0")}E${marker[2]!.padStart(2, "0")}` : "");
    setInput(name.replace(/\.[^.]+$/, "").replace(/[._]+/g, " ").split(/\bS\d+E\d+\b|\b(?:19|20)\d{2}\b/i)[0]!.replace(/[\s([\]-]+$/, ""));
    setNotice("");
  };
  const match = async (candidate: MediaSearchCandidate) => {
    if (!file) return;
    if (kind === "series" && !/^S\d{2,3}E\d{2,4}$/.test(episode)) { setNotice("Enter an episode, for example S01E01.", "error"); return; }
    setBusy(true); setNotice("");
    try {
      const existing = managed.data?.items.find(item => item.kind === candidate.kind && item.provider === candidate.provider && item.externalId === candidate.externalId);
      const item = existing ?? (await api.addManagedMedia(candidate, { monitored: false, monitorMode: "none", qualityProfile: "any", minimumAvailability: "released", languages: "" })).item;
      await api.matchManagedMedia(item.kind, item.id, file.fileId, item.kind === "series" ? episode : undefined);
      await client.invalidateQueries({ queryKey: ["admin"] });
      await client.invalidateQueries({ queryKey: ["library"] });
      setFile(null); setNotice(`Matched to ${candidate.title}.`);
    } catch (error) { setNotice(error instanceof Error ? error.message : "The file could not be matched.", "error"); }
    finally { setBusy(false); }
  };
  return <details className="local-files" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Local files and identification</summary>
    <Stack gap="sm" mt="md">
      <ActionNotice message={notice} title="File identification" severity={noticeSeverity} revision={noticeRevision} />
      {files.isError ? <Alert color="red">{files.error.message}</Alert> : null}
      <DenseGrid testId="local-files-grid" ariaLabel="local files" data={files.data?.items ?? []} total={files.data?.total ?? 0} onQueryChange={setExplorer} loading={files.isFetching} defaultView="list"
        emptyMessage="No catalog files. Scan a configured library to find local media."
        filters={[{ id: "quality", label: "Quality", options: ["2160p", "1080p", "720p", "480p"].map(value => ({ value, label: value })) }]}
        columns={[
          { id: "path", header: "File", accessorKey: "path", size: 400 },
          { id: "itemKey", header: "Identity", accessorKey: "itemKey", enableSorting: false, size: 240 },
          { id: "quality", header: "Quality", accessorKey: "quality", size: 90, meta: { labelFilter: true } },
          { id: "importedAt", header: "Imported", accessorKey: "importedAt", size: 130, cell: ({ row }) => new Date(row.original.importedAt).toLocaleDateString() },
          { id: "actions", header: "Identification", enableHiding: false, size: 340, cell: ({ row }) => { const item = row.original; return <><Button variant="default" size="xs" onClick={() => identify(item)}>Identify</Button>        {file?.fileId === item.fileId ? <Stack className="local-file-identify" gap="sm">
          <Group align="end"><TextInput label="Find title" value={input} autoFocus onChange={event => setInput(event.currentTarget.value)} /><NativeSelect label="Media type" value={kind} onChange={event => setKind(event.currentTarget.value as "movie" | "series")} data={[{ value: "movie", label: "Movie" }, { value: "series", label: "Series" }]} />{kind === "series" ? <TextInput label="Episode" placeholder="S01E01" value={episode} onChange={event => setEpisode(event.currentTarget.value.toUpperCase())} /> : null}<Button variant="subtle" onClick={() => setFile(null)}>Cancel</Button></Group>
          {matches.isFetching ? <Text size="sm" role="status">Searching metadata…</Text> : null}
          {matches.isError ? <Alert color="red">{matches.error.message}</Alert> : null}
          {matches.data?.candidates.map(candidate => <Group key={`${candidate.provider}:${candidate.externalId}`} wrap="nowrap" align="flex-start"><MediaArtwork src={candidate.artworkUrl} title={candidate.title} compact /><div><Text fw={600}>{candidate.title}{candidate.year ? ` (${candidate.year})` : ""}</Text><Text size="sm" lineClamp={2}>{candidate.overview}</Text><Button size="xs" mt="xs" variant="default" disabled={busy || matches.isFetching || query !== input.trim()} onClick={() => void match(candidate)}>Use this {kind}</Button></div></Group>)}
          {matches.data?.candidates.length === 0 ? <Text size="sm">No matching titles.</Text> : null}
        </Stack> : null}</>; } },
        ]}
      />
    </Stack>
  </details>;
}
