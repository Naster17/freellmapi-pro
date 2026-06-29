# AGENTS.md — FreeLLMAPI Contributing Rules

## Project Overview

---

## Repository Structure

```
freellmapi-pro/
├── server/          # Express.js + TypeScript backend (port 3001)
├── client/          # React + Vite + TailwindCSS admin dashboard (port 5173 dev)
├── desktop/         # Electron menu-bar app (wraps server + client)
├── shared/          # TypeScript types shared between server and client
├── docker/          # Docker docs and helpers
├── docs/            # Static HTML pages (success, index)
├── data/            # SQLite database directory (gitignored)
└── catalog-hosting/ # Static model catalog snapshot (GitHub Pages feed for catalog-sync)
```

### Workspaces

This is an npm monorepo with three workspaces:
- `shared` — TypeScript types (`@freellmapi/shared`)
- `server` — Express backend (`@freellmapi/server`)
- `client` — React dashboard (`@freellmapi/client`)

### Catalog Hosting (`catalog-hosting/`)

A static snapshot of the model catalog, published to a separate GitHub Pages repository (`Naster17/freellmapi-catalog`). The FreeLLMAPI server (`catalog-sync.ts`) pulls from this feed twice/day to update its local model database.

| File | Purpose |
|---|---|
| `v1/latest` | JSON endpoint served at `https://naster17.github.io/freellmapi-catalog/v1/latest`. This is what `catalog-sync.ts` fetches. |
| `latest.json` | Identical snapshot with `.json` extension for manual viewing. |
| `index.html` | Minimal landing page linking to the two endpoints. |
| `.nojekyll` | Disables Jekyll processing on GitHub Pages. |
| `README.md` | Deployment instructions for the GitHub Pages repo. |


---

## Server Architecture (`server/`)

### Entry Point
- `src/index.ts` — Boot: loads env, inits DB, starts Express, health checker, catalog sync.

### Application Setup
- `src/app.ts` — Express app: helmet, CORS, JSON parser, route mounting, SPA fallback.

### Routes (`src/routes/`)
| Route File | Mount Path | Purpose |
|---|---|---|
| `proxy.ts` | `/v1` | **Core** — OpenAI-compatible chat completions proxy. Routes requests, handles streaming, failover, tool calls, vision, context handoff, fusion. |
| `responses.ts` | `/v1/responses` | OpenAI Responses API shim (for Codex CLI). |
| `anthropic.ts` | `/v1/messages` | Anthropic Messages API compat (Claude Code). |
| `keys.ts` | `/api/keys` | CRUD for provider API keys. |
| `models.ts` | `/api/models` | Model catalog listing and toggle. |
| `fallback.ts` | `/api/fallback` | Fallback chain management, routing strategy, scores. |
| `profiles.ts` | `/api/profiles` | Named routing profiles (saved fallback chains). |
| `embeddings.ts` | `/api/embeddings` | Embedding model config and routing. |
| `media.ts` | `/api/media` | Image/audio generation model config. |
| `analytics.ts` | `/api/analytics` | Request analytics and provider breakdowns. |
| `logs.ts` | `/api/logs` | Server-side log viewer. |
| `usage-limits.ts` | `/api/usage-limits` | Per-model usage limit configuration. |
| `health.ts` | `/api/health` | Key health status and probe triggers. |
| `settings.ts` | `/api/settings` | Global settings (proxy, theme, etc). |
| `premium.ts` | `/api/premium` | Premium catalog sync and license. |
| `auth.ts` | `/api/auth` | Dashboard login/setup/logout (session-based). |

