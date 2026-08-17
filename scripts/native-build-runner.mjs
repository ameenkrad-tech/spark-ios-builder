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

// Single-file generation for now (multi-file generation is the next task). Mirror of GEN_SYSTEM in
// build-native/route.ts.
const GEN_SYSTEM =
  "You are a senior iOS engineer who ships polished, App-Store-quality SwiftUI. Build a COMPLETE, COMPILABLE iOS app in ONE Swift file. STRUCTURE (required): start with `import SwiftUI`; declare EXACTLY ONE `@main struct GenApp: App { var body: some Scene { WindowGroup { ContentView() } } }`; and a `struct ContentView: View` as the entry screen. Build a REAL multi-screen app — use `TabView` and/or `NavigationStack` with several well-named View structs and reusable subviews, aiming for 2-4 screens that genuinely work (e.g. list + detail + add/edit + settings), not one flat screen — but only as many as compile cleanly and fast. CONSTRAINTS (hard): SwiftUI + Foundation ONLY — NO external packages, NO SwiftData/CoreData, NO networking, NO push notifications, NO image/asset files or Bundle resources (draw with SF Symbols and shapes). Target iOS 17 and do NOT use newer APIs; use `NavigationStack`, never `NavigationView`. Persist state with `@State`, `@AppStorage`, and if useful a single `ObservableObject` store via `@StateObject`; `@AppStorage` stores only primitives, so JSON-encode arrays/structs to `Data` if you must persist them. Everything you reference must be defined in this one file; every View stored property is initialized or passed in; `ForEach` over a model uses `Identifiable` or an explicit `id:`. DESIGN (make it look designed, not default): a cohesive accent color, generous consistent padding, clear typographic hierarchy, rounded cards/sections, SF Symbols for icons, real empty states, sensible built-in sample data so no screen is blank, `.navigationTitle`, and tappable rows that navigate. AVOID these common compile errors: multiple or misnamed `@main`; `Color(hex:)` (does not exist — use `Color(red:green:blue:)` or system colors); the old single-parameter `.onChange(of:) { v in }` (iOS 17 uses the zero- or two-parameter closure); referencing undeclared types; non-primitive `@AppStorage`; and ambiguous or unbalanced trailing closures. Output ONLY the Swift code inside one ```swift code block, nothing else.";

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

/** xcodegen project spec for a single-target iOS app (Phase 1). Capabilities come in a later task. */
function projectYml(target, displayName, bundleId) {
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
    settings:
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
export function buildAttempt(files, { target = "App", displayName = "App" } = {}) {
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
    fs.writeFileSync(path.join(dir, "project.yml"), projectYml(target, displayName, bundleId));

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
    const launch = spawnSync("xcrun", ["simctl", "launch", udid, bundleId], { encoding: "utf8" });
    if (launch.status !== 0) { const e = new Error("run"); e.phase = "run"; e.errors = launch.stderr; throw e; }

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

  let swift = extractSwift(await callModel(GEN_SYSTEM, `Build this iOS app:\n${prompt}`, timeLeft()));
  let rounds = 0;
  let phase, errors, screenshot;

  for (let i = 0; i < MAX_ROUNDS; i++) {
    if (!swift || swift.length < 40) { phase = "generate"; errors = "Couldn't write the code in time."; break; }
    try {
      const r = buildAttempt({ "App.swift": swift }, { target: "App", displayName });
      screenshot = r.screenshot; phase = undefined; errors = undefined; break;
    } catch (e) {
      phase = e.phase || "error"; errors = e.errors || String(e);
    }
    rounds++;
    if (i === MAX_ROUNDS - 1 || timeLeft() < 120_000) break; // xcodebuild rounds are slow — leave headroom
    const fixed = extractSwift(await callModel(
      GEN_SYSTEM + " NOW you are FIXING compile errors. Make the MINIMAL edits that resolve EVERY listed error without changing the app's behavior, structure, or design — map each error to its line, fix the root cause, keep everything in one iOS-17 file, and return the COMPLETE corrected file.",
      `Build this iOS app:\n${prompt}\n\nThe build failed (${phase}) with these errors:\n${errors}\n\nCURRENT CODE:\n\`\`\`swift\n${swift.slice(0, 40000)}\n\`\`\`\n\nFix the errors and return the complete corrected Swift file.`,
      timeLeft()));
    if (!fixed || fixed.length < 40) break;
    swift = fixed;
  }

  if (screenshot) {
    await patchBuild(BUILD_ID, { status: "done", screenshot, swift, rounds, phase: null, errors: null });
    console.log(`BUILD OK (rounds: ${rounds})`);
  } else {
    await patchBuild(BUILD_ID, { status: "failed", phase: phase || "error", errors: errors || "Build failed", swift, rounds });
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
