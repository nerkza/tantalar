# Torrent-native dependency record

The production transport is embedded in the Tantalar plugin process. It does
not start or delegate to qBittorrent, Transmission, Deluge, or another daemon.

| Package | Use | Version | Licence |
| --- | --- | --- | --- |
| `webtorrent` | BitTorrent peer wire, tracker announces, metadata exchange, piece transfer and storage | `1.9.7` | MIT |
| `memory-chunk-store` | Quarantines magnet metadata before Tantalar validates any filesystem path | `1.3.5` | MIT |
| `bittorrent-tracker` | Development-only legal loopback tracker fixture | `11.2.3` | MIT |
| `@types/webtorrent` | Development-only TypeScript declarations | `0.110.2` | MIT |

The release SBOM generator reads the workspace lockfile. These direct and
transitive packages therefore appear in the generated CycloneDX inventory.

## Deliberate version boundary

WebTorrent `1.9.7` is pinned. WebTorrent `2.2.x` uses obsolete JSON import
assertion syntax that does not load on Tantalar's Node 22+ runtime. WebTorrent
`3.x` currently imports a native WebRTC dependency whose build is blocked by
the repository supply-chain policy. Tantalar uses only normal TCP BitTorrent
peers, disables uTP/WebRTC, and must not silently approve native build scripts.

Upgrading the pin requires a fresh licence, vulnerability, Node compatibility,
container build, and loopback transfer review.

## IP advisory reachability review — 2026-09-07

`GHSA-2p57-rm9w-gvfp` affects `ip.isPublic`. The registry has no patched
`ip` release. The installed consumers do not call `isPublic` or `isPrivate`:

- `bittorrent-tracker` 9.19.0 and the development fixture 11.2.3 call only
  `toString`, in their UDP tracker server parser.
- `ip-set` 2.2.0 calls only `cidrSubnet` and `toLong` for blocklist ranges.

The workspace audit excludes this single advisory because the affected
classification function is unreachable through these consumers. All other
high and critical findings still fail CI. Review this exception whenever
these dependency pins change. Remove it when a compatible patched release
becomes available. Do not use `ip` for a network security boundary.
