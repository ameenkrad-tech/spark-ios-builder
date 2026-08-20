# Ship Spark-built apps to TestFlight (real iPhone installs + HealthKit)

This adds a **signed, App-Store-Connect upload** path on top of the simulator build pipeline, so any
Spark-built app can land on your real iPhone via TestFlight — which also unlocks the frameworks that
need a real provisioning profile (HealthKit, push, etc.).

## What's already true (verified 2026-08-20)
- You have the **paid Apple Developer Program** (Team `54MCPMGA42`, "Muhamad Krad"). Proof: your
  provisioning profiles are valid a full year (free personal teams get 7-day profiles).
- The whole `xcodegen → archive → export → signed .ipa` flow works non-interactively with your
  account (`-allowProvisioningUpdates` auto-creates the profile for a brand-new bundle id).

## The ONE thing only you can do — create an App Store Connect API key (~2 min)
This single credential lets the cloud runner create the distribution cert, sign, and upload to
TestFlight headlessly — no Apple ID password ever leaves your machine.

1. Go to **https://appstoreconnect.apple.com** → **Users and Access** → **Integrations** tab
   (top) → **App Store Connect API** → **Team Keys**.
2. Click **+** (Generate API Key). Name it `Spark CI`. Access role: **App Manager**
   (App Manager can create apps + manage TestFlight; Admin also works). Click **Generate**.
3. You now see three things — send me all three:
   - **Issuer ID** (a UUID at the top of the Keys list, e.g. `69a6de70-…`)
   - **Key ID** (the row's 10-char ID, e.g. `2X9R4HXF34`)
   - **Download API Key** — the `.p8` file. **You can only download it once.** Save it, then
     paste its contents to me (it's a short `-----BEGIN PRIVATE KEY-----` block).

That's it. With those three, I set the GitHub secrets below and we ship a test build to your phone.

## GitHub secrets I'll set (in `ameenkrad-tech/spark-ios-builder`)
| Secret | Value |
|---|---|
| `APPLE_TEAM_ID` | `54MCPMGA42` |
| `ASC_KEY_ID` | the Key ID from step 3 |
| `ASC_ISSUER_ID` | the Issuer ID from step 3 |
| `ASC_KEY_P8` | the full contents of the `.p8` file |

(`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` are already set from the simulator pipeline.)

## How it runs
- Trigger: `repository_dispatch` event `spark-testflight` with `{ buildId }` — fired by the backend
  when you tap **Send to my iPhone (TestFlight)** on a finished build.
- `.github/workflows/testflight.yml` runs `scripts/testflight.mjs`, which:
  1. Fetches the build's stored project from Supabase and reconstructs it.
  2. Rewrites bundle ids to `com.MuhamadKrad.spark.<slug>` (+ `.watchkitapp` / widget), turns on
     automatic signing with `DEVELOPMENT_TEAM = 54MCPMGA42`.
  3. Ensures the App Store Connect **app record** exists for that bundle id (creates it via the API).
  4. `xcodebuild archive` → `-exportArchive` with `method: app-store-connect`, cloud-managed
     distribution signing, `destination: upload` → the build appears in TestFlight.
  5. Writes the TestFlight status back to the `builds` row; the app shows "processing → ready".
- You install it from the **TestFlight** app on your iPhone (first time: accept the tester invite for
  your own Apple ID). Processing on Apple's side is usually a few minutes.

## Notes / limits
- **App name + bundle id** must be unique per app across your account. Generated apps get a slug from
  their display name; collisions get a numeric suffix.
- **HealthKit** apps now work here (the distribution profile carries the entitlement) — but Health
  data on the phone is real, so the app must request authorization and handle the empty/denied case.
- TestFlight builds need a bump of the **build number** on every upload; the runner sets it from a
  timestamp so re-uploads never collide.