### Services (`src/services/`)
| Service | Purpose |
|---|---|
| `router.ts` | **Core routing engine** — picks best model per request via fallback chain, supports strategies (priority/balanced/smartest/fastest/reliable/custom), Thompson sampling bandit, sticky sessions, context-aware routing, vision/tools filtering. |
| `ratelimit.ts` | In-memory RPM/RPD/TPM/TPD counters per (platform, model, key). Cooldowns on 429s. Key concurrency tracking. |
| `scoring.ts` | Bandit scoring: reliability (Beta posterior), speed (throughput + TTFB), intelligence (composite tier+rank). Combine score with headroom and rate-limit guardrails. |
| `health.ts` | Periodic key health probing. Marks keys as healthy/rate_limited/invalid/error. |
| `auth.ts` | Dashboard auth: email+password accounts, session tokens (30-day TTL). |
| `model-groups.ts` | Model unification: groups same model across providers into logical entities. |
| `catalog-sync.ts` | Pulls signed model catalog from freellmapi.co (twice/day). Applies updates to local DB. |
| `context-handoff.ts` | Injects system message on model switch so new model knows it's continuing a task. |
| `fusion.ts` | Fusion mode: routes same request to multiple models in parallel, merges responses. |
| `media.ts` | Image generation and speech/TTS routing. |
| `embeddings.ts` | Embedding routing with family-based failover (no cross-model failover). |
| `request-retention.ts` | Retention cleanup for request logs. |
| `model-listing.ts` | Builds the /v1/models listing from the catalog. |
| `quirks.ts` | Structured notes/warnings about specific models. |
| `anthropic-map.ts` | Translates between Anthropic Messages API format and OpenAI format. |

### Providers (`src/providers/`)
| Provider | Type |
|---|---|
| `base.ts` | Abstract `BaseProvider` class. Defines `chatCompletion()`, `streamChatCompletion()`, `validateKey()`. Shared SSE reader, timeout handling, proxy fetch. |
| `google.ts` | Google Gemini — unique API format (not OpenAI-compat). |
| `openai-compat.ts` | Generic OpenAI-compatible adapter (used by Groq, Cerebras, NVIDIA, Mistral, OpenRouter, GitHub, Zhipu, HuggingFace, Ollama, Kilo, Pollinations, LLM7, OpenCode, OVH, Agnes, Reka, SiliconFlow, Custom). |
| `cohere.ts` | Cohere — custom adapter (different tool format). |
| `cloudflare.ts` | Cloudflare Workers AI — custom adapter (account_id:key format). |
| `index.ts` | Provider registry. `getProvider()`, `resolveProvider()` (builds custom provider per-key). |

### Lib (`src/lib/`)
| File | Purpose |
|---|---|
| `crypto.ts` | AES-256-GCM encrypt/decrypt for API keys. Key bootstrap from env → DB. |
| `proxy.ts` | HTTP/SOCKS proxy agent (lazy-loaded undici/socks-proxy-agent). |
| `budget.ts` | Parse monthly token budget strings. |
| `budget-score.ts` | Budget headroom scoring for routing. |
| `content.ts` | Normalize multimodal content blocks (image_url, text arrays) to string. |
| `error-classify.ts` | Classify errors: retryable, payment_required, model_not_found, etc. |
| `error-redaction.ts` | Redact sensitive info from provider error messages. |
| `password.ts` | Scrypt password hashing. |
| `process-safety-net.ts` | Catch unhandled errors to prevent process crash. |
| `request-log.ts` | Log request details to SQLite. |
| `server-logs.ts` | In-memory server log ring buffer + console capture. |
| `tool-args.ts` | Repair malformed tool call arguments. |
| `tool-call-rescue.ts` | Rescue inline tool calls from models that emit them as text. |
| `usage-normalize.ts` | Normalize usage objects across providers (cached tokens, reasoning tokens). |

### Database (`src/db/`)
- `index.ts` — SQLite init (WAL mode, foreign keys), settings API, unified key.
- `migrations.ts` — Schema migrations (versioned, additive).
- `model-pricing.ts` — Cost per 1M tokens for analytics.
- `model-metadata-corrections.ts` — Overrides for provider-reported model metadata.

### Middleware (`src/middleware/`)
- `requireAuth.ts` — Gate `/api/*` routes behind dashboard session token.
- `rateLimit.ts` — Per-IP rate limiting on `/v1` proxy endpoint.
- `errorHandler.ts` — Express error handler for API routes.

### Tests (`src/__tests__/`)
- Vitest with `--pool=forks`. Run: `npm test -w server`
- `services/` — Router, rate limit, scoring, quirks, model-groups, catalog-sync, context-handoff tests.
- `providers/` — Provider adapter tests.
- `routes/` — API route integration tests.
- `lib/` — Utility function tests.
- `db/` — Database migration tests.
- `integration/` — End-to-end integration tests.

---

## Client Architecture (`client/`)

