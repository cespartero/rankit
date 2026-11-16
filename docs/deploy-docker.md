# Deploy with Docker (Portainer)

These steps run Rank It on your own Docker server and publish it through your Cloudflare Tunnel. It's the same setup as Match Scorer.

## 1. Create the stack in Portainer

1. **Stacks → Add stack → Repository**.
2. Repository URL: `https://github.com/cespartero/rankit`. If the repo is private, turn on **Authentication** and use your GitHub personal access token with read access (the same one as your other stacks).
3. Reference: `refs/heads/main`.
4. **Compose path:** `deploy/docker/docker-compose.yml`
5. **Environment variables** (all optional):
   - `VOTE_URL`: the vote site's public address, e.g. `https://rankit-vote.locar.fyi`. It's needed for each poll's full link and QR code.
   - `VOTE_HOST_PORT` (default 8092) and `MANAGE_HOST_PORT` (default 8093). Change them if those ports are already used on the server.
   - `STACK_NAME` (default `rankit`): only needed to run a second copy, such as a test stack. It sets the container, image and data volume names so the two copies don't clash.
6. Deploy the stack. Portainer builds the image from the repo's `Dockerfile`.

Check it's running:

- Vote site: `http://<server>:8092`
- Manage site: `http://<server>:8093`

The data lives in the Docker volume `rankit-data`, so it survives restarts and rebuilds.

### Updating after a merge to `main`

In Portainer, open the stack and choose **Pull and redeploy**. You can also turn on **GitOps updates** so Portainer redeploys automatically when `main` changes.

## 2. Publish through Cloudflare Tunnel

In Cloudflare Zero Trust → **Networks → Tunnels**, add two public hostnames to your existing tunnel:

| Hostname (example) | Service |
|---|---|
| `rankit-vote.locar.fyi` | `http://<server>:8092` |
| `rankit-manage.locar.fyi` | `http://<server>:8093` |

Live results use Server-Sent Events, which work through Cloudflare Tunnel without extra settings.

## 3. Protect the manage site with Cloudflare Access

1. **Access → Applications → Add → Self-hosted**:
   - Application domain: `rankit-manage.locar.fyi`
   - Login method: **One-time PIN** sent by email.
   - Policy: **Allow**, include your own email address (or a group).
2. **Leave the vote hostname without an Access application**, so anyone with the link can vote.

The vote port can't change the list or settings in any case. Those APIs only exist on the manage port.

The manage port has no login of its own, so anyone on your home network who knows `http://<server>:8093` can open it. That's the same as Match Scorer's scorer port.

## How voting works

- Every poll has its own link (`/p/<id>`) and a 4-digit code. People can type the code on the vote site's home page. Draft polls can't be found until you open voting.
- To slow down anyone guessing codes, each address can try 20 codes a minute.
- Each browser gets a random voter id in a cookie, so people can come back and adjust their answers. That's one response per browser: it stops casual double-voting, but someone could answer again from a private window or another device.
- Timers are kept on the server. A poll closes on time even if nobody has it open, and a running timer carries on after a restart or redeploy.

## Upgrading from the single-list version

The first time the new version starts, it turns your existing list and its votes into a poll with one ranking question. It keeps a copy of the old data as `db.v1-backup.json` in the same volume. That poll gets a new link and code, so the old voting link now opens the code-entry page. Share the poll's new link or code.

## Backups

The data is a single file, `db.json`, in the `rankit-data` volume:

```bash
docker run --rm -v rankit-data:/data -v "$PWD":/backup alpine cp /data/db.json /backup/rankit-db.json
```

Portainer may prefix the volume with the stack name (for example `rankit_rankit-data`). Run `docker volume ls` to check the name.
