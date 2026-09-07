import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { routeRequest } from "../apps/metadata-gateway/src/index.js";
import { movieDetailsUrl, movieSearchUrl, movieSnapshot } from "../plugins/metadata-tmdb-tvdb/src/tmdb.js";

const env = {
  TMDB_API_TOKEN: "server-secret",
  RATE_LIMITER: { limit: vi.fn(async () => ({ success: true })) },
};

const ctx = {
  waitUntil: vi.fn(),
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("metadata gateway", () => {
  it("allows only the required TMDB routes and parameters", async () => {
    expect(movieSearchUrl("https://metadata.tantalar.app/v1/tmdb", "", "Alien", 1979, "en-US"))
      .toBe("https://metadata.tantalar.app/v1/tmdb/search/movie?query=Alien&year=1979&language=en-US");

    const allowed = routeRequest(new URL("https://metadata.tantalar.app/v1/tmdb/search/movie?query=Alien&year=1979&language=en-US"));
    expect(allowed).not.toBeInstanceOf(Response);
    if (!(allowed instanceof Response)) {
      expect(allowed.upstream.toString()).toBe("https://api.themoviedb.org/3/search/movie?query=Alien&year=1979&language=en-US");
    }

    const detailsUrl = movieDetailsUrl("https://metadata.tantalar.app/v1/tmdb", "", 348, "en-GB");
    expect(detailsUrl).toBe("https://metadata.tantalar.app/v1/tmdb/movie/348?append_to_response=external_ids%2Crelease_dates%2Ccredits&language=en-GB");
    const details = routeRequest(new URL(detailsUrl));
    expect(details).not.toBeInstanceOf(Response);
    const appendInjection = routeRequest(new URL("https://metadata.tantalar.app/v1/tmdb/movie/348?append_to_response=credits"));
    expect(appendInjection).toBeInstanceOf(Response);
    expect((appendInjection as Response).status).toBe(400);

    const openProxyAttempt = routeRequest(new URL("https://metadata.tantalar.app/v1/tmdb/person/1"));
    expect(openProxyAttempt).toBeInstanceOf(Response);
    expect((openProxyAttempt as Response).status).toBe(404);

    const keyInjection = routeRequest(new URL("https://metadata.tantalar.app/v1/tmdb/search/tv?query=Severance&api_key=stolen"));
    expect(keyInjection).toBeInstanceOf(Response);
    expect((keyInjection as Response).status).toBe(400);
  });

  it("normalizes one complete movie snapshot", () => {
    const snapshot = movieSnapshot({
      id: 348,
      title: "Alien",
      original_title: "Alien",
      overview: "In space no one can hear you scream.",
      tagline: "In space no one can hear you scream.",
      release_date: "1979-05-25",
      runtime: 117,
      genres: [{ name: "Horror" }, { name: "Science Fiction" }],
      status: "Released",
      original_language: "en",
      vote_average: 8.2,
      vote_count: 15000,
      poster_path: "/poster.jpg",
      backdrop_path: "/backdrop.jpg",
      imdb_id: "tt0078748",
      external_ids: { imdb_id: "tt0078748", wikidata_id: "Q24962" },
      release_dates: { results: [{ iso_3166_1: "GB", release_dates: [{ certification: "15", type: 3 }] }] },
    }, { externalId: "tmdb-348", locale: "en-GB", fetchedAt: "2026-08-31T12:00:00.000Z", source: "hosted" });

    expect(snapshot).toEqual(expect.objectContaining({
      externalId: "tmdb-348",
      name: "Alien",
      originalTitle: "Alien",
      releaseDate: "1979-05-25",
      year: 1979,
      runtimeMinutes: 117,
      genres: ["Horror", "Science Fiction"],
      certification: "15",
      posterPath: "/poster.jpg",
      backdropPath: "/backdrop.jpg",
      externalIds: { tmdb: "348", imdb: "tt0078748", wikidata: "Q24962" },
      locale: "en-GB",
      source: "hosted",
    }));
  });

  it("adds the server credential, caches the response, and never returns the credential", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://api.themoviedb.org/3/search/tv?query=Severance&language=en-US");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer server-secret");
      return Response.json({ results: [{ id: 95396, name: "Severance" }] });
    });
    const put = vi.fn(async () => undefined);
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("caches", { default: { match: vi.fn(async () => undefined), put } });

    const response = await worker.fetch(
      new Request("https://metadata.tantalar.app/v1/tmdb/search/tv?query=Severance&language=en-US", {
        headers: { "CF-Connecting-IP": "203.0.113.9" },
      }),
      env as never,
      ctx as never,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain("server-secret");
    expect(env.RATE_LIMITER.limit).toHaveBeenCalledWith({ key: "203.0.113.9" });
    expect(put).toHaveBeenCalledOnce();
    expect(ctx.waitUntil).toHaveBeenCalledOnce();
  });

  it("supports a server-side TMDB v3 API key", async () => {
    const apiKey = "0123456789abcdef0123456789abcdef";
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const upstream = new URL(String(input));
      expect(upstream.origin + upstream.pathname).toBe("https://api.themoviedb.org/3/search/movie");
      expect(upstream.searchParams.get("query")).toBe("Alien");
      expect(upstream.searchParams.get("api_key")).toBe(apiKey);
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      return Response.json({ results: [{ id: 348, title: "Alien" }] });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("caches", { default: { match: vi.fn(async () => undefined), put: vi.fn(async () => undefined) } });

    const response = await worker.fetch(
      new Request("https://metadata.tantalar.app/v1/tmdb/search/movie?query=Alien", {
        headers: { "CF-Connecting-IP": "203.0.113.9" },
      }),
      { ...env, TMDB_API_TOKEN: apiKey } as never,
      ctx as never,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain(apiKey);
  });

  it("stops requests that exceed the gateway ceiling", async () => {
    env.RATE_LIMITER.limit.mockResolvedValueOnce({ success: false });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("caches", { default: { match: vi.fn(), put: vi.fn() } });

    const response = await worker.fetch(
      new Request("https://metadata.tantalar.app/v1/tmdb/movie/550"),
      env as never,
      ctx as never,
    );

    expect(response.status).toBe(429);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