### Tech Stack
- React 19 + TypeScript
- Vite 8 (dev server, HMR)
- TailwindCSS 4 (utility-first styling)
- shadcn/ui (component library)
- React Router 7 (client-side routing)
- TanStack React Query (server state)
- Recharts (charts)
- DnD Kit (drag-and-drop sortable lists)
- Lucide React (icons)
- Geist / Geist Mono (fonts)
- i18n (internationalization)

### Pages (`src/pages/`)
| Page | Route | Purpose |
|---|---|---|
| `FallbackPage.tsx` | `/models/chat` | **Main page** — Fallback chain editor. Drag-to-reorder, enable/disable, metrics, routing scores. |
| `FusionPage.tsx` | `/models/fusion` | Fusion panel: pick multiple models, parallel requests, merge responses. |
| `EmbeddingsPage.tsx` | `/models/embeddings` | Embedding model management. |
| `EmbeddingDetailPage.tsx` | `/models/embeddings/:id` | Embedding model detail and config. |
| `ImagePage.tsx` | `/models/image` | Image generation model management. |
| `AudioPage.tsx` | `/models/audio` | Audio/TTS model management. |
| `MediaDetailPage.tsx` | `/models/*/:id` | Image/audio model detail. |
| `ModelDetailPage.tsx` | `/models/chat/:id` | Individual model detail page. |
| `KeysPage.tsx` | `/keys` | API key management. Add/remove keys, view unified key. |
| `PlaygroundPage.tsx` | `/playground` | Interactive chat playground. Test prompts, see routing. |
| `AnalyticsPage.tsx` | `/analytics` | Request analytics: volume, success rate, latency, token usage, provider breakdowns. |
| `LogsPage.tsx` | `/logs` | Server log viewer. |
| `UsageLimitsPage.tsx` | `/usage-limits` | Per-model usage limit configuration. |
| `PremiumPage.tsx` | `/catalog` | Premium catalog sync and management. |

### Components (`src/components/`)
| Component | Purpose |
|---|---|
| `ui/` | shadcn/ui primitives: button, card, input, select, switch, table, badge, dropdown-menu, popover, separator, label, textarea. |
| `page-header.tsx` | Standard page header with title, description, actions. |
| `floating-bar.tsx` | Floating action bar at bottom of pages. |
| `models-tabs.tsx` | Tab navigation for model sub-pages (Chat/Fusion/Embeddings/Image/Audio). |
| `api-usage.tsx` | API usage display component. |
| `auth-gate.tsx` | Authentication gate: login form or children. |
| `copy-button.tsx` | Copy-to-clipboard button. |
| `error-boundary.tsx` | React error boundary. |
| `markdown.tsx` | Markdown renderer (react-markdown + remark-gfm). |
| `tooltip.tsx` | Tooltip component. |
| `media-models.tsx` | Shared media model list component. |

### Lib (`src/lib/`)
| File | Purpose |
|---|---|
| `api.ts` | API client: `apiFetch()`, token management, 401 handling. |
| `format.ts` | Formatters: latency, tokens, percent, currency. |
| `utils.ts` | `cn()` utility (clsx + tailwind-merge). |
| `model-groups.ts` | Client-side model group helpers. |

### i18n (`src/i18n/`)
- `I18nProvider.tsx` — React context for locale.
- `index.ts` — Exports `useI18n`, locale types.
- `locales/` — Translation files.

### Styling (`index.css`)
- TailwindCSS 4 with `@theme inline` for design tokens.
- Dark mode via `.dark` class on `<html>`.
- Desktop shell: translucent glass backdrop (`html.desktop`).
- Custom scrollbar styling.
- Fonts: Geist Variable (sans), Geist Mono Variable (mono).

---

## Desktop App (`desktop/`)

Electron menu-bar app that wraps the server + client:
- `src/main.ts` — Electron main process: creates window, manages tray.
- `src/preload.ts` — Preload script for main window (IPC bridge).
- `src/popover.ts` — Glass popover with live request stats.
- `src/tray.ts` — System tray icon and menu.
- `src/config.ts` — Desktop-specific configuration.
- `src/stats.ts` — Live stats collection for popover.
- `src/server-host.ts` — Embeds the Express server.
- `src/i18n.ts` — Desktop-specific i18n.
- Build: `npm run desktop:dist` (macOS), `npm run desktop:dist:win` (Windows).

---

## Shared Types (`shared/`)

