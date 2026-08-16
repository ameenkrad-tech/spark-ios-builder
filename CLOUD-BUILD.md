# Cloud native builds (GitHub Actions macOS runner)

Spark builds real native iOS apps by generating SwiftUI, compiling it with `swiftc`, running it in the
iOS Simulator, and screenshotting it — no Xcode project, no signing, no Apple Developer account. This
doc sets up the **cloud** path, where that work runs on a **GitHub Actions macOS runner** instead of
your own Mac. Nothing runs on your machine, nothing fills your local disk, and builds work even when
your Mac is asleep.

## How it works

```
iOS/web client
   │  POST /api/build-native-async { prompt, iconImage?, label?, deviceId? }
   ▼
Vercel backend ──1─▶ Supabase `builds` row  (status: queued)
   │                                            ▲        ▲
   └──2─▶ GitHub repository_dispatch ──▶ macOS runner (5) writes result:
             (event: spark-build,          runs scripts/native-build-runner.mjs
              payload: { buildId })         generate → compile → run in sim →
                                            screenshot → fix → retry
   ┌──3── client polls GET /api/build-status?id=<buildId> ──▶ status: done|failed
```

1. Backend inserts a `queued` row and returns `{ buildId }` immediately.
2. Backend fires a `repository_dispatch` (`event_type: spark-build`) carrying just the `buildId`.
3. The `macos-latest` runner reads the job from Supabase, runs the full agentic loop, and PATCHes the
   row to `done` (with `screenshot` + `swift`) or `failed` (with `phase` + `errors`).
4. The client polls `/api/build-status?id=…` until `status` is `done` or `failed`.

The old synchronous path (`POST /api/build-native` → your Mac via `mac-agent/`) still works and is
untouched — this is added alongside it.

## One-time setup

### 1. Create the Supabase `builds` table
Supabase → SQL Editor → run [`supabase/builds.sql`](supabase/builds.sql). (RLS on, no policies — only
the service-role key touches it, same pattern as `agents`/`app_config`.)

### 2. Commit + push the workflow to the default branch
`repository_dispatch` only triggers workflows that already exist on the repo's **default branch**, so
these must be pushed before the backend can trigger anything:
- `.github/workflows/native-build.yml`
- `scripts/native-build-runner.mjs`

### 3. Add GitHub repo secrets
Repo → Settings → Secrets and variables → Actions → **New repository secret** (add all three):

| Secret | Value |
| --- | --- |
| `SUPABASE_URL` | your `https://YOUR-PROJECT.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API → **service_role** key |
| `OPENROUTER_API_KEY` | your OpenRouter key (`sk-or-…`) |

### 4. Create a PAT so the backend can trigger the runner
GitHub → Settings → Developer settings → **Personal access tokens**:
- **Fine-grained** (recommended): scope it to *only* the Spark repo, with **Repository permissions →
  Contents: Read and write** (this is what `repository_dispatch` requires).
- **Classic** alternative: check the **`repo`** scope.

### 5. Add Vercel env vars
Vercel → Project → Settings → Environment Variables (Production + Preview):

| Var | Value |
| --- | --- |
| `GITHUB_BUILD_REPO` | `your-github-user/spark` |
| `GITHUB_DISPATCH_TOKEN` | the PAT from step 4 |
| `OPENROUTER_API_KEY` | your OpenRouter key (also used by the synchronous path) |
| `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SPARK_APP_TOKEN` | already set for the app |

Redeploy after adding them.

## Test it

Queue a build (replace the host + token):
```bash
curl -s -X POST https://YOUR-APP.vercel.app/api/build-native-async \
  -H "content-type: application/json" \
  -H "x-spark-app: $SPARK_APP_TOKEN" \
  -d '{"prompt":"a tip calculator with a slider","label":"TipJar"}'
# → {"ok":true,"buildId":"…","status":"queued"}
```
Watch the run in the repo's **Actions** tab, then poll:
```bash
curl -s "https://YOUR-APP.vercel.app/api/build-status?id=THE_BUILD_ID" \
  -H "x-spark-app: $SPARK_APP_TOKEN"
# status: queued → running → done  (with a base64 screenshot data URL) | failed (phase + errors)
```
You can also trigger a runner by hand from the **Actions → Spark Native Build → Run workflow** button
(it takes a `buildId` of an existing queued row).

## API contract (for the iOS client — task #19)

- **Start:** `POST /api/build-native-async`
  body `{ prompt: string, iconImage?: string (data URL), label?: string, deviceId?: string }`,
  header `x-spark-app: <SPARK_APP_TOKEN>` → `{ ok, buildId, status: "queued" }`.
- **Poll:** `GET /api/build-status?id=<buildId>` (same header) →
  `{ status: "queued"|"running"|"done"|"failed", screenshot?, swift?, phase?, errors?, rounds }`.
  Poll every ~3s; stop on `done`/`failed`. On `done`, render `screenshot` (a `data:image/png;base64,…`
  URL) exactly like the synchronous path already does. On `failed`, show `errors` (and offer retry).

## Not yet covered (follow-ups)

- **iOS client wiring (task #19):** the app still calls the synchronous `/api/build-native`. Point the
  native-build screen at the two endpoints above and add the poll loop.
- **App icon + openable project:** the cloud runner produces a screenshot + Swift source but does not
  yet bake the brand logo (`icon`) into an app icon or export the openable `.swiftpm` (the synchronous
  Mac path still does via `mac-agent/server.js`). Add as a workflow artifact / Supabase Storage upload
  when needed.
- **Cost:** GitHub-hosted macOS minutes bill per-minute; past heavy usage, revisit the MacStadium
  dedicated-Mac plan (see `TODO.md`).
