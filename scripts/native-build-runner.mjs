#!/usr/bin/env node
/**
 * Spark native iOS CLOUD-build runner — runs on a GitHub Actions macOS runner.
 *
 * A one-shot port of `mac-agent/server.js` (the swiftc + simctl pipeline) fused with the agentic
 * loop from `src/app/api/build-native/route.ts`. It reads a queued job from the Supabase `builds`
 * table, generates a SwiftUI app, compiles + runs it in the iOS Simulator (NO Xcode project, NO
 * code signing, NO Apple Developer account), feeds compile errors back to the model and retries,
 * then writes the screenshot (or the failure) back to the row. The backend queues the job and the
 * client polls /api/build-status — this runner does the heavy lifting entirely in the cloud, so it
 * never touches the user's own Mac or disk.
 *
 * Uses only Node built-ins + global fetch (Node 18+) — no `npm install`, so the workflow stays fast.
 * Env: BUILD_ID, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENROUTER_API_KEY
 */
import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { BUILD_ID, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENROUTER_API_KEY } = process.env;
for (const [k, v] of Object.entries({ BUILD_ID, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENROUTER_API_KEY })) {
  if (!v) { console.error(`Missing required env: ${k}`); process.exit(1); }
}

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const CODE_MODEL = "openai/gpt-5.6-luna"; // mirror of build-native/route.ts — keep in sync
const TARGET = "arm64-apple-ios17.0-simulator";
const MAX_ROUNDS = 4;                     // more than Vercel's synchronous path — we're not on its 300s clock
const BUDGET_MS = 12 * 60 * 1000;         // wall-clock budget (workflow timeout-minutes is the hard backstop)

// Same generation contract the synchronous backend uses. Mirror of GEN_SYSTEM in build-native/route.ts.
const GEN_SYSTEM =
  "You are an expert iOS engineer. Build a COMPLETE, COMPILABLE SwiftUI iOS app in ONE Swift file that compiles FAST. It MUST: start with `import SwiftUI`; declare `@main struct GenApp: App { var body: some Scene { WindowGroup { ContentView() } } }`; and declare a `struct ContentView: View`. Use ONLY SwiftUI + Foundation — NO external packages, NO SwiftData/CoreData, NO push notifications, NO image/asset files (draw with SF Symbols or shapes), NO networking. Keep it FOCUSED: even if the request is large, build a clean, polished version of its CORE screen/flow that fits comfortably in one file and compiles quickly — do not sprawl into many tabs/screens. Persist only with @State/@AppStorage. Output ONLY the Swift code inside one ```swift code block, nothing else.";

// ---- Supabase REST (service-role) -----------------------------------------------------------
const SB = `${SUPABASE_URL.replace(/\/$/, "")}/rest/v1/builds`;
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

// ---- The swiftc + simctl pipeline (ported verbatim from mac-agent/server.js) -----------------
function sh(cmd) { return execSync(cmd, { encoding: "utf8" }).trim(); }
const SDK = sh("xcrun --sdk iphonesimulator --show-sdk-path");

/** A booted simulator UDID, booting the first available iPhone if none is up. */
function ensureSim() {
  const list = JSON.parse(sh("xcrun simctl list devices -j")).devices;
  const all = Object.values(list).flat();
  const booted = all.find((d) => d.state === "Booted");
  if (booted) return booted.udid;
  const iphone = all.find((d) => d.isAvailable && /iPhone/.test(d.name)) || all.find((d) => d.isAvailable);
  if (!iphone) throw new Error("No available simulator");
  try { sh(`xcrun simctl boot ${iphone.udid}`); } catch {}
  try { execSync(`xcrun simctl bootstatus ${iphone.udid} -b`, { timeout: 120000 }); } catch {}
  return iphone.udid;
}

/** Compile-check the SwiftUI (fast) → returns error text, or "" if clean. (-parse-as-library for @main.) */
function typecheck(dir, file) {
  const r = spawnSync("xcrun", ["swiftc", "-typecheck", "-parse-as-library", "-sdk", SDK, "-target", TARGET, file], { cwd: dir, encoding: "utf8" });
  return r.status === 0 ? "" : (r.stderr || r.stdout || "unknown compile error");
}