- `types.ts` — All TypeScript interfaces/types shared between server and client:
  - `Platform` — Union of all supported provider platform identifiers.
  - `Model`, `ApiKey`, `FallbackEntry` — Core domain models.
  - `ChatMessage`, `ChatCompletionRequest/Response/Chunk` — OpenAI wire format types.
  - `Quirk`, `QuirkTarget` — Model quirks system.
  - `RoutingStrategy`, `ModelGroupInfo`, `UnifySettings` — Routing types.
  - `AnalyticsSummary`, `PlatformStats`, `RequestLog`, `ServerLogEntry` — Analytics types.
  - `RateLimitStatus` — Rate limit tracking types.

---

## Commands

| Command | Purpose |
|---|---|
| `npm install` | Install all workspace dependencies. |
| `npm run dev` | Start server (:3001) + client (:5173) with HMR. |
| `npm run dev:lan` | Dev mode with LAN access (--host). |
| `npm test` | Run server vitest + client tests (if present). |
| `npm run build` | Build server + client for production. |
| `npm run build:server` | Build server only. |
| `npm run desktop:dev` | Build client + run Electron in dev. |
| `npm run desktop:dist` | Build client + package Electron (macOS). |
| `npm run desktop:dist:win` | Build client + package Electron (Windows). |

### Server-specific
| Command | Purpose |
|---|---|
| `npm run dev -w server` | Server dev only (tsx watch). |
| `npm test -w server` | Vitest run (forks, sequential). |
| `npm run test:watch -w server` | Vitest in watch mode. |
| `npm run export-catalog -w server` | Export model catalog. |

### Client-specific
| Command | Purpose |
|---|---|
| `npm run dev -w client` | Vite dev server. |
| `npm run build -w client` | TypeScript check + Vite build. |
| `npm run lint -w client` | ESLint. |
| `npm run preview -w client` | Preview production build. |

---

## Environment Variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `ENCRYPTION_KEY` | Yes (prod) | Auto-generated (dev) | AES-256-GCM key for API key encryption. 64 hex chars. |
| `PORT` | No | 3001 | Server port. |
| `HOST` | No | `::` (dual-stack) | Server bind address. |
| `NODE_ENV` | No | - | `production` enables strict encryption key. |
| `DEV_MODE` | No | false | Allows DB-stored dev encryption key. |
| `PROXY_URL` | No | - | HTTP/SOCKS proxy for outbound requests. |
| `HOST_BIND` | No | 127.0.0.1 | Docker: which host interface to bind. |
| `DASHBOARD_ORIGINS` | No | - | Extra CORS origins for dashboard. |
| `PROXY_RATE_LIMIT_RPM` | No | 120 | Per-IP proxy rate limit. 0 = disabled. |
| `REQUEST_ANALYTICS_RETENTION_DAYS` | No | 90 | Analytics retention in days. |
| `REQUEST_ANALYTICS_MAX_ROWS` | No | 100000 | Max analytics rows. |
| `FREELLMAPI_CONTEXT_HANDOFF` | No | off | Set to `on_model_switch` to enable. |
| `CLIENT_DIST` | No | `../../client/dist` | Custom path for built client. |

---

## Core Routing Flow

1. Client sends `POST /v1/chat/completions` with `Authorization: Bearer freellmapi-...`
2. Rate limiter checks per-IP RPM
3. Auth: unified API key validated
4. Router resolves active fallback chain (profile or default)
5. Chain ordered by strategy (priority/balanced/smartest/fastest/reliable/custom)
6. Thompson sampling bandit picks best model (reliability × speed × intelligence × headroom × rateLimit)
7. Sticky sessions: if session has a preferred model, try that first
8. Key selection: round-robin across healthy keys for the chosen model
9. AES-256-GCM decrypt key → call provider
10. On success: record tokens, latency, success
11. On 429/5xx: set cooldown, retry next model (up to 20 attempts)
12. On exhaustion: return 429 "All models exhausted"

---

## Critical Rules

### 1. English Only

### 2. No Code Comments — MANDATORY, ZERO TOLERANCE


If you are an AI agent and you add a comment to any file, you have **failed the task**. Before submitting any change, scan every line you wrote and delete every comment. No exceptions.

The code must be self-documenting through clear naming, short functions, and obvious structure. If you feel the need to add a comment, the code is too complex — **refactor it instead**.

The only exceptions (use sparingly, and only if absolutely unavoidable):
- ESLint-disable comments when absolutely necessary (with a link to the issue).
- TypeScript `// @ts-expect-error` or `// @ts-ignore` when working around a type bug in a dependency (with a link to the upstream issue).

