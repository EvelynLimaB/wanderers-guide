# Deploying behind Tailscale Serve with rootless Podman

Runbook for publishing this stack at `https://<machine>.<tailnet>.ts.net` using
rootless Podman + `tailscale serve`. Written against the failure modes hit while
bringing the stack up on `pc-eve.tail1a585f.ts.net`.

## Why `podman-compose up -d` failed

```
Error: unable to start container "0ae5bd77...": rootlessport cannot expose
privileged port 80 ... listen tcp 0.0.0.0:80: bind: permission denied
```

Rootless Podman runs the port-forwarder as your user, so it cannot bind host
ports below `net.ipv4.ip_unprivileged_port_start` (1024 by default).

Nothing in the committed `docker-compose.yml` publishes port 80: `frontend`
publishes `${FRONTEND_PORT:-3000}`, kong `8000/8443`, db `54322`, studio
`54323`. The `0.0.0.0:80` bind came from a **locally added `nginx` service**.
That service is unnecessary: `frontend/Dockerfile` already ends in
`FROM nginx:1.27-alpine` and copies `frontend/nginx.conf` in. The frontend
container *is* the nginx. Adding a second one in front of it just creates a
second thing to configure and a privileged port to bind.

Fix applied: publish loopback-only, non-privileged ports (see
`docker-compose.yml` diff), and teach the frontend's nginx to reverse-proxy the
API so no extra tier is needed.

If you genuinely need host port 80/443, the alternative is a one-time sysctl, but then *any* local user can bind those ports:

```bash
sudo sysctl -w net.ipv4.ip_unprivileged_port_start=80
echo 'net.ipv4.ip_unprivileged_port_start = 80' | sudo tee /etc/sysctl.d/99-unprivileged-ports.conf
```

Prefer not to. `tailscale serve` terminates TLS on 443 for you, so the
containers never need a privileged port.

## Why the `supabase-studio` errors were noise

```
Error: no container with name or ID "supabase-studio" found: no such container
```

podman-compose inspects/removes the existing container *before* pulling the
image. On a first run the container doesn't exist yet, so it complains: then
pulls and creates it anyway (visible further down the same log). Harmless.

It only appeared because the local compose file set
`container_name: supabase-studio`. Upstream leaves naming to podman-compose
(`wanderers-guide_studio_1`). Setting `container_name` also breaks
`podman-compose up`'s ability to reconcile that service later. Remove it.

**Also revert the Studio image tag.** The local file bumped Studio to
`supabase/studio:2026.09.07-sha-7996410`, but this stack pins
`supabase/postgres-meta:v0.83.2` (mid-2024). Current Studio builds talk to a
much newer postgres-meta API; the Table Editor and SQL pages will error against
v0.83.2. Keep the pinned `supabase/studio:20240729-ce42139` unless you also
bump `meta`, `kong`, `gotrue`, `postgrest` and `storage` together.

## The change that actually matters: `PUBLIC_SUPABASE_URL`

`VITE_SUPABASE_URL` is **baked into the JS bundle at build time**
(`frontend/Dockerfile` -> `ARG VITE_SUPABASE_URL`), and the app uses it for every
API call (`frontend/src/supabase-client.ts`, `frontend/src/utils/client-errors.ts`).

The default in `.env.docker.example` is `http://localhost:8000`. Over the
tailnet that is fatal in a confusing way: the page loads fine from
`https://pc-eve.tail1a585f.ts.net`, then every request goes to the *viewer's own*
`localhost:8000` and silently fails. Login, characters, content search: all dead.

With `frontend/nginx.conf` now proxying the API, the value is just the site
origin:

```
PUBLIC_SUPABASE_URL=https://pc-eve.tail1a585f.ts.net
```

No port, no path, no trailing slash. supabase-js appends `/auth/v1`, `/rest/v1`,
`/storage/v1`, `/functions/v1` itself, and nginx forwards those to `kong:8000`.
Same origin => no CORS, no second public hostname, no second TLS cert.

Because it is a build arg, **you must rebuild the frontend image** after
changing it: `up -d` alone reuses the old bundle:

```bash
podman-compose build frontend && podman-compose up -d frontend
```

Verify the right URL got baked in (adjust the image name from `podman images`):

```bash
podman run --rm localhost/wanderers-guide_frontend \
  sh -c "grep -rho 'https://[a-z0-9.-]*\\.ts\\.net' /usr/share/nginx/html/assets | sort -u"
```

If buildah served a stale cached layer, force it:
`podman-compose build --no-cache frontend`.

