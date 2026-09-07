const TMDB_ORIGIN = "https://api.themoviedb.org/3";

interface RoutedRequest {
  readonly upstream: URL;
  readonly cacheSeconds: number;
  readonly route: string;
}

function jsonError(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function integer(value: string | null, minimum: number, maximum: number): number | null {
  if (value === null || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

function validateQuery(input: URL, allowed: ReadonlySet<string>): Response | null {
  for (const key of input.searchParams.keys()) {
    if (!allowed.has(key)) return jsonError(400, "invalid_query", "Unsupported query parameter");
    if (input.searchParams.getAll(key).length !== 1) return jsonError(400, "invalid_query", "Repeated query parameter");
  }
  const language = input.searchParams.get("language");
  if (language !== null && !/^[a-z]{2}(?:-[A-Z]{2})?$/.test(language)) {
    return jsonError(400, "invalid_query", "Invalid language value");
  }
  const page = input.searchParams.get("page");
  if (page !== null && integer(page, 1, 500) === null) return jsonError(400, "invalid_query", "Invalid page value");
  return null;
}

export function routeRequest(input: URL): RoutedRequest | Response {
  if (input.pathname === "/v1/tmdb/configuration") {
    const error = validateQuery(input, new Set());
    return error ?? { upstream: new URL("/3/configuration", TMDB_ORIGIN), cacheSeconds: 604_800, route: "configuration" };
  }

  const season = /^\/v1\/tmdb\/tv\/(\d+)\/season\/(\d+)$/.exec(input.pathname);
  if (season) {
    const id = integer(season[1] ?? null, 1, 2_147_483_647);
    const number = integer(season[2] ?? null, 0, 999);
    if (id === null || number === null) return jsonError(400, "invalid_path", "Invalid TMDB series or season identifier");
    const error = validateQuery(input, new Set(["language"]));
    if (error) return error;
    const upstream = new URL(`/3/tv/${id}/season/${number}`, TMDB_ORIGIN);
    upstream.search = input.search;
    return { upstream, cacheSeconds: 86_400, route: "season" };
  }

  const details = /^\/v1\/tmdb\/(movie|tv)\/(\d+)$/.exec(input.pathname);
  if (details) {
    const id = integer(details[2] ?? null, 1, 2_147_483_647);
    if (id === null) return jsonError(400, "invalid_path", "Invalid TMDB title identifier");
    const isMovie = details[1] === "movie";
    const error = validateQuery(input, new Set(isMovie ? ["language", "append_to_response"] : ["language"]));
    if (error) return error;
    if (isMovie) {
      const append = input.searchParams.get("append_to_response");
      if (append !== null && append !== "external_ids,release_dates" && append !== "external_ids,release_dates,credits") {
        return jsonError(400, "invalid_query", "Unsupported appended response");
      }
    }
    const upstream = new URL(`/3/${details[1]}/${id}`, TMDB_ORIGIN);
    upstream.search = input.search;
    return { upstream, cacheSeconds: 86_400, route: `${details[1]}-details` };
  }

  const search = /^\/v1\/tmdb\/search\/(movie|tv)$/.exec(input.pathname);
  if (search) {
    const yearKey = search[1] === "movie" ? "year" : "first_air_date_year";
    const error = validateQuery(input, new Set(["query", yearKey, "language", "page"]));
    if (error) return error;
    const query = input.searchParams.get("query")?.trim() ?? "";
    if (query.length < 2 || query.length > 120) return jsonError(400, "invalid_query", "Search query must contain 2 to 120 characters");
    const year = input.searchParams.get(yearKey);
    if (year !== null && integer(year, 1874, 2100) === null) return jsonError(400, "invalid_query", "Invalid year value");
    const upstream = new URL(`/3/search/${search[1]}`, TMDB_ORIGIN);
    upstream.search = input.search;
    upstream.searchParams.set("query", query);
    return { upstream, cacheSeconds: 3_600, route: `${search[1]}-search` };
  }

  return jsonError(404, "not_found", "Route not found");
}

function upstreamError(status: number): Response {
  if (status === 404) return jsonError(404, "not_found", "Metadata record not found");
  if (status === 429) return jsonError(429, "rate_limited", "Metadata provider rate limit reached");
  if (status === 401 || status === 403 || status >= 500) {
    return jsonError(503, "unavailable", "Metadata service unavailable");
  }
  return jsonError(502, "upstream_error", "Metadata provider request failed");
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const input = new URL(request.url);
    if (input.pathname === "/healthz") {
      return Response.json({ status: "ok" }, { headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
    }
    if (request.method !== "GET") {
      const response = jsonError(405, "method_not_allowed", "Only GET is supported");
      response.headers.set("allow", "GET");
      return response;
    }

    const routed = routeRequest(input);
    if (routed instanceof Response) return routed;

    const clientIp = request.headers.get("CF-Connecting-IP") ?? "unknown";
    // ponytail: Per-IP is the smallest useful ceiling. Add instance tokens if shared NATs or abuse make it inaccurate.
    const rate = await env.RATE_LIMITER.limit({ key: clientIp });
    if (!rate.success) return jsonError(429, "rate_limited", "Metadata request rate limit reached");

    const cacheUrl = new URL(request.url);
    cacheUrl.search = routed.upstream.search;
    const cacheKey = new Request(cacheUrl, { method: "GET" });
    const cached = await caches.default.match(cacheKey);
    if (cached) return cached;

    if (!env.TMDB_API_TOKEN) return jsonError(503, "unavailable", "Metadata service unavailable");

    const upstreamUrl = new URL(routed.upstream);
    const headers = new Headers({ accept: "application/json" });
    if (/^[a-f\d]{32}$/i.test(env.TMDB_API_TOKEN)) {
      upstreamUrl.searchParams.set("api_key", env.TMDB_API_TOKEN);
    } else {
      headers.set("authorization", `Bearer ${env.TMDB_API_TOKEN}`);
    }

    let upstream: Response;
    try {
      upstream = await fetch(upstreamUrl, {
        headers,
      });
    } catch {
      console.error(JSON.stringify({ event: "tmdb_upstream_error", route: routed.route }));
      return jsonError(503, "unavailable", "Metadata service unavailable");
    }

    if (!upstream.ok) {
      if (upstream.status !== 404) {
        console.error(JSON.stringify({ event: "tmdb_upstream_failure", route: routed.route, status: upstream.status }));
      }
      return upstreamError(upstream.status);
    }
    if (!upstream.headers.get("content-type")?.includes("application/json")) {
      console.error(JSON.stringify({ event: "tmdb_upstream_content_type", route: routed.route }));
      return jsonError(502, "upstream_error", "Metadata provider returned an invalid response");
    }

    const response = new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": `public, max-age=${routed.cacheSeconds}`,
        "x-content-type-options": "nosniff",
      },
    });
    ctx.waitUntil(caches.default.put(cacheKey, response.clone()));
    return response;
  },
} satisfies ExportedHandler<Env>;

export default worker;