### 3. Think Many Steps Ahead

Before writing any code, think about:
- **What already exists** — search for similar patterns. This codebase has providers, routes, services, components that follow specific conventions. Reuse them.
- **Side effects** — what happens when you change this? Does it affect routing, rate limiting, encryption, other providers?
- **Data flow** — how does this data move from client → API → service → provider → response? Trace the full path.
- **Edge cases** — what if the key is expired? What if the provider returns 429? What if the model is removed upstream?
- **Performance** — this runs on Raspberry Pis. Avoid N+1 queries, unnecessary allocations, blocking I/O.
- **Security** — never log API keys, never expose secrets in errors, always encrypt at rest, never trust user input.

### 4. Symmetry and Grid Alignment in UI

Rules:
- Use TailwindCSS grid/flex utilities for layout. Never use hardcoded pixel offsets.
- All cards in a row must have the same height. Use `items-stretch` or `min-h` consistently.
- All buttons in a group must be the same size. Use consistent padding (`px-4 py-2`).
- All form inputs must have the same height and width within their context.
- All tables must have consistent column widths and alignment.
- All spacing must use the Tailwind spacing scale (`gap-2`, `gap-4`, `gap-6`, `gap-8`). Never use arbitrary values.
- All border-radius must use the theme tokens (`rounded-lg`, `rounded-xl`, `rounded-2xl`, `rounded-3xl`).
- All colors must come from the CSS variables in `index.css` (e.g., `text-foreground`, `bg-muted`, `border-border`). Never use hardcoded colors.
- All font sizes must use the type scale (`text-xs`, `text-sm`, `text-base`, `text-lg`, `text-xl`, `text-2xl`).

### 5. Match the Site Style

The site has a very specific aesthetic:
- **Minimalist, clean, monochrome.** Black text on white (light) or white text on near-black (dark).
- **Geist font family.** Sans-serif for body, monospace for code.
- **Subtle borders** (`border-border` = `oklch(0.92 0 0)` light / `oklch(1 0 0 / 10%)` dark).
- **Backdrop blur** on navbar and floating elements.
- **Tabular numerals** on numbers (`.tabular-nums`).
- **No drop shadows** except brand dot (`shadow-sm shadow-foreground/20`).
- **No gradients** except desktop glass backdrop.
- **No animations** except transitions (`transition-colors`, `transition-opacity`).
- **No emojis** in the UI. Use Lucide icons instead.
- **No tooltips** unless absolutely necessary. Prefer inline text.
- **Cards** use `rounded-3xl` border radius, `bg-card` background.
- **Buttons** are `rounded-lg`, use `buttonVariants()` from shadcn.
- **Inputs** are `rounded-lg`, use `bg-input` or `bg-secondary`.

### 6. Use shadcn/ui Components

Always use existing shadcn/ui components from `src/components/ui/`. Do not create new primitives unless absolutely necessary. The available components are:
- `button.tsx` — with `buttonVariants()` for styling
- `card.tsx` — Card, CardHeader, CardContent, CardFooter, CardTitle, CardDescription
- `input.tsx`
- `select.tsx` — Select, SelectTrigger, SelectContent, SelectItem
- `switch.tsx`
- `table.tsx` — Table, TableHeader, TableBody, TableRow, TableHead, TableCell
- `badge.tsx`
- `dropdown-menu.tsx` — full dropdown menu system
- `popover.tsx`
- `separator.tsx`
- `label.tsx`
- `textarea.tsx`

### 7. Follow Existing Code Patterns
- Routes: Express Router, use `z` (Zod) for request validation, return JSON with `{ error: { message, type } }` on failure.
- Services: pure functions where possible, get DB via `getDb()`, return typed results.
- Providers: extend `BaseProvider`, implement `chatCompletion()` and `streamChatCompletion()`.
- All imports use `.js` extensions (ESM).
- Pages: functional components with hooks, use `useQuery`/`useMutation` from React Query.
- API calls: always via `apiFetch()` from `src/lib/api.ts`.
- State: React Query for server state, `useState`/`useReducer` for local state, URL params for navigation state.
- Components: accept props, use `cn()` for class merging, follow shadcn patterns.

### 8. Test Everything

