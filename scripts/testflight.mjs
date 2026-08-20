#!/usr/bin/env node
/**
 * Spark → TestFlight uploader — runs on a GitHub Actions macOS runner.
 *
 * Takes a finished Spark build (its stored project source), reconstructs it as a REAL signed Xcode
 * project under the user's paid team, archives it for device, exports with cloud-managed distribution
 * signing, and uploads it to App Store Connect / TestFlight. Writes progress back to the `builds` row.
 *
 * Reuses the SAME source format + parser as the simulator runner (native-build-runner.mjs) so a build
 * ships exactly what was previewed — only signing + bundle ids differ.
 *
 * Env (GitHub secrets):
 *   BUILD_ID, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   (already used by the sim runner)
 *   APPLE_TEAM_ID            e.g. 54MCPMGA42
 *   ASC_KEY_ID              App Store Connect API key id (10 chars)
 *   ASC_ISSUER_ID          App Store Connect issuer id (uuid)
 *   ASC_KEY_P8             full contents of the AuthKey_*.p8
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// NOTE: parseProject is inlined below (NOT imported from native-build-runner.mjs) — that module runs
// its build job on import whenever BUILD_ID is set, which is exactly the env we run under here.

const {
  BUILD_ID, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
  APPLE_TEAM_ID, ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_P8,
} = process.env;

const CAP_INFO = {
  location: { NSLocationWhenInUseUsageDescription: "This app uses your location to map and track your activity." },
  motion: { NSMotionUsageDescription: "This app uses motion to track your activity." },
  camera: { NSCameraUsageDescription: "This app uses the camera." },
  microphone: { NSMicrophoneUsageDescription: "This app uses the microphone." },
  healthkit: {
    NSHealthShareUsageDescription: "This app reads your health data to show your stats.",
    NSHealthUpdateUsageDescription: "This app saves workouts to Health.",
  },
};
const targetOf = (name) => { const m = /^(App|Widget|Watch|Shared)\//i.exec(name); return m ? m[1][0].toUpperCase() + m[1].slice(1).toLowerCase() : "App"; };
const baseName = (name) => name.replace(/^(App|Widget|Watch|Shared)\//i, "");
const slugify = (s) => (s || "app").toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 28) || "app";

/** Parse the stored delimited project (mirror of native-build-runner.mjs's parseProject) →
 *  { files: {name: swift}, capabilities }. Stored source always uses `>>>>>> FILE:` blocks. */
function parseProject(raw) {
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
  if (Object.keys(files).length === 0 && text.trim().length > 40) files["App.swift"] = text.trim();
  return { files, capabilities };
}

// ---- Supabase row helpers (service role) ----------------------------------
async function sb(pathq, init = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathq}`, {
    ...init,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json", Prefer: "return=representation", ...(init.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`supabase ${res.status}: ${await res.text()}`);
  return res.json();
}
async function getBuild() { const r = await sb(`builds?id=eq.${BUILD_ID}&select=*`); return r[0]; }
async function setTF(fields) {
  try { await sb(`builds?id=eq.${BUILD_ID}`, { method: "PATCH", body: JSON.stringify(fields) }); } catch (e) { console.error("setTF", e.message); }
}
const note = (s) => { console.log("TF:", s); return setTF({ tf_status: s }); };

// ---- App Store Connect API (JWT ES256) ------------------------------------
function ascToken() {
  const header = { alg: "ES256", kid: ASC_KEY_ID, typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const payload = { iss: ASC_ISSUER_ID, iat: now, exp: now + 19 * 60, aud: "appstoreconnect-v1" };
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const signingInput = `${b64(header)}.${b64(payload)}`;
  const key = ASC_KEY_P8.includes("BEGIN") ? ASC_KEY_P8 : Buffer.from(ASC_KEY_P8, "base64").toString("utf8");
  const sig = crypto.sign("sha256", Buffer.from(signingInput), { key, dsaEncoding: "ieee-p1363" }).toString("base64url");
  return `${signingInput}.${sig}`;
}
async function asc(pathq, init = {}) {
  const res = await fetch(`https://api.appstoreconnect.apple.com/${pathq}`, {
    ...init,
    headers: { Authorization: `Bearer ${ascToken()}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
  return { ok: res.ok, status: res.status, json, text };
}

/** Make sure App Store Connect has an app record for `bundleId`; create it (+ its Bundle ID) if not.
 *  Returns { ok, appId?, message? }. Creation isn't available for every account/app — on failure we
 *  return a clear message so the user can click "New App" once and re-run. */
async function ensureAppRecord(bundleId, name) {
  // Already there?
  const found = await asc(`v1/apps?filter[bundleId]=${encodeURIComponent(bundleId)}&limit=1`);
  if (found.ok && found.json?.data?.length) return { ok: true, appId: found.json.data[0].id };

  // Ensure a Bundle ID resource exists.
  let bundleResId = null;
  const bids = await asc(`v1/bundleIds?filter[identifier]=${encodeURIComponent(bundleId)}&limit=1`);
  if (bids.ok && bids.json?.data?.length) bundleResId = bids.json.data[0].id;
  else {
    const mk = await asc("v1/bundleIds", { method: "POST", body: JSON.stringify({
      data: { type: "bundleIds", attributes: { identifier: bundleId, name: name.slice(0, 60) || "Spark App", platform: "IOS", seedId: APPLE_TEAM_ID } } },
    ) });
    if (mk.ok) bundleResId = mk.json?.data?.id;
    else return { ok: false, message: `Couldn't register bundle id ${bundleId}: ${mk.status} ${mk.text?.slice(0, 300)}` };
  }

  // Create the app record.
  const sku = `SPARK-${slugify(name)}-${Date.now().toString(36)}`.toUpperCase();
  const mkApp = await asc("v1/apps", { method: "POST", body: JSON.stringify({
    data: {
      type: "apps",
      attributes: { bundleId, name: name.slice(0, 30) || "Spark App", primaryLocale: "en-US", sku },
      relationships: { bundleId: { data: { type: "bundleIds", id: bundleResId } } },
    },
  }) });
  if (mkApp.ok) return { ok: true, appId: mkApp.json?.data?.id };
  return { ok: false, message: `App record not auto-created (${mkApp.status}). Create it once in App Store Connect → New App (name + bundle id ${bundleId}), then retry. ${mkApp.text?.slice(0, 300)}` };
}

