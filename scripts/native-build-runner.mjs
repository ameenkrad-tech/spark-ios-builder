#!/usr/bin/env node
/**
 * Spark native iOS CLOUD-build runner — runs on a GitHub Actions macOS runner.
 *
 * Builds a real Xcode project with `xcodegen` + `xcodebuild` (not single-file `swiftc`), so generated
 * apps can be multi-file and use real system frameworks (CoreLocation, MapKit, HealthKit, …). It reads
 * a queued job from the Supabase `builds` table, generates SwiftUI, assembles a project, builds + runs
 * it in the iOS Simulator, feeds `xcodebuild` errors back and retries, then writes the screenshot (or
 * the failure) back to the row.
 *
 * NO code signing / dev account (simulator build). Uses only Node built-ins + global fetch.
 * Env: BUILD_ID, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENROUTER_API_KEY
 *      XCODEGEN_BIN (optional) — path to xcodegen (defaults to `xcodegen` on PATH; preinstalled on runners)
 */
import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { BUILD_ID, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENROUTER_API_KEY } = process.env;

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const CODE_MODEL = "openai/gpt-5.6-luna"; // mirror of build-native/route.ts — keep in sync
const MAX_ROUNDS = 4;
const BUDGET_MS = 15 * 60 * 1000;         // xcodebuild is slower than swiftc — a bit more headroom
const XCODEGEN = process.env.XCODEGEN_BIN || "xcodegen";

// Multi-file generation. The model emits an optional CAPABILITIES line + one block per source file,
// delimited by `>>>>>> FILE: <name>` (no JSON, to dodge quote-escaping bugs).
const GEN_SYSTEM =
  "You are a senior iOS engineer who ships polished, App-Store-quality SwiftUI. Build a COMPLETE, COMPILABLE MULTI-FILE iOS 17 app.\n\n" +
  "OUTPUT FORMAT (STRICT): If the app uses device capabilities, put ONE line first — `CAPABILITIES: location` (the only allowed value is `location`, for CoreLocation/MapKit; omit the whole line if unused). Then output EACH source file as a block: a line `>>>>>> FILE: <Name>.swift` immediately followed by that file's RAW Swift (NO ``` code fences, no commentary). Example:\n" +
  "CAPABILITIES: location\n" +
  ">>>>>> FILE: App.swift\n" +
  "import SwiftUI\n" +
  "@main struct GenApp: App { var body: some Scene { WindowGroup { RootView() } } }\n" +
  ">>>>>> FILE: RootView.swift\n" +
  "import SwiftUI\n" +
  "struct RootView: View { var body: some View { Text(\"Hi\") } }\n\n" +
  "STRUCTURE: split the app into SEVERAL well-named files (App.swift with `@main struct GenApp: App`, screen views, a models file, reusable components). EXACTLY ONE file declares `@main struct GenApp: App`. Build a real multi-screen app with `TabView` and/or `NavigationStack`.\n\n" +
  "FRAMEWORKS: SwiftUI + Foundation always. You MAY ALSO use MapKit (the iOS-17 `Map` + `MapCameraPosition`), CoreLocation (a `CLLocationManager` requesting when-in-use, showing the user's location), and Swift `Charts`. If you use CoreLocation you MUST declare `CAPABILITIES: location`. Do NOT use HealthKit, ActivityKit / Live Activities, SwiftData, networking, push notifications, image/asset files, or external packages (those need setup not available here — draw with SF Symbols and shapes).\n\n" +
  "RULES: target iOS 17 — `NavigationStack` never `NavigationView`. Persist with `@State`/`@AppStorage`/a single `@StateObject ObservableObject` (`@AppStorage` stores only primitives — JSON-encode collections to `Data`). Everything referenced must be defined across the files; every View stored property is initialized or passed in; `ForEach` uses `Identifiable` or an explicit `id:`.\n\n" +
  "DESIGN: cohesive accent color, generous consistent padding, clear type hierarchy, rounded cards, SF Symbols, realistic built-in sample data (no blank screens), `.navigationTitle`, tappable rows that navigate.\n\n" +
  "AVOID: multiple or misnamed `@main`; `Color(hex:)` (use `Color(red:green:blue:)`); the old single-parameter `.onChange(of:) { v in }`; undeclared types; non-primitive `@AppStorage`.\n\n" +
  "Output ONLY the optional CAPABILITIES line and the `>>>>>> FILE:` blocks — nothing else.";

