import { DenseGrid } from "../admin/DenseGrid";
import { ActionNotice, useActionFeedback } from "../components/ActionNotice";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Group, NativeSelect, Stack, Text, TextInput, Title } from "@mantine/core";
import { api, type ManagedMediaItem } from "../api";
import { MediaArtwork, MovieDetails } from "../components/MovieMetadata";
import type { ManagedReleaseTarget } from "./OperationsViews";
import "./media-management.css";

export function TitleTags({ item }: { item: ManagedMediaItem }) {
  const client = useQueryClient();
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const update = async (tags: string[]) => {
    setBusy(true);
    setError("");
    try {
      await api.setManagedTags(item.kind, item.id, tags);
      setInput("");
      await client.invalidateQueries({ queryKey: ["admin", "media", "managed"] });
    } catch (error) { setError(error instanceof Error ? error.message : "Tags could not be saved."); }
    finally { setBusy(false); }
  };
  return <details className="media-tags">
    <summary>Tags{item.tags?.length ? ` (${item.tags.length})` : ""}</summary>
    <ActionNotice message={error} title="Tags could not be saved" severity="error" />
    <ul>{item.tags?.map(tag => <li key={tag}><span>{tag}</span><Button size="compact-xs" variant="subtle" disabled={busy} aria-label={`Remove tag ${tag}`} onClick={() => void update(item.tags!.filter(value => value !== tag))}>Remove</Button></li>)}</ul>
    <Group align="end" wrap="nowrap"><TextInput label="New tag" value={input} onChange={event => setInput(event.currentTarget.value)} maxLength={40} /><Button type="button" variant="default" disabled={busy || !input.trim() || (item.tags?.length ?? 0) >= 30} onClick={() => void update([...new Set([...(item.tags ?? []), input.trim().toLowerCase()])])}>Add tag</Button></Group>
  </details>;
}

