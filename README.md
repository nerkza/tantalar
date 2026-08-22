# Tantalar

One self-hosted web app to replace the Plex + \*arr + downloader stack. Library serving, wanted-list automation, indexer search, NZB/torrent acquisition, and post-processing — built "everything is a module/plugin" from the ground up.

- **PRD**: [PRD.md](./PRD.md) (source of truth also at `/srv/knowledge_base/wiki/projects/tantalar/prd.md`)
- **Status**: pre-development — PRD complete, roadmap pending
- **License**: MIT (planned)
- **Stack (planned)**: TypeScript end-to-end · React + Mantine · ffmpeg/HLS · SQLite default / Postgres optional · single Docker image

## Layout (planned)

Single monorepo for v1; split into separate repos later only if the plugin ecosystem demands it. Exception: `marketing-site/` is its own repo (public site, separate deploy lifecycle).

```
tantalar_master/
├── PRD.md              # product requirements
├── docs/               # design docs, ADRs
├── server/             # core kernel + built-in modules
├── web/                # admin UI + player UI (React)
├── sdk/                # public plugin contract + conformance tests
└── marketing-site/     # own repo — Starlight marketing site + public wiki (launch-phase, low priority)
```