/** Device capabilities → Info.plist usage strings (simulator-safe; no entitlements needed for these). */
const CAP_INFO = {
  location: { NSLocationWhenInUseUsageDescription: "This app uses your location to map and track your activity." },
  motion: { NSMotionUsageDescription: "This app uses motion to track your activity." },
  camera: { NSCameraUsageDescription: "This app uses the camera." },
  microphone: { NSMicrophoneUsageDescription: "This app uses the microphone." },
};

/** Parse the model's delimited multi-file reply → { files: {name: swift}, capabilities: [...] }.
 *  Falls back to treating the whole reply as a single App.swift if no FILE blocks are found. */
export function parseProject(raw) {
  const text = String(raw);
  let capabilities = [];
  const capM = text.match(/^[ \t]*CAPABILITIES:[ \t]*(.+)$/im);
  if (capM) capabilities = capM[1].split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter((c) => c in CAP_INFO);

  const files = {};
  const re = />>>>>>[ \t]*FILE:[ \t]*([^\n]+)\n([\s\S]*?)(?=\n>>>>>>[ \t]*FILE:|$)/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    let name = m[1].trim().replace(/[`"']/g, "");
    let body = m[2].trim();
    const fence = body.match(/^```(?:swift)?[ \t]*\n([\s\S]*?)\n?```$/i);
    if (fence) body = fence[1].trim();
    if (name && body.length > 5) files[name.endsWith(".swift") ? name : `${name}.swift`] = body;
  }
  if (Object.keys(files).length === 0) {
    const swift = extractSwift(raw);
    if (swift && swift.length > 40) files["App.swift"] = swift;
  }
  return { files, capabilities };
}

/** Reassemble a parsed project into the delimited format (for the fix prompt). */
export function serializeProject(files, capabilities) {
  let out = capabilities.length ? `CAPABILITIES: ${capabilities.join(", ")}\n` : "";
  for (const [name, body] of Object.entries(files)) out += `>>>>>> FILE: ${name}\n${body}\n`;
  return out;
}

// ---- Supabase REST (service-role) -----------------------------------------------------------
const SB = SUPABASE_URL ? `${SUPABASE_URL.replace(/\/$/, "")}/rest/v1/builds` : "";
const SB_HEADERS = {
  apikey: SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  "Content-Type": "application/json",
};
async function getBuild(id) {
  const res = await fetch(`${SB}?id=eq.${encodeURIComponent(id)}&select=*`, { headers: SB_HEADERS });
  if (!res.ok) throw new Error(`Supabase read failed (${res.status}): ${await res.text()}`);
  const rows = await res.json();
  return Array.isArray(rows) ? rows[0] : null;
}
async function patchBuild(id, fields) {
  const res = await fetch(`${SB}?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { ...SB_HEADERS, Prefer: "return=minimal" },
    body: JSON.stringify({ ...fields, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`Supabase write failed (${res.status}): ${await res.text()}`);
}

// ---- Model call (never throws; "" on timeout/error) -----------------------------------------
async function callModel(system, user, budgetMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(15000, Math.min(180000, budgetMs)));
  try {
    const res = await fetch(OPENROUTER_URL, {
      method: "POST",
      signal: controller.signal,
      headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}`, "Content-Type": "application/json", "HTTP-Referer": "https://spark.app", "X-Title": "Spark Native Cloud" },
      body: JSON.stringify({ model: CODE_MODEL, temperature: 0.3, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
    });
    const data = await res.json();
    return (data?.choices?.[0]?.message?.content ?? "").trim();
  } catch {
    return "";
  } finally {
    clearTimeout(timeout);
  }
}
/** Pull Swift out of a ```swift … ``` block (or the whole reply if unfenced). */
function extractSwift(raw) {
  const m = String(raw).match(/```(?:swift)?\s*([\s\S]*?)```/i);
  return (m ? m[1] : String(raw)).trim();
}

// ---- Build pipeline: xcodegen → xcodebuild → simulator → screenshot -------------------------
function sh(cmd) { return execSync(cmd, { encoding: "utf8" }).trim(); }

/** A booted simulator UDID, booting the first available iPhone if none is up. */
function ensureSim() {
  const list = JSON.parse(sh("xcrun simctl list devices -j")).devices;
  const all = Object.values(list).flat();
  const booted = all.find((d) => d.state === "Booted");
  if (booted) return booted.udid;
  const iphone = all.find((d) => d.isAvailable && /iPhone/.test(d.name)) || all.find((d) => d.isAvailable);
  if (!iphone) throw new Error("No available simulator");
  try { sh(`xcrun simctl boot ${iphone.udid}`); } catch {}
  try { execSync(`xcrun simctl bootstatus ${iphone.udid} -b`, { timeout: 180000 }); } catch {}
  return iphone.udid;
}

/** xcodegen project spec for a single-target iOS app, with Info.plist usage strings for capabilities. */
function projectYml(target, displayName, bundleId, capabilities = []) {
  const props = {};
  for (const c of capabilities) Object.assign(props, CAP_INFO[c] || {});
  const extra = Object.entries(props).map(([k, v]) => `        ${k}: ${JSON.stringify(v)}`).join("\n");
  return `name: ${target}
options:
  bundleIdPrefix: com.spark.gen
  deploymentTarget:
    iOS: "17.0"
targets:
  ${target}:
    type: application
    platform: iOS
    sources:
      - Sources
    info:
      path: Info.plist
      properties:
        CFBundleDisplayName: ${JSON.stringify(displayName)}
        UILaunchScreen: {}
${extra ? extra + "\n" : ""}    settings:
      base:
        PRODUCT_BUNDLE_IDENTIFIER: ${bundleId}
        GENERATE_INFOPLIST_FILE: "NO"
        TARGETED_DEVICE_FAMILY: "1"
        CODE_SIGNING_ALLOWED: "NO"
        CODE_SIGNING_REQUIRED: "NO"
        CODE_SIGN_IDENTITY: ""
`;
}

/** Pull the compiler errors out of xcodebuild's verbose log (fall back to the tail). */
function xcodeErrors(out) {
  const lines = String(out).split("\n").filter((l) => /error:|error G|fatal error/i.test(l));
  const picked = lines.slice(0, 40).join("\n").trim();
  return picked || String(out).slice(-2000);
}

/**
 * Assemble `files` ({ name → Swift }) into an Xcode project, build it for the simulator, run it, and
 * screenshot. Returns { screenshot } or throws { phase: "project"|"compile"|"run", errors }.
 */
export function buildAttempt(files, { target = "App", displayName = "App", capabilities = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkxc-"));
  const bundleId = `com.spark.gen.${target}`;
  try {
    const src = path.join(dir, "Sources");
    fs.mkdirSync(src, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      const p = path.join(src, name);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
    }
    fs.writeFileSync(path.join(dir, "project.yml"), projectYml(target, displayName, bundleId, capabilities));

    const gen = spawnSync(XCODEGEN, ["generate", "--spec", "project.yml"], { cwd: dir, encoding: "utf8" });
    if (gen.status !== 0) { const e = new Error("project"); e.phase = "project"; e.errors = (gen.stderr || gen.stdout || "xcodegen failed"); throw e; }

    const xb = spawnSync("xcodebuild", [
      "-project", `${target}.xcodeproj`, "-scheme", target, "-sdk", "iphonesimulator",
      "-destination", "generic/platform=iOS Simulator", "-derivedDataPath", "build",
      "CODE_SIGNING_ALLOWED=NO", "build",
    ], { cwd: dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (xb.status !== 0) { const e = new Error("compile"); e.phase = "compile"; e.errors = xcodeErrors(`${xb.stdout || ""}\n${xb.stderr || ""}`); throw e; }

    const appPath = path.join(dir, "build/Build/Products/Debug-iphonesimulator", `${target}.app`);
    if (!fs.existsSync(appPath)) { const e = new Error("run"); e.phase = "run"; e.errors = "built .app not found"; throw e; }

    const udid = ensureSim();
    const inst = spawnSync("xcrun", ["simctl", "install", udid, appPath], { encoding: "utf8" });
    if (inst.status !== 0) { const e = new Error("run"); e.phase = "run"; e.errors = inst.stderr; throw e; }
    // Pre-grant + simulate GPS so location apps screenshot with a working map instead of a permission dialog.
    if (capabilities.includes("location")) {
      spawnSync("xcrun", ["simctl", "privacy", udid, "grant", "location-always", bundleId], { encoding: "utf8" });
    }
    const launch = spawnSync("xcrun", ["simctl", "launch", udid, bundleId], { encoding: "utf8" });
    if (launch.status !== 0) { const e = new Error("run"); e.phase = "run"; e.errors = launch.stderr; throw e; }
    if (capabilities.includes("location")) {
      spawnSync("xcrun", ["simctl", "location", udid, "set", "41.8781,-87.6298"], { encoding: "utf8" }); // sample: Chicago
    }

    execSync("sleep 4"); // let the first frame render
    const shot = path.join(dir, "shot.png");
    spawnSync("xcrun", ["simctl", "io", udid, "screenshot", shot], { encoding: "utf8" });
    spawnSync("xcrun", ["simctl", "uninstall", udid, bundleId]);
    const b64 = fs.readFileSync(shot).toString("base64");
    return { screenshot: `data:image/png;base64,${b64}` };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---- Orchestration: generate → build → fix → repeat -----------------------------------------
async function main() {
  const build = await getBuild(BUILD_ID);
  if (!build) { console.error(`Build ${BUILD_ID} not found`); process.exit(1); }
  await patchBuild(BUILD_ID, { status: "running" });

  const START = Date.now();
  const timeLeft = () => BUDGET_MS - (Date.now() - START);
  const prompt = String(build.prompt || "");
  const displayName = String(build.label || "App").slice(0, 30);

  let { files, capabilities } = parseProject(await callModel(GEN_SYSTEM, `Build this iOS app:\n${prompt}`, timeLeft()));
  let rounds = 0;
  let phase, errors, screenshot;

  for (let i = 0; i < MAX_ROUNDS; i++) {
    if (!files || Object.keys(files).length === 0) { phase = "generate"; errors = "Couldn't write the project in time."; break; }
    try {
      const r = buildAttempt(files, { target: "App", displayName, capabilities });
      screenshot = r.screenshot; phase = undefined; errors = undefined; break;
    } catch (e) {
      phase = e.phase || "error"; errors = e.errors || String(e);
    }
    rounds++;
    if (i === MAX_ROUNDS - 1 || timeLeft() < 120_000) break; // xcodebuild rounds are slow — leave headroom
    const fixedRaw = await callModel(
      GEN_SYSTEM + "\n\nNOW you are FIXING build errors in the project below. Return the COMPLETE corrected project in the SAME format (optional CAPABILITIES line + `>>>>>> FILE:` blocks). Make minimal edits that resolve EVERY listed error without changing the app's behavior or design; keep it iOS-17 and self-contained.",
      `Build this iOS app:\n${prompt}\n\nThe build failed (${phase}) with these errors:\n${errors}\n\nCURRENT PROJECT:\n${serializeProject(files, capabilities).slice(0, 60000)}\n\nFix the errors and return the complete corrected project.`,
      timeLeft());
    const fixed = parseProject(fixedRaw);
    if (Object.keys(fixed.files).length === 0) break;
    files = fixed.files; capabilities = fixed.capabilities;
  }

  // Store the whole project (delimited) in `swift` so the client can reconstruct every file.
  const projectText = files ? serializeProject(files, capabilities) : "";
  if (screenshot) {
    await patchBuild(BUILD_ID, { status: "done", screenshot, swift: projectText, rounds, phase: null, errors: null });
    console.log(`BUILD OK (rounds: ${rounds}, files: ${Object.keys(files).length}, caps: ${capabilities.join(",") || "none"})`);
  } else {
    await patchBuild(BUILD_ID, { status: "failed", phase: phase || "error", errors: errors || "Build failed", swift: projectText, rounds });
    console.log(`BUILD FAILED: ${phase || "error"}`);
    process.exitCode = 1;
  }
}

// Only run the job when invoked as the runner (BUILD_ID set). Importing the module (e.g. for local
// pipeline tests) just exposes buildAttempt without touching Supabase.
if (BUILD_ID) {
  for (const [k, v] of Object.entries({ SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENROUTER_API_KEY })) {
    if (!v) { console.error(`Missing required env: ${k}`); process.exit(1); }
  }
  main().catch(async (e) => {
    console.error(e);
    try { await patchBuild(BUILD_ID, { status: "failed", phase: "error", errors: String(e).slice(0, 500) }); } catch {}
    process.exit(1);
  });
}
