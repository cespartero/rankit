# rankit

Run polls and surveys. Every poll gets its own link, QR code and 4-digit code. Voters answer on their phone and see the combined results live.

- **Question types**, mixed freely in one poll:
  - **Ranking:** drag the options into order, or mark any of them "Don't know". On each ballot the top option scores 100, the bottom 0, and the rest are spread evenly. An option's score is the average over the people who ranked it.
  - **Choice:** pick one, or pick any number.
  - **Number:** with optional lowest, highest, step and unit. Up to 11 values (e.g. 1–10) show as buttons to tap. Anything bigger shows a number box. Results show the average, median, range and a bar chart.
- **Vote site (public):** type a code on the home page, or open a poll's link. Ranking lists start in a random order. People can come back and adjust their answers until the poll closes.
- **Manage site (behind Cloudflare Access):**
  - Create, edit, duplicate and delete polls.
  - Open voting with no time limit, for a set time (minutes, hours or days), or until a date and time. Polls close themselves when the time is up, even across a restart.
  - Choose who sees results (everyone live, only people who've answered, or nobody yet).
  - Show a full-screen QR code and code for a TV or projector.
  - Open a **report** for any poll: a summary plus every question's results, ready to print or save as a PDF, or copy as text.

## How the code is organised

```
src/            server (Node.js, no external dependencies)
  server.js     two web servers: vote (public) and manage
  state.js      polls, questions, answers, timers, results, live updates
  store/        storage adapters (JSON file today)
public/
  home.html     vote site home: enter a poll code
  poll.html     answering a poll (/p/<id>)
  manage.html   the manage site
  report.html   printable report (/report/<id> on the manage site)
  common.js/css shared styles and results charts
  qr.js         QR code generator (no external library)
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

Set `VOTE_URL=http://localhost:8080` to get full links and QR codes on the manage site.

## Deploy

- **Local Docker / Portainer + Cloudflare Tunnel:** see [docs/deploy-docker.md](docs/deploy-docker.md)

## Configuration

| Variable | Default | What it does |
|---|---|---|
| `VOTE_PORT` | `8080` | Port for the public vote site. |
| `MANAGE_PORT` | `8081` | Port for the manage site and every API that changes the list or settings. |
| `VOTE_URL` | *(none)* | The vote site's public address, e.g. `https://rankit-vote.locar.fyi`. Used to build each poll's link and QR code. **Set this.** |
| `DATA_DIR` | `./data` (`/data` in Docker) | Where the data file `db.json` is kept. |
| `STORE` | `file` | Storage adapter. Only `file` for now. |