// ---- signing-enabled project.yml (mirror of the sim runner's, minus the no-sign flags) ------------
function signedProjectYml({ displayName, appBundleId, capabilities, has, build }) {
  const appProps = {};
  for (const c of capabilities) Object.assign(appProps, CAP_INFO[c] || {});
  if (has.widget) appProps.NSSupportsLiveActivities = true;
  const appExtra = Object.entries(appProps).map(([k, v]) => `        ${k}: ${typeof v === "boolean" ? v : JSON.stringify(v)}`).join("\n");
  const appSources = has.shared ? "[App, Shared]" : "[App]";
  const appDeps = has.widget ? "\n    dependencies:\n      - target: AppWidget\n        embed: true" : "";
  const signBase = (bid) => `        PRODUCT_BUNDLE_IDENTIFIER: ${bid}
        DEVELOPMENT_TEAM: ${APPLE_TEAM_ID}
        CODE_SIGN_STYLE: Automatic
        CURRENT_PROJECT_VERSION: "${build}"
        MARKETING_VERSION: "1.0"
        GENERATE_INFOPLIST_FILE: "NO"`;
  const ent = capabilities.includes("healthkit")
    ? `    entitlements:\n      path: App/App.entitlements\n      properties:\n        com.apple.developer.healthkit: true\n` : "";

  let yml = `name: App
options:
  bundleIdPrefix: ${appBundleId.split(".").slice(0, -1).join(".")}
  deploymentTarget:
    iOS: "17.0"
    watchOS: "10.0"
targets:
  App:
    type: application
    platform: iOS
    sources: ${appSources}${appDeps}
${ent}    info:
      path: App/Info.plist
      properties:
        CFBundleDisplayName: ${JSON.stringify(displayName)}
        UILaunchScreen: {}
${appExtra ? appExtra + "\n" : ""}    settings:
      base:
${signBase(appBundleId)}
        TARGETED_DEVICE_FAMILY: "1"
`;
  if (has.widget) {
    const wSources = has.shared ? "[Widget, Shared]" : "[Widget]";
    yml += `  AppWidget:
    type: app-extension
    platform: iOS
    sources: ${wSources}
    info:
      path: Widget/Info.plist
      properties:
        CFBundleDisplayName: ${JSON.stringify(displayName + " Widget")}
        NSExtension:
          NSExtensionPointIdentifier: com.apple.widgetkit-extension
    settings:
      base:
${signBase(appBundleId + ".Widget")}
        TARGETED_DEVICE_FAMILY: "1"
`;
  }
  if (has.watch) {
    yml += `  AppWatch:
    type: application
    platform: watchOS
    sources: [Watch]
    info:
      path: Watch/Info.plist
      properties:
        WKApplication: true
        CFBundleDisplayName: ${JSON.stringify(displayName)}
    settings:
      base:
${signBase(appBundleId + ".watchkitapp")}
        TARGETED_DEVICE_FAMILY: "4"
`;
  }
  return yml;
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 128 * 1024 * 1024, ...opts });
  return r;
}
function tail(s, n = 30) { return String(s || "").split("\n").slice(-n).join("\n"); }

