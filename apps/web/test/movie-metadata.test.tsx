import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MediaArtwork, MovieDetails, movieSummary } from "../src/components/MovieMetadata";
import { CatalogPage } from "../src/pages/ProductPages";
import { api, type LibraryItem } from "../src/api";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

Object.defineProperty(window, "matchMedia", { writable: true, value: (query: string) => ({
  matches: false, media: query, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
}) });

it("keeps accessible artwork fallback and retries when the source changes", () => {
  const { rerender } = render(<MediaArtwork title="Movie" src="/poster" />);
  const poster = screen.getByRole("img", { name: "Movie poster" });
  expect(poster.getAttribute("loading")).toBe("lazy");
  fireEvent.error(poster);
  expect(screen.getByRole("img", { name: "Movie poster unavailable" })).toBeTruthy();
  rerender(<MediaArtwork title="Movie" src="/replacement" />);
  expect(screen.getByRole("img", { name: "Movie poster" }).getAttribute("src")).toBe("/replacement");
});

it("shows canonical movie facts and manual text from browse through details to playback", async () => {
  const item: LibraryItem = {
    fileId: "f1", itemKey: "movie-1", kind: "movie", libraryId: "l1", title: "Manual title", year: 2001, overview: "Manual overview",
    artworkUrl: "/poster", backdropUrl: "/backdrop", metadataSnapshot: {
      kind: "movie", name: "Provider title", externalId: "tmdb-1", provider: "tmdb", overview: "Provider overview", year: 2026,
      originalTitle: null, tagline: null, releaseDate: "2026-08-01", runtimeMinutes: 101, genres: ["Drama"], certification: "PG",
      status: "Released", originalLanguage: "en", rating: 7.5, voteCount: 42, posterPath: "/poster.jpg", backdropPath: "/backdrop.jpg",
      externalIds: {}, locale: "en-GB", fetchedAt: "2026-09-05T00:00:00Z", source: "hosted",
    },
  };
  vi.spyOn(api, "browsePage").mockResolvedValue({ items: [item], collections: [], continueWatching: [] });
  const onWatch = vi.fn();
  render(<MantineProvider><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <CatalogPage heading="Movies" kindFilter="movie" onWatch={onWatch} />
  </QueryClientProvider></MantineProvider>);
  fireEvent.click(await screen.findByRole("button", { name: "Details for Manual title" }));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByText("2001 · 101 min · PG")).toBeTruthy();
  expect(within(dialog).getByText("Manual overview")).toBeTruthy();
  expect(within(dialog).getByText("Drama")).toBeTruthy();
  expect(within(dialog).getByText("2026-08-01")).toBeTruthy();
  expect(within(dialog).getByText("7.5/10 (42 votes)")).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Play Manual title" }));
  expect(onWatch).toHaveBeenCalledWith("f1");
});

it("keeps legacy movie details readable without a snapshot", () => {
  render(<MovieDetails item={{ title: "Legacy", overview: "Legacy overview" }} />);
  expect(screen.getByText("Year unavailable · Runtime unavailable")).toBeTruthy();
  expect(screen.getByText("Legacy overview")).toBeTruthy();
  expect(screen.getByRole("img", { name: "Legacy backdrop unavailable" })).toBeTruthy();
});

it("offers series details with air dates and typical episode runtime", async () => {
  const item: LibraryItem = { fileId: "episode", itemKey: "series-1:S01E01", kind: "series", libraryId: "l1", title: "Series", metadataSnapshot: {
    kind: "series", name: "Series", externalId: "tmdb-1", provider: "tmdb", overview: "Series overview", year: 2024,
    originalTitle: null, tagline: null, releaseDate: "2024-01-01", lastAirDate: "2026-09-01", runtimeMinutes: 48,
    genres: ["Drama"], certification: null, status: "Returning Series", originalLanguage: "en", rating: 8, voteCount: 10,
    posterPath: null, backdropPath: null, externalIds: {}, locale: "en-GB", fetchedAt: "2026-09-06T00:00:00Z", source: "hosted",
  } };
  vi.spyOn(api, "browsePage").mockResolvedValue({ items: [item], collections: [], continueWatching: [] });
  render(<MantineProvider><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><CatalogPage heading="Series" kindFilter="series" onWatch={() => {}} /></QueryClientProvider></MantineProvider>);
  fireEvent.click(await screen.findByRole("button", { name: "Details for Series" }));
  const dialog = await screen.findByRole("dialog");
  for (const value of ["First aired", "Last aired", "2024-01-01", "2026-09-01", "Returning series", "2024 · 48 min typical episode"]) expect(within(dialog).getByText(value)).toBeTruthy();
  expect(movieSummary({ ...item, episode: { episodeKey: "S01E01", title: "First steps", airDate: "2024-01-02", runtimeMinutes: 42 } })).toBe("2024-01-02 · 42 min");
  expect(movieSummary({ ...item, episode: { episodeKey: "S01E01", title: "First steps" } })).toBe("2024 · Runtime unavailable");
});