/** Full build → run in the simulator → screenshot. Returns { screenshot } or throws {phase,errors}. */
function buildRunScreenshot(dir, file) {
  const bundleId = "com.spark.build" + Date.now().toString(36);
  const appDir = path.join(dir, "App.app");
  fs.mkdirSync(appDir, { recursive: true });

  const comp = spawnSync("xcrun", ["swiftc", "-parse-as-library", "-emit-executable", "-sdk", SDK, "-target", TARGET, "-o", path.join(appDir, "App"), file], { cwd: dir, encoding: "utf8" });
  if (comp.status !== 0) { const e = new Error("compile"); e.phase = "compile"; e.errors = comp.stderr || comp.stdout; throw e; }

  fs.writeFileSync(path.join(appDir, "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>CFBundleExecutable</key><string>App</string>\n<key>CFBundleIdentifier</key><string>${bundleId}</string>\n<key>CFBundleName</key><string>App</string>\n<key>CFBundleVersion</key><string>1</string>\n<key>CFBundleShortVersionString</key><string>1.0</string>\n<key>LSRequiresIPhoneOS</key><true/>\n<key>UILaunchScreen</key><dict/>\n</dict></plist>`);

  const udid = ensureSim();
  const inst = spawnSync("xcrun", ["simctl", "install", udid, appDir], { encoding: "utf8" });
  if (inst.status !== 0) { const e = new Error("install"); e.phase = "run"; e.errors = inst.stderr; throw e; }
  const launch = spawnSync("xcrun", ["simctl", "launch", udid, bundleId], { encoding: "utf8" });
  if (launch.status !== 0) { const e = new Error("launch"); e.phase = "run"; e.errors = launch.stderr; throw e; }

  execSync("sleep 3"); // let the first frame render
  const shot = path.join(dir, "shot.png");
  spawnSync("xcrun", ["simctl", "io", udid, "screenshot", shot], { encoding: "utf8" });
  spawnSync("xcrun", ["simctl", "uninstall", udid, bundleId]); // clean up
  const b64 = fs.readFileSync(shot).toString("base64");
  return { screenshot: `data:image/png;base64,${b64}` };
}

/** One compile+run attempt against the given Swift. Returns { screenshot } or { phase, errors }. */
function attempt(swift) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkbuild-"));
  const file = path.join(dir, "App.swift");
  try {
    fs.writeFileSync(file, swift);
    const typeErr = typecheck(dir, file);
    if (typeErr) return { phase: "typecheck", errors: typeErr };
    return buildRunScreenshot(dir, file); // { screenshot }
  } catch (e) {
    return { phase: e.phase || "error", errors: e.errors || String(e) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---- Orchestration: generate → compile+run → fix → repeat -----------------------------------
async function main() {
  const build = await getBuild(BUILD_ID);
  if (!build) { console.error(`Build ${BUILD_ID} not found`); process.exit(1); }
  await patchBuild(BUILD_ID, { status: "running" });

  const START = Date.now();
  const timeLeft = () => BUDGET_MS - (Date.now() - START);
  const prompt = String(build.prompt || "");

  let swift = extractSwift(await callModel(GEN_SYSTEM, `Build this iOS app:\n${prompt}`, timeLeft()));
  let rounds = 0;
  let phase, errors, screenshot;

  for (let i = 0; i < MAX_ROUNDS; i++) {
    if (!swift || swift.length < 40) { phase = "generate"; errors = "Couldn't write the code in time."; break; }
    const r = attempt(swift);
    if (r.screenshot) { screenshot = r.screenshot; phase = undefined; errors = undefined; break; }
    phase = r.phase; errors = r.errors;
    rounds++;
    if (i === MAX_ROUNDS - 1 || timeLeft() < 90_000) break; // no time / rounds for another fix
    const fixed = extractSwift(await callModel(
      GEN_SYSTEM + " You are FIXING compile errors — return the COMPLETE corrected file.",
      `Build this iOS app:\n${prompt}\n\nThe current code failed to compile with these errors (${phase}):\n${errors}\n\nCURRENT CODE:\n\`\`\`swift\n${swift.slice(0, 40000)}\n\`\`\`\n\nFix the errors and return the complete corrected Swift file.`,
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

main().catch(async (e) => {
  console.error(e);
  try { await patchBuild(BUILD_ID, { status: "failed", phase: "error", errors: String(e).slice(0, 500) }); } catch {}
  process.exit(1);
});
