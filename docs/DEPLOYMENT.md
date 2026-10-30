# Ubuntu Docker + Cloudflare Tunnel deployment

Ledgerway remains an active implementation and is **not production-ready**. The scripts below automate installation and updates; they do not constitute accounting, security, disaster-recovery, or regulatory acceptance. Do not use it as the system of record for live finances until the open items in `PROJECT_PROGRESS.md` are resolved and independently reviewed.

## What is automated

- `sudo ./deploy/install-ubuntu.sh` — one-command first deployment from a checked-out repository. On Ubuntu, it installs Docker Engine and the Compose plugin from Docker's official apt repository if they are missing, prompts for the Cloudflare Tunnel token, public HTTPS origin and initial administrator, generates the database password and Better Auth secret, builds the containers, applies migrations, seeds the first administrator, then starts PostgreSQL, API, web, and `cloudflared`.
- `sudo ./deploy/update-ubuntu.sh` — one-command update from a clean Git checkout with a configured upstream branch. It fast-forwards that branch, validates Compose settings, makes a pre-update database and upload-volume backup, builds the new API/web images, applies migrations, recreates the application and tunnel containers, and checks API/web health.

Both scripts refuse unsafe conditions rather than guessing. The update script refuses a dirty working tree, a branch without an upstream, an unhealthy API/database, or a missing installation. Database migrations are not automatically rolled back if a later step fails; keep the generated backup and follow the restore instructions below.

## Before first install

1. Use an Ubuntu server with outbound internet access, a DNS domain in Cloudflare, and a remotely-managed Cloudflare Tunnel. Cloudflare's Tunnel setup requires a Cloudflare account/domain; create the tunnel in the Cloudflare dashboard and copy its connector token.
2. In that tunnel's Public Hostname configuration, route the hostname (for example, `accounts.example.com`) to **`http://web:3000`**. This hostname is resolved by the connector inside the Docker Compose network. Do not route it to `localhost:3000` or to the API container. Cloudflare's `TUNNEL_TOKEN` environment variable is supported for remotely-managed tunnel runs, and the `cloudflared` service uses it [Cloudflare run parameters](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/run-parameters/). The Compose file pins the connector image to `2026.10.6`; review and deliberately update that tag during a tested release cycle rather than silently following `latest`.
3. Clone the reviewed Ledgerway repository and change into its root directory. Configure the checkout to track the reviewed release/update branch. Do not run a `curl | sudo bash` command; inspect and run the scripts from the checkout.
4. Run:

   ```bash
   sudo ./deploy/install-ubuntu.sh
   ```

   Follow the prompts. The public URL must be an HTTPS origin without a path or port, such as `https://accounts.example.com`. The initial admin password must be at least 12 characters. It is passed to the one-time seed process and is not written to `.env`.

The installer writes a private, mode-`0600` `.env` containing generated credentials and the tunnel token. `.env` is ignored by Git. **Never share or commit it.** Database, API, and web ports are not published on the host. The Cloudflare connector reaches the web service over the private Compose network; it routes API requests internally through the web proxy. Public access is through the outbound Tunnel connector, so no inbound application port-forwarding is needed. This also avoids host-port collisions and keeps the origin services off the host network.

## One-command updates

From the same Git checkout and on the branch used for deployment:

```bash
sudo ./deploy/update-ubuntu.sh
```

The script fast-forwards the branch (it does not merge local changes), creates paired backups under `backups/` before migrations, pulls the Cloudflare connector image, builds API/web images with fresh base-image pulls, runs Knex migrations, and updates services. If the source branch is not configured to track an upstream, or the worktree has changes, it stops and asks for that to be resolved. Review the repository changes before running updates on an important system; for more controlled operations, deploy a reviewed release tag/branch.

## Health, logs, backup and restore

```bash
docker compose --profile tunnel ps
docker compose --profile tunnel logs -f api web cloudflared
./deploy/scripts/backup.sh
sudo ./deploy/scripts/restore.sh backups/ledgerway-TIMESTAMP.dump
```

Backups consist of a PostgreSQL custom-format dump and a matching `-uploads.tar.gz` archive. Restore asks for explicit confirmation and replaces the database; if the matching upload archive exists, it also replaces the contents of the upload volume. Keep encrypted, access-controlled copies **off the server** and periodically test restore on a separate instance. The update script's local backup does not protect against disk or server loss.

## Operational/security notes

- `docker compose up` without `--profile tunnel` does not start the Cloudflare connector. The installer and updater enable the `tunnel` profile for the deployed stack.
- Containers use `restart: unless-stopped` and the Docker daemon is enabled on boot.
- Keep the Cloudflare tunnel token, `.env`, backups, and initial administrator credentials secret. Rotate the initial admin password after sign-in; enable an appropriate Cloudflare Access policy if the deployment should be restricted to named users.
- Monitor free disk space, Docker/container health, tunnel logs, PostgreSQL logs, and backups. The updater retains backups rather than pruning them; manage their retention and off-site copies according to policy.
- `deploy/scripts/restore.sh` replaces production data. Confirm the target server and restore pair before typing `RESTORE`.
- Docker image builds, first deployment, Cloudflare hostname routing, migration execution in containers, reboot recovery, and backup/restore have **not been run in this development environment** because Docker is unavailable. Validate them on a disposable Ubuntu host before relying on this method for a real deployment.