## Deploy steps

```bash
# 0. one-time: stop needing sudo for tailscale serve
sudo tailscale set --operator=$USER

# 1. config
cd ~/wanderers-guide
cp .env.docker.example .env
nano .env        # see .env.tailnet.example for the exact values

# 2. fresh secrets: the repo's JWT_SECRET/ANON_KEY pair is public on GitHub
openssl rand -hex 32          # -> JWT_SECRET
# sign anon + service_role JWTs with it:
# https://supabase.com/docs/guides/self-hosting/docker#generate-api-keys

# 3. build + start
podman-compose build
podman-compose up -d
podman ps

# 4. load schema + content (MUST be done; `up` alone leaves an empty database)
./data/create-db-docker.sh

# 5. publish
tailscale serve --bg --https=443 http://localhost:8080
tailscale serve status

# 6. optional Studio, on a second serve port (loopback-only otherwise)
COMPOSE_PROFILES=studio podman-compose up -d
tailscale serve --bg --https=10000 http://localhost:54323
# -> https://pc-eve.tail1a585f.ts.net:10000
```

`.env` values that must change (full annotated set in `.env.tailnet.example`):

```ini
PUBLIC_SUPABASE_URL=https://pc-eve.tail1a585f.ts.net
SITE_URL=https://pc-eve.tail1a585f.ts.net
ADDITIONAL_REDIRECT_URLS=https://pc-eve.tail1a585f.ts.net/**
FRONTEND_PORT=8080
FRONTEND_BIND=127.0.0.1
POSTGRES_PASSWORD=<strong>
JWT_SECRET=<fresh>
ANON_KEY=<fresh>
SERVICE_ROLE_KEY=<fresh>
```

`SITE_URL` / `ADDITIONAL_REDIRECT_URLS` feed `GOTRUE_SITE_URL` and
`GOTRUE_URI_ALLOW_LIST`; without them signup and password-reset emails link back
to `http://localhost:3000`.

**Port clash warning:** `tailscale serve --https=8443` and kong's published
`KONG_HTTPS_PORT=8443` are both host port 8443. Use `--https=10000` for Studio
(as above) or set `KONG_HTTPS_PORT=9443`.

## Verifying

```bash
curl -sI http://localhost:8080/ | head -1                    # 200, SPA
curl -s  http://localhost:8080/rest/v1/ -H "apikey: $ANON_KEY" | head -c 200
curl -s  http://localhost:8080/auth/v1/health                # {"version":...}
curl -sI https://pc-eve.tail1a585f.ts.net/ | head -1
podman logs --tail 30 wanderers-guide_kong_1
podman logs --tail 30 wanderers-guide_auth_1
```

Both `/rest/v1/` and `/auth/v1/health` going through **8080** (not 8000) proves
the nginx->kong proxy works end to end.

## What was changed

| File | Change |
| --- | --- |
| `frontend/nginx.conf` | Reverse-proxy `/auth/v1`, `/rest/v1`, `/storage/v1`, `/functions/v1`, `/realtime/v1`, `/pg/` -> `kong:8000`. Pass through `X-Forwarded-Proto` from the TLS terminator. `client_max_body_size 60m` for storage uploads. 300s proxy timeouts for slow edge functions. |
| `docker-compose.yml` | All published ports are now `${*_BIND:-127.0.0.1}:port`: loopback-only by default, so nothing privileged and nothing on the LAN. |
| `data/create-db-docker.sh` | Works under Podman: auto-detects `docker` vs `podman` and the container name (`wanderers-guide-db-1` vs `wanderers-guide_db_1`). |
| `.env.tailnet.example` | New: annotated `.env` for a Tailscale Serve deploy. |

Routing was verified against a stub kong: SPA routes fall through to
`index.html`, `/auth/patreon/redirect` is *not* shadowed by the API proxy
(the proxy regex is anchored on `/v1/`), and kong receives the full original
URI: which matters because `docker/kong.yml` uses `strip_path: true` and
strips the prefix itself. A trailing slash on `proxy_pass` would 404 every
route.

## Still out of scope

Per `docs/docker.md`: no realtime, no analytics, no image proxy, no SMTP (set
`GOTRUE_SMTP_*` for real email; `EMAIL_AUTOCONFIRM=true` skips it), no backups.
The loopback binds remove LAN exposure but Tailscale ACLs are now your only
perimeter: anyone in the tailnet can reach the app and register an account.
Restrict the machine's ACL tag if that matters.
