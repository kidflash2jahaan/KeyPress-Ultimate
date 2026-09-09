#!/usr/bin/env node
/**
 * verify-package.mjs: the post-build gate for the packaged macOS app.
 *
 *   node scripts/verify-package.mjs [path/to/KeyPress Ultimate.app]
 *
 * With no argument it finds the .app under dist/mac-universal (or dist/mac*).
 * Exits 0 only if every check below passes; exits 1 with a report otherwise.
 *
 * Why this exists
 * ---------------
 * Every failure this catches is silent. The build goes green, the dmg mounts,
 * the app installs, and then:
 *
 *   - MISSING x64 KOFFI SLICE. npm installs only the running machine's
 *     @koromix/koffi-<platform>-<arch>, so a universal app built on an Apple
 *     Silicon runner ships with no darwin_x64/koffi.node. It runs perfectly on
 *     the build machine and every arm64 Mac, and dies on the first
 *     koffi.load() on every Intel Mac, after install, with no build signal.
 *
 *   - THIN MAIN BINARY. Same story from the other direction: if the universal
 *     merge silently produced a single-arch executable, Intel Macs cannot launch
 *     it at all.
 *
 *   - BROKEN SIGNATURE. An invalid or absent seal makes macOS report "app is
 *     damaged and can't be opened" and offer only Move to Trash, instead of the
 *     normal one-time "Open Anyway" flow.
 *
 *   - APP SANDBOX. The sandbox makes CGEventPost return success and post
 *     nothing. The app looks alive and holds no keys.
 *
 *   - UNSTABLE DESIGNATED REQUIREMENT. The DR is the identity macOS remembers
 *     when the user grants Accessibility. If it is not anchored to a fixed
 *     bundle identifier, every update is a stranger and the grant is dropped.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const BUNDLE_ID = "com.keypressultimate.app";
const REQUIRED_KOFFI = [
  ["darwin_arm64", "arm64"],
  ["darwin_x64", "x86_64"],
];

const failures = [];
const notes = [];

function fail(check, detail) {
  failures.push({ check, detail });
  process.stdout.write(`  FAIL  ${check}\n        ${String(detail).split("\n").join("\n        ")}\n`);
}
function pass(check, detail = "") {
  process.stdout.write(`  ok    ${check}${detail ? `  (${detail})` : ""}\n`);
}
function note(msg) {
  notes.push(msg);
  process.stdout.write(`  note  ${msg}\n`);
}

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** Runs a command, returning { ok, out } instead of throwing. */
function tryRun(cmd, args) {
  try {
    return { ok: true, out: run(cmd, args) };
  } catch (e) {
    const out = `${e.stdout ?? ""}${e.stderr ?? ""}`.trim() || e.message;
    return { ok: false, out };
  }
}

/** Recursively collect files whose basename matches `name`. */
function findByName(dir, name, hits = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return hits;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) findByName(p, name, hits);
    else if (e.isFile() && e.name === name) hits.push(p);
  }
  return hits;
}

function locateApp(argPath) {
  if (argPath) {
    const p = resolve(argPath);
    if (!existsSync(p)) {
      console.error(`verify-package: no such path: ${p}`);
      process.exit(1);
    }
    return p;
  }
  const dist = resolve("dist");
  if (!existsSync(dist)) {
    console.error("verify-package: dist/ does not exist. Build first, or pass the .app path.");
    process.exit(1);
  }
  const candidates = [];
  for (const entry of readdirSync(dist)) {
    if (!entry.startsWith("mac")) continue;
    const sub = join(dist, entry);
    if (!statSync(sub).isDirectory()) continue;
    for (const inner of readdirSync(sub)) {
      if (inner.endsWith(".app")) candidates.push(join(sub, inner));
    }
  }
  if (candidates.length === 0) {
    console.error("verify-package: found no .app under dist/mac*. Did the mac build run?");
    process.exit(1);
  }
  // Prefer the universal output when several packs are present.
  return candidates.find((c) => c.includes("mac-universal")) ?? candidates[0];
}

// ---------------------------------------------------------------------------
if (process.platform !== "darwin") {
  console.error("verify-package: macOS only (needs lipo, codesign, plutil).");
  process.exit(1);
}

const app = locateApp(process.argv[2]);
process.stdout.write(`\nverify-package: ${app}\n\n`);

