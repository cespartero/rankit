# rankit

Put up a list and let people rank it. Each person drags the items into their own order, and everyone's rankings combine into one live leaderboard.

- **Vote site (public):** open the link, drag the items into order (or use the ▲▼ arrows), tap **Don't know** for anything you can't judge, and submit. You can come back and change your ranking any time. Items start in a random order so the list order doesn't bias anyone.
- **Manage site (behind Cloudflare Access):** set the title, instructions and items. Open or close voting, choose who sees the results (everyone live, only people who've voted, or nobody yet), copy the results, and clear all votes.
- **Results:** on each ballot the top item scores 100, the bottom item 0, and the rest are spread evenly between. An item's score is the average over the people who ranked it. "Don't know" counts neither for nor against it. Each item also shows how many people ranked it, how many didn't know it, and how many put it first. A ballot needs at least 2 ranked items.

## How the code is organised

```
src/            server (Node.js, no external dependencies)
  server.js     two web servers: vote (public) and manage
  state.js      list, ballots, settings, results, live updates
  store/        storage adapters (JSON file today)
public/
  vote.html     the voting page
  manage.html   the manage page
Dockerfile      container image
deploy/docker/  docker-compose.yml for Portainer
docs/           deployment guide
```

Changes go on a branch and are merged into `main` by pull request.

### Version number

Every push to `main` runs a GitHub Action (`.github/workflows/version.yml`). It stamps `public/version.json` with the push date (Adelaide time) and that day's push count, e.g. `2026.11.12-1`. The version appears at the bottom of each page, and `/healthz` returns it.

## Run it locally (without Docker)

Needs Node.js 20 or newer.

```bash
DATA_DIR=./data node src/server.js
```

- Vote site: http://localhost:8080
- Manage site: http://localhost:8081

## Deploy

- **Local Docker / Portainer + Cloudflare Tunnel:** see [docs/deploy-docker.md](docs/deploy-docker.md)

## Configuration

| Variable | Default | What it does |
|---|---|---|
| `VOTE_PORT` | `8080` | Port for the public vote site. |
| `MANAGE_PORT` | `8081` | Port for the manage site and every API that changes the list or settings. |
| `VOTE_URL` | *(none)* | Public voting link, shown on the manage page with a Copy button. |
| `DATA_DIR` | `./data` (`/data` in Docker) | Where the data file `db.json` is kept. |
| `STORE` | `file` | Storage adapter. Only `file` for now. |