export function ReleaseSearchPage({ target }: { target: ManagedReleaseTarget }) {
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [episode, setEpisode] = useState(target.episodeKey ?? "");
  const [grabbing, setGrabbing] = useState<string | null>(null);
  const [notice, setNotice, noticeSeverity, noticeRevision] = useActionFeedback();
  const detail = useQuery({ queryKey: ["admin", "media", "managed", target.kind, target.id, "detail"], queryFn: ({ signal }) => api.managedMediaDetail(target.kind, target.id, signal), retry: false });
  const item = detail.data?.item;
  useEffect(() => {
    const timer = window.setTimeout(() => { setQuery(input.trim()); }, 350);
    return () => window.clearTimeout(timer);
  }, [input]);
  useEffect(() => { if (!episode && item?.episodes[0]) setEpisode(item.episodes[0].episodeKey); }, [item, episode]);
  const releases = useQuery({
    queryKey: ["admin", "media", "managed", target.kind, target.id, "releases", episode, query],
    queryFn: ({ signal }) => api.managedReleases(target.kind, target.id, signal, episode || undefined, query),
    enabled: target.kind === "movie" || Boolean(episode), retry: false,
  });
  const indexers = useQuery({ queryKey: ["admin", "indexers"], queryFn: api.indexers, retry: false });
  const rows = [...(releases.data?.releases ?? [])].sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity));
  const grab = async (releaseId: string) => {
    setGrabbing(releaseId); setNotice("");
    try { await api.grabManagedRelease(target.kind, target.id, releaseId, episode || undefined, query); setNotice("Release queued."); }
    catch (error) { setNotice(error instanceof Error ? error.message : "Dispatch failed.", "error"); }
    finally { setGrabbing(null); }
  };
  return <Stack className="release-page" gap="lg">
    <a href="#/admin/media/managed" className="media-back">Managed titles</a>
    <header className="release-heading">
      {item ? <MediaArtwork src={item.artworkUrl} title={item.title} /> : null}
      <div><Title order={1}>{item?.title ?? "Release search"}</Title>
        <Text c="dimmed" size="sm">{target.kind === "movie" ? "Movie" : "Series"}{item?.year ? ` · ${item.year}` : ""}{item?.qualityProfile ? ` · ${item.qualityProfile.toUpperCase()}` : ""}</Text>
        {item?.overview ? <Text size="sm" lineClamp={3} mt="sm">{item.overview}</Text> : null}
        {item ? <><TitleTags item={item} />{item.kind === "movie" ? <details className="media-tags"><summary>Metadata</summary><MovieDetails item={item} /></details> : null}</> : null}
      </div>
    </header>
    {detail.isError ? <Alert color="red">{detail.error.message}</Alert> : null}
    <section aria-labelledby="release-search-heading">
      <Title order={2} id="release-search-heading" size="h3" mb="sm">Releases</Title>

    </section>
      <ActionNotice message={notice} title={noticeSeverity === "success" ? "Release queued" : "Download failed"} severity={noticeSeverity} revision={noticeRevision} />
    {releases.isError ? <Alert color="red" role="alert">{releases.error.message}</Alert> : null}
    {releases.isFetching ? <Text role="status" size="sm">Searching indexers…</Text> : null}
    <ActionNotice message={releases.data?.failures.length ? `${releases.data.failures.length} indexer connections failed. Check Acquisition → Indexers.` : null} title="Release search incomplete" severity="warning" />
    <DenseGrid testId="releases-grid" ariaLabel="releases" data={rows} defaultView="list" loading={releases.isFetching} paginationResetKey={`${query}:${episode}`}
      searchControl={<TextInput aria-label="Search indexers" placeholder={item ? `${item.title}${item.year ? ` ${item.year}` : ""}` : "Title or release name"} value={input} onChange={event => setInput(event.currentTarget.value)} maxLength={300} autoFocus />}
      toolbarStart={<>{target.kind === "series" ? <NativeSelect aria-label="Episode" value={episode} onChange={event => setEpisode(event.currentTarget.value)} data={item?.episodes.map(value => ({ value: value.episodeKey, label: value.episodeKey })) ?? []} /> : null}<Button variant="default" onClick={() => void releases.refetch()} loading={releases.isFetching}>Refresh</Button></>}
      emptyMessage="No matching releases."
      filters={[
        { id: "kind", label: "Source", options: [{ value: "nzb", label: "Usenet" }, { value: "torrent", label: "Torrent" }] },
        { id: "quality", label: "Quality", options: [...new Set(rows.map(release => release.quality))].sort().map(value => ({ value, label: value })) },
        { id: "accepted", label: "Eligibility", options: [{ value: "true", label: "Accepted" }, { value: "false", label: "Rejected" }] },
      ]}
      columns={[
        { id: "title", header: "Release", accessorFn: release => release.title, size: 480 },
        { id: "quality", header: "Quality", accessorKey: "quality", size: 90, meta: { labelFilter: true } },
        { id: "sizeBytes", header: "Size", accessorKey: "sizeBytes", size: 95, cell: ({ row }) => `${(row.original.sizeBytes / 1024 ** 3).toFixed(1)} GB`, meta: { dataType: "number" } },
        { id: "kind", header: "Source", accessorKey: "kind", size: 95, cell: ({ row }) => row.original.kind === "nzb" ? "Usenet" : "Torrent" },
        { id: "indexerId", header: "Indexer", accessorFn: release => indexers.data?.indexers.find(indexer => indexer.id === release.indexerId)?.name ?? "Indexer", size: 140 },
        { id: "publishedAt", header: "Published", accessorKey: "publishedAt", size: 110, cell: ({ row }) => new Date(row.original.publishedAt).toLocaleDateString() },
        { id: "seeders", header: "Seeders", accessorKey: "seeders", size: 85 },
        { id: "accepted", header: "Eligibility", accessorKey: "accepted", size: 250, cell: ({ row: { original: release } }) => <details><summary>{release.accepted ? "Accepted" : "Rejected"}{release.rank === 0 ? " · Best match" : ""}</summary><ul>{release.reasons.map(reason => <li key={reason.code}>{reason.message}</li>)}</ul></details> },
        { id: "actions", header: "Actions", enableHiding: false, size: 90, cell: ({ row: { original: release } }) => <Button variant={release.accepted ? "filled" : "default"} size="sm" disabled={!release.accepted || grabbing !== null || releases.isFetching || query !== input.trim()} loading={grabbing === release.releaseId} onClick={() => void grab(release.releaseId)}>Grab</Button> },
      ]}
    />
  </Stack>;
}