// --- 1. both koffi arch slices are present and are the arch they claim ------
const unpacked = join(app, "Contents", "Resources", "app.asar.unpacked");
if (!existsSync(unpacked)) {
  fail("app.asar.unpacked exists", `${unpacked} is missing, so asarUnpack did not run and, koffi cannot be require()d from inside an asar`);
} else {
  const koffiBinaries = findByName(unpacked, "koffi.node");
  if (koffiBinaries.length === 0) {
    fail("koffi.node unpacked", "no koffi.node anywhere under app.asar.unpacked");
  }
  for (const [dirName, expectedArch] of REQUIRED_KOFFI) {
    const hit = koffiBinaries.find((p) => p.includes(`/${dirName}/`));
    if (!hit) {
      fail(
        `${dirName}/koffi.node present`,
        `not found under app.asar.unpacked.\n` +
          `This ships an app that crashes at the first koffi.load() on ${dirName === "darwin_x64" ? "Intel" : "Apple Silicon"} Macs.\n` +
          `Fix: install @koromix/koffi-${dirName.replace("_", "-")} before packaging (see the\n` +
          `"Fetch both macOS koffi prebuilds" step in .github/workflows/release.yml).\n` +
          `Found instead: ${koffiBinaries.map((p) => p.slice(unpacked.length + 1)).join(", ") || "(nothing)"}`,
      );
      continue;
    }
    const lipo = tryRun("lipo", ["-info", hit]);
    if (!lipo.ok) {
      fail(`${dirName}/koffi.node is a Mach-O`, lipo.out);
    } else if (!lipo.out.includes(expectedArch)) {
      fail(`${dirName}/koffi.node is ${expectedArch}`, lipo.out.trim());
    } else {
      pass(`${dirName}/koffi.node is ${expectedArch}`);
    }
  }
}

// --- 2. the main executable is a real fat binary ----------------------------
const macosDir = join(app, "Contents", "MacOS");
if (!existsSync(macosDir)) {
  fail("Contents/MacOS exists", `${macosDir} is missing`);
} else {
  const exes = readdirSync(macosDir);
  if (exes.length !== 1) note(`Contents/MacOS holds ${exes.length} entries: ${exes.join(", ")}`);
  const exePath = join(macosDir, exes[0]);
  const lipo = tryRun("lipo", ["-info", exePath]);
  if (!lipo.ok) {
    fail("lipo -info on the app binary", lipo.out);
  } else {
    const out = lipo.out.trim();
    const hasArm = /\barm64\b/.test(out);
    const hasIntel = /\bx86_64\b/.test(out);
    if (hasArm && hasIntel) pass("app binary is universal (arm64 + x86_64)", basename(exePath));
    else fail("app binary is universal (arm64 + x86_64)", `${out}\nmissing: ${[!hasArm && "arm64", !hasIntel && "x86_64"].filter(Boolean).join(" and ")}`);
  }
}

