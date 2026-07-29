# Install & deploy

[← Back to README](../README.md) · [Documentation index](README.md)

Everything about getting FreeLLMAPI running: the one-liner, Docker Compose, local development, declarative config, production builds, the desktop app, and where your data lives.

- [Quick start (one-liner)](#quick-start-one-liner)
- [Docker Compose](#docker-compose)
- [Local development](#local-development)
- [Declarative startup config](#declarative-startup-config)
- [Docker image & operations](#docker-image--operations)
- [Desktop app](#desktop-app)
- [Credentials and where your data lives](#credentials-and-where-your-data-lives)

## Quick start (one-liner)

Docker required — sets up `~/freellmapi`, generates an encryption key, pulls the image, and starts the container:

```bash
curl -fsSL https://freellmapi.co/install.sh | bash
```

Prefer to read before you pipe to bash? [The script is here](https://freellmapi.co/install.sh). Re-running it is safe: your `.env` (and encryption key) is preserved and the container updates to `:latest`. Override the defaults with `FREELLMAPI_DIR`, `PORT`, or `HOST_BIND` env vars.

On Windows, the easiest path is the desktop **[`.exe` installer from Releases](https://github.com/tashfeenahmed/freellmapi/releases/latest)** ([below](#desktop-app)); the Docker steps work in WSL or any bash shell.

On Android, see the experimental [Termux installation guide](install/android-termux.md). It uses Node's built-in SQLite driver and does not require the Android NDK.

Open http://localhost:3001, add your provider keys on the **Keys** page, reorder the **Fallback Chain** to taste, and grab your unified API key from the **Keys** page header. That unified key is what you point your OpenAI SDK at.

Your install keeps itself updated from the signed catalog feed. The current full catalog is listed at [freellmapi.co/models](https://freellmapi.co/models.html).

## Docker Compose

Runs the API and dashboard together on port 3001 and persists SQLite in a named volume.

**Prerequisites:** Docker, Docker Compose, OpenSSL.

*On macOS / Linux (Bash):*
```bash
git clone https://github.com/tashfeenahmed/freellmapi.git
cd freellmapi

# Generate an encryption key for at-rest key storage
ENCRYPTION_KEY="$(openssl rand -hex 32)"
printf "ENCRYPTION_KEY=%s\nPORT=3001\n" "$ENCRYPTION_KEY" > .env

docker compose up -d
```

*On Windows (PowerShell):*
```powershell
git clone https://github.com/tashfeenahmed/freellmapi.git
cd freellmapi

$Bytes = New-Object Byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($Bytes)
$ENCRYPTION_KEY = -join ($Bytes | ForEach-Object { "{0:x2}" -f $_ })
"ENCRYPTION_KEY=$ENCRYPTION_KEY`nPORT=3001" | Out-File -Encoding utf8 .env
docker compose up -d
```

> **Reaching it from another machine?** By default the container is published only on `127.0.0.1`, so `http://<server-ip>:3001` won't load from another device (the page just hangs). To expose it on your LAN — e.g. a Raspberry Pi at `http://192.168.1.x:3001` — start it with `HOST_BIND=0.0.0.0`:
>
> ```bash
> HOST_BIND=0.0.0.0 docker compose up -d
> ```
>
> Only do this on a trusted network: the proxy is single-user and guarded only by the unified API key.

## Local development

**Prerequisites:** Node.js 20+, npm.

*On macOS / Linux (Bash):*
```bash
git clone https://github.com/tashfeenahmed/freellmapi.git
cd freellmapi
npm install
ENCRYPTION_KEY="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
printf "ENCRYPTION_KEY=%s\nPORT=3001\n" "$ENCRYPTION_KEY" > .env
npm run dev
```

*On Windows (PowerShell):*
```powershell
git clone https://github.com/tashfeenahmed/freellmapi.git
cd freellmapi
npm install
$ENCRYPTION_KEY = node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
"ENCRYPTION_KEY=$ENCRYPTION_KEY`nPORT=3001" | Out-File -Encoding utf8 .env
npm run dev
```

`ENCRYPTION_KEY` is required for startup. When `NODE_ENV` is not `production`
and it is unset, the server auto-generates a development key and saves it to a
`.encryption-key` file (0600) next to the SQLite database, not inside it. Older
installs that kept the key in the database are migrated to this file on first
boot. Do not rely on that fallback with real provider keys; set `ENCRYPTION_KEY`.

Request analytics are retained for 90 days or 100000 request rows by default,
whichever limit prunes first. Set `REQUEST_ANALYTICS_RETENTION_DAYS=0` or
`REQUEST_ANALYTICS_MAX_ROWS=0` in `.env` to disable either retention limit.

Open http://localhost:5173 (the Vite dev UI), add your provider keys on the **Keys** page, reorder the **Fallback Chain** to taste, and grab your unified API key from the **Keys** page header. That unified key is what you point your OpenAI SDK at.

> **Reaching the dev UI from another device on your LAN?** Use `npm run dev:lan` — it passes `--host` through to Vite, which then prints a `Network: http://<your-ip>:5173` URL you can open from a phone or another machine. (Plain `npm run dev -- --host` does *not* work here: the root `dev` script is a `concurrently` wrapper, so the flag never reaches Vite.) API calls go through Vite's dev proxy, so no extra server config is needed.

For a production build without Docker:

```bash
npm run build
node server/dist/index.js     # server + dashboard both served on :3001
```

## Declarative startup config

For repeatable Docker/server installs, FreeLLMAPI can apply a JSON config on
every boot. Set `FREEAPI_CONFIG_PATH=/path/to/freellmapi.config.json` or put the
same JSON in `FREEAPI_CONFIG_JSON`. The config is idempotent: existing keys,
custom providers, model edits, fallback rows, and routing settings are updated
instead of duplicated.

```json
{
  "keys": [
    { "platform": "groq", "key": "gsk_...", "label": "main" },
    { "platform": "google", "key": "AIza...", "enabled": true }
  ],
  "customProviders": [
    {
      "baseUrl": "http://host.docker.internal:11434/v1",
      "label": "Ollama",
      "models": [
        { "model": "llama3.1:8b", "displayName": "Local Llama", "supportsTools": true }
      ]
    }
  ],
  "models": [
    {
      "platform": "groq",
      "modelId": "llama-3.3-70b-versatile",
      "displayName": "Llama 3.3 70B",
      "supportsTools": true,
      "fallbackEnabled": true
    }
  ],
  "routing": { "strategy": "balanced" }
}
```

## Docker image & operations

FreeLLMAPI publishes a single production image that contains the Express server and the built React dashboard:

```bash
docker pull ghcr.io/tashfeenahmed/freellmapi:latest   # or pin a release, e.g. :v1.2.3
```

The image is multi-arch (`linux/amd64` + `linux/arm64`, so it runs on a Raspberry Pi). Published tags: `latest` (default branch), `v*.*.*` (git release tags), and `sha-<commit>`.

The included `docker-compose.yml` is the recommended install path:

```bash
docker compose up -d
docker compose logs -f freellmapi
```

By default the container's port is bound to `127.0.0.1` (localhost only). To reach the dashboard/API from another machine on your network, publish it on all interfaces with `HOST_BIND=0.0.0.0 docker compose up -d` — only on a trusted LAN, since the proxy is single-user.

SQLite data is stored in the `freellmapi-data` volume at `/app/server/data`.
Keep the same `.env` `ENCRYPTION_KEY` and volume when upgrading, because
provider keys are encrypted at rest. If your host only persists a specific
directory, set `FREEAPI_DB_PATH=/that/path/freellmapi.db`.

On hosts with ephemeral disks, configure an encrypted backup target:

```env
FREEAPI_DB_BACKUP_PATH=/app/server/data/freellmapi.db.backup
# or:
FREEAPI_DB_BACKUP_URL=https://example.com/freellmapi.db.backup
FREEAPI_DB_BACKUP_TOKEN=optional-bearer-token
FREEAPI_DB_BACKUP_KEY=64-char-hex-backup-key
FREEAPI_DB_BACKUP_INTERVAL_MS=300000
```

When the database file is missing at startup, FreeLLMAPI restores the backup
before migrations run. While the server is running it uploads a fresh encrypted
backup periodically. If `FREEAPI_DB_BACKUP_KEY` is omitted, the app uses
`ENCRYPTION_KEY` for the backup envelope too.

More Docker operations and examples live in [docker/README.md](../docker/README.md).

## Desktop app

A native menu-bar app lives in [`desktop/`](../desktop): the entire router +
dashboard running locally from your tray, with a glass popover showing live
request stats.

![FreeLLMAPI desktop app](../repo-assets/desktop.png)

**[Download from Releases](https://github.com/tashfeenahmed/freellmapi/releases/latest)** — the macOS `.dmg` and the Windows `.exe` installer are built and attached to every release by the [`desktop-release`](../.github/workflows/desktop-release.yml) workflow. Or build it from this repo in a few minutes:

> **Note for Windows users building from source:** Building the desktop app requires compiling native SQLite modules for Electron. You must have [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) installed (specifically the "Desktop development with C++" workload) and Python installed before running `npm install`.

```bash
npm install
npm install --prefix desktop  # install desktop dependencies
npm run desktop:dist          # macOS  → desktop/dist-electron/FreeLLMAPI-…-arm64.dmg
npm run desktop:dist:win      # Windows → "desktop/dist-electron/FreeLLMAPI Setup ….exe"
```

> Locally built apps are unsigned, so Windows SmartScreen may warn on first run
> ("More info" → "Run anyway"); the macOS build launches without Gatekeeper prompts.
> Full instructions in [desktop/README.md](../desktop/README.md).

## Credentials and where your data lives

The desktop app has **no username or password to set up**. Unlike the server
(which gates its dashboard behind an email + password account), the desktop
build signs the dashboard in automatically with a hidden local account, so
you're never prompted for credentials and never need one.

The only credential you need is your **unified API key** — the
`freellmapi-…` token your OpenAI/Anthropic client points at. Get it from:

- the tray popover — click the tray icon, then **Copy Key**, or
- the dashboard **Keys** page header (tray → **Open Dashboard**).

You do not need to open or edit `freeapi.db` by hand.

Your settings and data live in one folder per OS (copy it to migrate to
another machine or into a container):

| OS | Location |
|----|----------|
| Windows | `%APPDATA%\FreeLLMAPI\` (e.g. `C:\Users\<you>\AppData\Roaming\FreeLLMAPI\`) |
| macOS | `~/Library/Application Support/FreeLLMAPI/` |
| Linux | `~/.config/FreeLLMAPI/` |

That folder holds `freeapi.db` (all keys, models, settings, encrypted at rest)
and `config.json` (window/theme/port/LAN preferences). Copy both to move an
install. For the server (non-desktop) deployment, the equivalent state is the
`.env` file and the SQLite DB at `server/data/freeapi.db` (or wherever
`FREEAPI_DB_PATH` points).