async function main() {
  if (!BUILD_ID) throw new Error("BUILD_ID required");
  for (const k of ["APPLE_TEAM_ID", "ASC_KEY_ID", "ASC_ISSUER_ID", "ASC_KEY_P8"]) {
    if (!process.env[k]) { await setTF({ tf_status: "error", tf_error: `Missing secret ${k}` }); throw new Error(`Missing ${k}`); }
  }
  const b = await getBuild();
  if (!b) throw new Error("build row not found");
  const source = b.swift || "";
  if (!source) { await setTF({ tf_status: "error", tf_error: "This build has no stored source to ship." }); return; }

  const displayName = (b.label || "Spark App").trim();
  const slug = slugify(displayName);
  const appBundleId = `com.MuhamadKrad.spark.${slug}`;
  const buildNum = Math.floor(Date.now() / 1000); // monotonic → never collides on re-upload

  await note("preparing");
  const { files, capabilities } = parseProject(source);

  // Reconstruct the project dir (same grouping as the sim runner).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparktf-"));
  const groups = { App: [], Widget: [], Watch: [], Shared: [] };
  for (const [name, content] of Object.entries(files)) groups[targetOf(name)].push({ name: baseName(name), content });
  const has = { widget: groups.Widget.length > 0, watch: groups.Watch.length > 0, shared: groups.Shared.length > 0 };
  for (const [t, arr] of Object.entries(groups)) {
    if (!arr.length) continue;
    const tdir = path.join(dir, t); fs.mkdirSync(tdir, { recursive: true });
    for (const f of arr) fs.writeFileSync(path.join(tdir, f.name), f.content);
  }
  fs.writeFileSync(path.join(dir, "project.yml"), signedProjectYml({ displayName, appBundleId, capabilities, has, build: buildNum }));

  // Ensure the App Store Connect app record exists (needed before upload).
  await note("registering app");
  const rec = await ensureAppRecord(appBundleId, displayName);
  if (!rec.ok) { await setTF({ tf_status: "error", tf_error: rec.message }); console.error(rec.message); return; }

  // Generate the Xcode project.
  const XG = process.env.XCODEGEN_BIN || "xcodegen";
  let r = run(XG, ["generate", "--spec", "project.yml"], { cwd: dir });
  if (r.status !== 0) { await setTF({ tf_status: "error", tf_error: "xcodegen: " + tail(r.stderr || r.stdout) }); return; }

  // Stage the ASC key where xcodebuild expects it, for cloud-managed signing + upload.
  const keyDir = path.join(os.homedir(), "private_keys"); fs.mkdirSync(keyDir, { recursive: true });
  const keyPem = ASC_KEY_P8.includes("BEGIN") ? ASC_KEY_P8 : Buffer.from(ASC_KEY_P8, "base64").toString("utf8");
  const keyPath = path.join(keyDir, `AuthKey_${ASC_KEY_ID}.p8`); fs.writeFileSync(keyPath, keyPem);
  const authFlags = ["-authenticationKeyPath", keyPath, "-authenticationKeyID", ASC_KEY_ID, "-authenticationKeyIssuerID", ASC_ISSUER_ID];

  // Archive for device with automatic (cloud-managed) distribution signing.
  await note("archiving");
  const archivePath = path.join(dir, "App.xcarchive");
  r = run("xcodebuild", [
    "-project", "App.xcodeproj", "-scheme", "App", "-configuration", "Release",
    "-destination", "generic/platform=iOS", "-archivePath", archivePath,
    "-allowProvisioningUpdates", ...authFlags,
    `CURRENT_PROJECT_VERSION=${buildNum}`, "clean", "archive",
  ], { cwd: dir });
  if (r.status !== 0) {
    await setTF({ tf_status: "error", tf_error: "archive failed:\n" + tail(`${r.stdout}\n${r.stderr}`, 40) }); return;
  }

  // Export + upload straight to App Store Connect (TestFlight).
  await note("uploading");
  const eo = path.join(dir, "ExportOptions.plist");
  fs.writeFileSync(eo, `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>upload</string>
  <key>teamID</key><string>${APPLE_TEAM_ID}</string>
  <key>signingStyle</key><string>automatic</string>
  <key>uploadSymbols</key><true/>
  <key>manageAppVersionAndBuildNumber</key><true/>
</dict></plist>`);
  r = run("xcodebuild", [
    "-exportArchive", "-archivePath", archivePath, "-exportPath", path.join(dir, "export"),
    "-exportOptionsPlist", eo, "-allowProvisioningUpdates", ...authFlags,
  ], { cwd: dir });
  if (r.status !== 0) {
    await setTF({ tf_status: "error", tf_error: "upload failed:\n" + tail(`${r.stdout}\n${r.stderr}`, 40) }); return;
  }

  await setTF({ tf_status: "processing", tf_bundle_id: appBundleId, tf_build: String(buildNum), tf_error: null });
  console.log(`Uploaded ${appBundleId} build ${buildNum} to TestFlight — Apple is now processing it.`);
  fs.rmSync(dir, { recursive: true, force: true });
}

main().catch(async (e) => { console.error(e); await setTF({ tf_status: "error", tf_error: String(e.message || e).slice(0, 500) }); process.exit(1); });
