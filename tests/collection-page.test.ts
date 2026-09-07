import { expect, it } from "vitest";
import { collectionPage, collectionFacets } from "../apps/server/src/collection-page.js";
import { movieSnapshot } from "../plugins/metadata-tmdb-tvdb/src/tmdb.js";

it("combines exact labels, search, numeric sorting and bounded pages without mutating source rows", () => {
  const items = [{ title: "Movie 2", year: 2001, actors: ["Sam", "Lee"] }, { title: "Movie 10", year: 2001, actors: ["Sam"] }, { title: "Movie 1", year: 2026, actors: ["Lee"] }];
  const fields = { title: (i: typeof items[number]) => i.title, year: (i: typeof items[number]) => i.year, actors: (i: typeof items[number]) => i.actors };
  expect(collectionPage(items, { search: "movie", filter_actors: "Sam", filter_year: "2001", sort: "title", desc: "true", pageSize: "1", page: "2" }, fields)).toEqual({ items: [items[0]], total: 2 });
  expect(collectionPage(items, { filter_actors: "Sa" }, fields).total).toBe(0);
  expect(collectionPage(items, { page: "-1", pageSize: "Infinity", sort: "__proto__" }, fields).items).toEqual(items);
  expect(collectionFacets(items, fields)).toEqual({ year: ["2001", "2026"], actors: ["Lee", "Sam"] });
  expect(items[0]?.title).toBe("Movie 2");
});

it("normalizes cast and director credits while excluding other crew jobs", () => {
  const snapshot = movieSnapshot({ id: 1, title: "Movie", credits: { cast: [{ name: " Sam " }, { name: "Sam" }, null], crew: [{ name: "Lee", job: "Director" }, { name: "Pat", job: "Producer" }] } }, { externalId: "tmdb-1", locale: "en-GB", fetchedAt: new Date().toISOString(), source: "hosted" });
  expect(snapshot?.actors).toEqual(["Sam"]);
  expect(snapshot?.directors).toEqual(["Lee"]);
});