// --- 3. the signature verifies ----------------------------------------------
// Exit code only. `--verbose=2` prints "valid on disk" to stderr on success, but
// a nested resource failure can print progress lines too, so the text is not a
// safe signal. A non-zero exit is.
const verify = tryRun("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
if (verify.ok) {
  pass("codesign --verify --deep --strict");
} else {
  // --verbose=2 emits a --prepared:/--validated: line per nested bundle. Those
  // are progress, not diagnosis, and they bury the one line that matters.
  const signal = verify.out
    .split("\n")
    .filter((l) => !/^\s*--(prepared|validated):/.test(l))
    .join("\n")
    .trim();
  fail("codesign --verify --deep --strict", signal || verify.out);
}

// --- 4. the designated requirement -----------------------------------------
// The DR is the identity macOS stores against the Accessibility grant. There are
// two legitimate shapes and one bad one:
//
//   certificate-anchored  identifier "com.keypressultimate.app" and
//                         certificate leaf = H"<cert sha1>"
//                         -> stable for the life of the certificate. This is
//                            what a real release looks like.
//   ad-hoc                cdhash H"<arm64 hash>" or cdhash H"<x64 hash>"
//                         -> changes on EVERY build. Legitimate for a local or
//                            unsigned-fallback build, but the grant will not
//                            survive an update. Reported as a note, not a
//                            failure, so that the release workflow's ad-hoc
//                            fallback is never blocked here. (That workflow has
//                            its own hard assert for the signed case.)
//   anything else         -> we do not know what we shipped. Fail.
const dr = tryRun("codesign", ["-d", "-r-", app]);
if (!dr.ok) {
  fail("designated requirement readable", dr.out);
} else {
  // codesign prints "designated =>" on stderr, sometimes prefixed with "# ".
  const line = (dr.out.split("\n").find((l) => l.replace(/^#\s*/, "").startsWith("designated =>")) ?? "").replace(/^#\s*/, "").trim();
  // A self-signed certificate is its own root, so macOS renders its requirement
  // as `certificate root = H"..."`; a chained (Developer ID) certificate renders
  // as `certificate leaf = H"..."`. Both are pinned to a certificate that
  // outlives the build, which is the property that keeps the user's
  // Accessibility grant working across updates. Only a cdhash requirement is
  // per-build, and that is handled below.
  if (/certificate (leaf|root)/.test(line)) {
    if (line.includes(`identifier "${BUNDLE_ID}"`)) {
      pass("designated requirement is stable (certificate-anchored)");
    } else {
      fail(
        "designated requirement is stable (certificate-anchored)",
        `signed with a certificate, but the requirement is not pinned to identifier "${BUNDLE_ID}":\n${line}`,
      );
    }
  } else if (/cdhash/.test(line)) {
    note(
      "AD-HOC SIGNED. The designated requirement is a per-build cdhash:\n" +
        `        ${line}\n` +
        "        macOS will treat the next update as a different program and drop every user's\n" +
        "        Accessibility grant. Fine for a local build; a release needs MAC_CERT_P12.",
    );
  } else {
    fail("designated requirement recognised", `could not classify:\n${line || dr.out.trim()}`);
  }
}

// --- 5. no App Sandbox ------------------------------------------------------
const ents = tryRun("codesign", ["-d", "--entitlements", "-", "--xml", app]);
if (!ents.ok) {
  note(`could not read entitlements (${ents.out.split("\n")[0]})`);
} else if (/com\.apple\.security\.app-sandbox/.test(ents.out)) {
  fail(
    "app is NOT sandboxed",
    "com.apple.security.app-sandbox is set. The sandbox makes CGEventPost succeed and post\n" +
      "nothing. The app would launch, look armed, and hold no keys. Remove it from\n" +
      "build/entitlements.mac.plist.",
  );
} else {
  pass("app is NOT sandboxed");
}

// --- 6. App Nap is disabled -------------------------------------------------
const plistPath = join(app, "Contents", "Info.plist");
if (!existsSync(plistPath)) {
  fail("Info.plist exists", plistPath);
} else {
  const json = tryRun("plutil", ["-convert", "json", "-o", "-", plistPath]);
  if (!json.ok) {
    fail("Info.plist is readable", json.out);
  } else {
    let plist = {};
    try {
      plist = JSON.parse(json.out);
    } catch (e) {
      fail("Info.plist parses", String(e));
    }
    if (plist.CFBundleIdentifier !== BUNDLE_ID) {
      fail("CFBundleIdentifier", `expected ${BUNDLE_ID}, got ${plist.CFBundleIdentifier}`);
    } else {
      pass("CFBundleIdentifier", BUNDLE_ID);
    }
    if (plist.LSAppNapIsDisabled === true) {
      pass("LSAppNapIsDisabled");
    } else {
      fail(
        "LSAppNapIsDisabled",
        `expected true, got ${JSON.stringify(plist.LSAppNapIsDisabled)}. App Nap throttles our\n` +
          "repeat timers to whole seconds once the game is fullscreen and our window is occluded.",
      );
    }
  }
}

// --- 7. the asar itself made it in -----------------------------------------
const asar = join(app, "Contents", "Resources", "app.asar");
if (existsSync(asar) && statSync(asar).size > 0) pass("app.asar present", `${(statSync(asar).size / 1024 / 1024).toFixed(1)} MB`);
else fail("app.asar present", `${asar} missing or empty`);

// ---------------------------------------------------------------------------
process.stdout.write("\n");
if (failures.length > 0) {
  process.stdout.write(`verify-package: FAILED, ${failures.length} check(s):\n`);
  for (const f of failures) process.stdout.write(`  - ${f.check}\n`);
  process.stdout.write("\n");
  process.exit(1);
}
process.stdout.write(`verify-package: OK${notes.length ? ` (${notes.length} note(s) above)` : ""}\n\n`);