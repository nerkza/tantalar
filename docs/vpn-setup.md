# Download VPN setup

Tantalar can route Native Torrent and Native Usenet through one shared WireGuard tunnel. Choose protection per client. Control, metadata, playback and external download applications keep their existing network routes.

## Prepare the runtime

Open Administration → Acquisition → VPN. The runtime check identifies missing tools and privileges. Native macOS and Windows processes cannot use this controller; run Tantalar in a Linux container or on a Linux host.

For Docker, download the settings override from the VPN panel or use [`docker/compose.vpn.yml`](../docker/compose.vpn.yml). From the repository root, run:

```sh
docker compose -f docker/compose.sqlite.yml -f docker/compose.vpn.yml up -d --build
```

Use your existing base Compose file and project name. For PostgreSQL, replace `compose.sqlite.yml` with `compose.postgres.yml`. Preserve existing data volumes and mounts. The override installs `wireguard-tools`, `iproute2`, `nftables` and `util-linux` at container startup. Package installation needs network access; startup stops if installation fails. These external tools are installed by the operator, not bundled into the distributed application.

The controller needs `NET_ADMIN`, `SYS_ADMIN`, kernel WireGuard support and permission to create network and mount namespaces. The override removes Docker's default AppArmor restriction for this container. These are elevated container privileges; grant them only to the Tantalar runtime. It does not require a Docker socket, a privileged container, `wg-quick`, `resolvconf`, or a TUN device.

On Debian/Ubuntu Linux, install the four packages above with the system package manager. Run the service with the required capabilities and writable `/etc/netns`. Service sandbox settings must permit namespace creation and mounts. If the host cannot provide these permissions, use a Linux VM that can. Runtime checks identify prerequisites; applying the profile verifies actual namespace, WireGuard and DNS operation.

## Enable download protection

1. Enable the VPN manager and the native download modules you intend to protect.
2. Export a WireGuard `.conf` file from your VPN provider. Supply one peer, an IPv4 address, the provider's DNS IP, and `AllowedIPs = 0.0.0.0/0`. IPv6 also needs an IPv6 address and `::/0`.
3. Upload the file, select download clients, and choose **Enable protection**. The controller saves the protection requirement before restarting clients. It verifies a peer handshake and DNS before starting protected processes.
4. Check each client's connection status. **Blocked** means downloads cannot fall back to the direct network. **Retry connection** retries the saved profile. **Use direct connection** requires explicit confirmation.

All protected clients share the uploaded profile. Replacing it restarts all protected clients and retains their job checkpoints. Switching one client to direct access keeps the other client's protection.

## Recovery

| Limitation or failure | Action |
|---|---|
| Unsupported host | Run Tantalar in a Linux container or VM. |
| Missing tools or capabilities | Apply the Docker override, recreate the container, and refresh the runtime check. |
| Namespace permission failure | Check `SYS_ADMIN`, AppArmor and host service restrictions. Some managed hosts cannot allow namespaces; use another Linux runtime. |
| WireGuard interface creation fails | Enable kernel WireGuard support on the Linux host or update its kernel. |
| Peer handshake fails | Export a current provider profile; check endpoint reachability and outbound UDP. Retry the saved connection. |
| DNS check fails | Use the provider's DNS IP that is reachable through the tunnel, then upload the corrected profile. |
| Missing restored credentials or unsupported legacy profile | Upload a current WireGuard profile. The saved protection requirement remains blocked. |
| Multiple legacy profiles | Upload one shared profile for all protected clients. |
| OpenVPN or profile hooks | Request a WireGuard profile. Remove `PostUp`, `PostDown`, `Table` and other custom routing commands; Tantalar owns routing. |
| Local tracker, metainfo URL or news server fails | Protected clients cannot reach host-local or LAN services. Use an endpoint reachable through the VPN. |
| External download client | Configure protection in that application's runtime. This controller covers only Tantalar's native clients. |

Provider keys are stored in Tantalar's private secret store and included in configuration backups. Protect backup files as credentials. Restores retain VPN requirements as well as credentials.

## Enforcement and verification

The controller uses [WireGuard network namespace isolation](https://www.wireguard.com/netns/): encrypted transport stays in the parent namespace; protected processes see only loopback and the tunnel. A default-drop nftables output policy blocks non-tunnel traffic. Protected child processes run without Linux capabilities. DNS configuration is scoped through [`ip netns exec`](https://man7.org/linux/man-pages/man8/ip-netns.8.html).

`scripts/test-download-vpn.mjs` is the runnable Linux acceptance check. It uses a local WireGuard peer and DNS fixture. It checks real native download processes, tunnel traffic, dropped capabilities, established-socket cutoff, IPv4/IPv6 bypass rejection, child restart, saved intent and shared-tunnel disconnect behaviour. Run it in a disposable Linux container with the documented tools and capabilities after building the workspace.

Local Linux acceptance and setup browser tests pass. A live provider profile and a real completed download still require operator acceptance before release. No provider credentials are required for the automated tests.
