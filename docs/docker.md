# Docker Compose deployment

> The default Compose workflow serves the frontend only. The browser connects
> directly to the Supabase endpoint in PUBLIC_SUPABASE_URL.
> The bundled local Supabase stack remains available behind the self-hosted
> profile for deployments that actually want to run Supabase alongside the app.

## Default: external Supabase

Set PUBLIC_SUPABASE_URL to the URL that browsers can reach, for example a
Tailscale hostname, and set ANON_KEY to the matching public anon key.

```bash
# 1. Put PUBLIC_SUPABASE_URL and ANON_KEY in .env.

# 2. Build and start the frontend.
docker compose build frontend
docker compose up -d frontend

# 3. Open http://localhost:3000
```

The frontend image bakes PUBLIC_SUPABASE_URL and ANON_KEY into the Vite bundle
at build time. After changing either value, rebuild the frontend image.

Nginx only serves the SPA. It does not proxy /auth/v1, /rest/v1,
/storage/v1, /functions/v1, or /realtime/v1 to a local Kong. Those
requests go directly to PUBLIC_SUPABASE_URL.

## Optional: self-hosted Supabase

The repository still contains the minimal Supabase stack for deployments that
need it, but those services are disabled by default so they cannot accidentally
take over ports or intercept the external Supabase configuration.

Start it explicitly with:

```bash
docker compose --profile self-hosted up -d
```

For this mode, PUBLIC_SUPABASE_URL must be a URL that the browser can reach
and that points at the self-hosted Supabase API gateway. If the browser can reach
the local machine directly, http://localhost:8000 is an option.

The self-hosted services include:

| Service | Purpose |
| --- | --- |
| kong | API gateway |
| auth | Authentication |
| rest | REST over Postgres |
| storage | File storage |
| meta | Schema introspection |
| functions | Deno edge functions |
| studio | Optional database UI |
| db | Postgres + Supabase extensions |

## Configuration notes

- PUBLIC_SUPABASE_URL is the endpoint used by the browser. It is baked into
  the frontend bundle at build time.
- ANON_KEY is safe to expose to the browser. Never bake SERVICE_ROLE_KEY
  into the frontend.
- Published ports default to loopback. Set FRONTEND_BIND=0.0.0.0 only when
  deliberate LAN access is required.
- OAuth redirect URLs and Supabase Auth site URLs must match the public URL used
  by the browser.
- frontend/nginx.conf is intentionally a static SPA server. It does not
  depend on a local Kong instance.

## Database setup and account recovery

For a self-hosted database, data/create-db-docker.sh loads the checked-in
schema and sanitized content dump and is intended for a fresh or disposable
database. Do not use it to replace the public schema of an existing production
database.

If an existing installation reports **User not found** after login, verify that
data/auth-trigger.sql is installed. The trigger creates profiles for new
accounts. It does not repair accounts registered before the trigger was installed.

## Known limitations of the bundled self-hosted skeleton

The bundled stack is intentionally incomplete compared with the full Supabase
distribution. It does not include realtime, analytics/log-stream, image proxy,
inbucket, TLS termination, or backups. Pin and upgrade the image versions
deliberately.