Every change must include tests. Run before committing:
```bash
npm test -w server
```

Tests use vitest. Follow existing test patterns in `src/__tests__/`. Tests should:
- Be isolated (no shared state between tests).
- Use in-memory SQLite when testing DB operations.
- Mock external HTTP calls (never hit real providers in tests).
- Cover both success and error paths.

### 9. Security is Non-Negotiable

- **Never log API keys, passwords, or session tokens.** Use `maskKey()` for display.
- **Never expose upstream provider errors to clients.** Use `sanitizeProviderErrorMessage()`.
- **Always encrypt API keys at rest** with AES-256-GCM (already handled by `crypto.ts`).
- **Always validate input** with Zod schemas on the server.
- **Never trust the `model` parameter** — the router decides, not the client.
- **Session tokens** are SHA-256 hashed before storage (never store raw).
- **Passwords** are scrypt-hashed (never plain text).

### 10. Performance Constraints

This runs on Raspberry Pis. Every optimization matters:
- SQLite with WAL mode (already configured).
- In-memory rate limit counters (not per-request DB writes).
- Cached stats with decay-weighted window (60s TTL).
- Lazy-loaded proxy agents (no import cost when unused).
- Lazy-loaded desktop components (React.lazy + Suspense).
- No N+1 queries — batch database operations.
- Streaming responses (never buffer full response in memory).

### 11. No Breaking Changes to /v1 API

The `/v1/chat/completions` endpoint is a public API consumed by OpenAI SDKs, LangChain, LlamaIndex, Continue, Hermes, OpenCode, and many more. Changes must be backward-compatible:
- New fields in request/response are additive.
- Existing fields must not change type or semantics.
- The `model` field must always accept `auto` and any valid model ID.
- Streaming format must match OpenAI's SSE spec exactly.

### 12. Provider Adding Template

When adding a new provider:
1. If OpenAI-compatible: copy `openai-compat.ts`, register in `index.ts`.
2. If custom format: extend `BaseProvider` directly.
3. Add platform to `Platform` type in `shared/types.ts`.
4. Seed model catalog in `src/db/index.ts` migrations.
5. Add platform color in `src/pages/fallback/model-colors.ts` (client).
6. Add tests in `src/__tests__/providers/`.
7. Verify the free tier is genuinely free (no card required).

### 13. Commit Messages

Use conventional commits:
- `feat: add new provider X`
- `fix: handle 429 from provider Y on model Z`
- `refactor: simplify router key selection`
- `test: add coverage for fusion edge case`
- `docs: update README with new provider`

### 14. PR Expectations

- One logical change per PR.
- Include tests for new code.
- Run `npm test` and `npm run build` before submitting.
- Match existing code style (TypeScript strict mode, ESM imports with `.js` extension).
- Describe what changed and why in the PR description.
- Keep diffs minimal — no unrelated formatting changes.

### 15. Database Migrations

When modifying the schema:
- Add a new `migrateDbSchemaV{N}` function in `db/migrations.ts`.
- Increment `CURRENT_SCHEMA_VERSION`.
- Migrations are additive only (never drop columns/tables).
- Test migration from the previous version to the new one.

### 16. i18n

All user-facing strings in the client must go through the i18n system:
- Use `t('key')` from `useI18n()` hook.
- Add keys to all locale files in `src/i18n/locales/`.
- Default locale is English.
- Keys follow dot notation: `nav.models`, `keys.title`, etc.

### 17. Error Handling
- Use `RouteError` class for routing failures (carries HTTP status).
- Use `ProviderHttpError` for upstream failures (carries status + retryAfter).
- Use `EmbeddingsError` and `MediaError` for specialized failures.
- Always sanitize error messages before returning to client.
- Use React Query's `error` state for API failures.
- Use `ErrorBoundary` for component crashes.
- Show user-friendly messages, never raw error objects.

### 18. Environment Safety

- `.env` is gitignored — never commit real keys.
- `.env.example` contains only placeholder values.
- `ENCRYPTION_KEY` is required in production, auto-generated in dev.
- Database file (`server/data/freeapi.db`) is gitignored.
- The server will not start in production without a valid `ENCRYPTION_KEY`.

<!-- SPECKIT START -->
For additional context about technologies to be used, project structure,
shell commands, and other important information, read the current plan:
`specs/001-consolidated-settings-page/plan.md`
<!-- SPECKIT END -->
