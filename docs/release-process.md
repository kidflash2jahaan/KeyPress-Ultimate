# Release process

How a KeyPress Ultimate build gets from a git tag to a signed, downloadable,
self-updating app, and what to do when a step fails.

Two workflows do the work:

- `.github/workflows/ci.yml` runs on every push and pull request. Typecheck,
  lint and the full test suite on macos-latest and windows-latest, Node 20. It
  packages nothing.
- `.github/workflows/release.yml` runs on a `v*` tag. It builds and packages
  both platforms, gates the macOS output through `scripts/verify-package.mjs`,
  and publishes everything to a GitHub Release with a `SHA256SUMS.txt`.

## Cutting a release

```
# 1. bump the version in package.json, commit it
# 2. tag it and push the tag
git tag v1.2.3
git push origin v1.2.3
```

The tag pattern is `v<major>.<minor>.<patch>`, optionally with a prerelease
suffix (`v1.2.3-beta.1`), which marks the GitHub Release as a prerelease
automatically. `workflow_dispatch` also works if you want to rehearse a build
without tagging.

Roughly 15 minutes later the release carries:

| asset | what it is |
| --- | --- |
| `KeyPress-Ultimate-1.2.3-universal.dmg` | macOS first install |
| `KeyPress-Ultimate-1.2.3-universal-mac.zip` | macOS auto-update payload |
| `KeyPress-Ultimate-Setup-1.2.3-x64.exe` | Windows install and auto-update |
| `KeyPress-Ultimate-1.2.3-x64-portable.exe` | Windows, no install |
| `SHA256SUMS.txt` | checked by the in-app updater |

Those names are matched literally by the updater, so if you change
`artifactName` in `electron-builder.yml` you have to change the updater too.

## One-time setup: the signing certificate

This is the only setup step, and a release works without it (badly, see below).

```
scripts/make-selfsigned-cert.sh --out ~/keypress-signing.p12 --repo <owner>/<repo>
```

The script mints a 20-year self-signed code-signing certificate with openssl and
prints the two `gh secret set` commands that store it as `MAC_CERT_P12` (the
base64 of the .p12) and `MAC_CERT_PASSWORD`. Run those two commands and you are
done.

The script never runs on its own. Nothing in CI calls it, it refuses to run
when `$CI` is set, it refuses to run without an explicit `--out`, it refuses to
write inside this repository, and it never touches your keychain or your trust
store. Back up the .p12 somewhere safe.

### Why bother, if it is not notarized

It is not notarized and it is not an Apple Developer ID, so Gatekeeper still
blocks the first launch and the user still has to press Open Anyway once.
The certificate buys exactly one thing: a stable **designated requirement**.

When a user grants Accessibility to KeyPress Ultimate, macOS stores the app's
designated requirement in the TCC database. On every later launch the grant
applies only if the app still satisfies it.

```
ad-hoc signed     designated => cdhash H"<hash of this exact build>"
                                or cdhash H"<the other arch's hash>"

certificate       designated => identifier "com.keypressultimate.app"
                                and certificate leaf = H"<cert fingerprint>"
```

An ad-hoc cdhash changes on every single build. Every update would look like a
different program, the Accessibility grant would be dropped, and the app would
go quiet until the user re-approved it in System Settings. Pinning to a
certificate we control makes the requirement stable for the life of that
certificate, so updates keep working.

**Rotating the certificate resets everyone's grant.** A new certificate is a new
designated requirement. If you ever have to rotate, say so loudly in the release
notes and expect support traffic.

### What CI does with it, and the trap in the middle

The `Set up macOS code signing` step decodes the secret, creates a keychain
inside `$RUNNER_TEMP`, imports the .p12, and then does the non-obvious part:

```
sudo security add-trusted-cert -d -r trustRoot -p codeSign \
  -k /Library/Keychains/System.keychain cert.pem
```

Importing the .p12 is not enough. A self-signed certificate is untrusted, and
codesign refuses an untrusted identity outright. Verified locally on macOS 26.6:
with the key sitting in the keychain but no trust setting,
`security find-identity -v -p codesigning <keychain>` reports `0 valid
identities found` and `codesign -s "<name>"` fails with `no identity found`.
`security find-identity` without `-v` shows the certificate and the reason,
`CSSMERR_TP_NOT_TRUSTED`.

Trusting a code-signing root is a real change to a machine's security posture,
which is why this only ever happens on a throwaway CI runner. Do not do it on
your laptop to "test" the certificate.

A later step tears the keychain down and restores the runner's original keychain
search list, and it runs with `if: always()` so a failed build still cleans up.

### If the secret is missing or broken

Every failure in that step is non-fatal. It emits a `::warning::` and leaves
`SIGN_IDENTITY` unset, and the package step falls back to the ad-hoc identity
that `electron-builder.yml` already carries as its default. A release is never
blocked on a certificate. You get a valid, installable, self-consistent build
whose only defect is that the next update will reset Accessibility grants.

You will see it three ways: the workflow annotation, a `note` line from
`verify-package` saying `AD-HOC SIGNED`, and the absence of the
`Assert the release is certificate-signed` step.

When the certificate *is* present, that assert step is a hard gate: if signing
somehow degraded to a cdhash requirement anyway, the release fails rather than
shipping something that quietly breaks grants.

## The koffi trap

This is the failure the whole verification apparatus exists for.

koffi ships its native binary as a separate package per platform and
architecture (`@koromix/koffi-darwin-arm64`, `@koromix/koffi-darwin-x64`,
`@koromix/koffi-win32-x64`), each pinned with `"os"` and `"cpu"` in its
package.json. npm therefore installs only the running machine's copy. Build a
universal macOS app on an Apple Silicon runner and you get an app with no
`darwin_x64/koffi.node` in it. It builds green. The dmg mounts. It installs. It
runs perfectly on every Apple Silicon Mac. On an Intel Mac it dies at the first
`koffi.load()`, after install, with nothing in the build log.

Three things stop that:

1. `.npmrc` sets `force=true`, which is what lets npm install all three packages
   despite `EBADPLATFORM`. Without it, `npm ci` hard-fails with
   `wanted {os:darwin,cpu:x64} current {os:darwin,cpu:arm64}`.
2. The `Ensure both macOS koffi prebuilds are present` step re-injects any
   missing package by unpacking the registry tarball straight into
   `node_modules`. electron-builder still finds it, because koffi declares it as
   an optionalDependency and it is part of the resolved tree.
3. `scripts/verify-package.mjs` fails the build if either slice is missing from
   the packaged app.

`npm ci --cpu=x64` is not an alternative: koffi's install script (cnoke) then
tries to compile from source and fails.

**Ordering matters.** The re-injection step has to run after every npm command
that writes `node_modules`. `npm ci` and `npm install` re-reconcile the tree
against the lockfile and prune a hand-unpacked package straight back out.
`npm pack` only downloads a tarball and `npm run` does not touch
`node_modules`, so the current order is safe. If you add an install step, move
the re-injection after it.

The other half of the same problem is `mac.x64ArchFiles: "**/koffi.node"`.
`@electron/universal` refuses to merge a Mach-O file that is byte-identical in
the x64 and arm64 packs because it cannot tell which arch it belongs to, and
both koffi binaries are present in both packs. The whitelist keeps each
single-arch binary as-is; koffi picks the right one at runtime from
`process.arch`.

## The package gate

```
node scripts/verify-package.mjs            # finds dist/mac-universal/*.app
node scripts/verify-package.mjs path/to/KeyPress\ Ultimate.app
```

macOS only. Exits non-zero if any of these fail:

| check | what breaks if it is wrong |
| --- | --- |
| `darwin_arm64/koffi.node` present and arm64 | crash on the first `koffi.load()` on Apple Silicon |
| `darwin_x64/koffi.node` present and x86_64 | same, on every Intel Mac, after install |
| `lipo -info` on the app binary shows arm64 and x86_64 | Intel Macs cannot launch it at all |
| `codesign --verify --deep --strict` | macOS says "app is damaged", offers only Move to Trash |
| designated requirement is recognised | you do not know what you shipped |
| no `com.apple.security.app-sandbox` | `CGEventPost` returns success and posts nothing |
| `CFBundleIdentifier` is `com.keypressultimate.app` | the DR, and therefore the Accessibility grant, is not what you think |
| `LSAppNapIsDisabled` is true | repeat timers drift from 33ms to whole seconds behind a fullscreen game |
| `app.asar` present and non-empty | no app |

The sandbox check deserves its own sentence, because it is the one with no
diagnostic at runtime. Under the App Sandbox, `CGEventPost` returns without
error and no event reaches the window server. The app launches, the UI says
armed, the timers run, and not one key is held. Never add
`com.apple.security.app-sandbox` to `build/entitlements.mac.plist`.

The ad-hoc case is reported as a note, not a failure, so the graceful fallback
above still passes the gate.

## Verifying a build locally

```
npm run build
npx electron-builder --mac --dir --universal
node scripts/verify-package.mjs
```

`--dir` alone builds only the host architecture, which will not exercise the
universal merge or the koffi whitelist, so pass `--universal` too. Expect the
`AD-HOC SIGNED` note: locally there is no certificate and that is correct.

To build the real artifacts (slower, produces the dmg and zip):

```
npx electron-builder --mac
```

## Windows

Not signed at all. There is no Authenticode certificate, so SmartScreen shows
"Windows protected your PC" on first run and the user clicks More info, then
Run anyway. That prompt goes away once the binary accumulates reputation, which
a self-signed certificate would not help with anyway.

The NSIS installer is `oneClick: false` with `perMachine: false` and
`allowElevation: false`. That combination installs under
`%LOCALAPPDATA%\Programs` with no UAC prompt at any point, which is what lets
the updater later run `installer.exe /S --force-run` silently. An assisted
installer still honours `/S` and reuses the recorded install directory.

Windows on ARM is deliberately not built. It runs x64 processes under emulation,
`SendInput` and `GetForegroundWindow` work normally there, and building it would
need the same cross-architecture koffi dance as macOS for no real gain.

## Pinned action versions

All majors verified current on 2026-09-09:

| action | current release |
| --- | --- |
| `actions/checkout@v7` | v7.0.1 |
| `actions/setup-node@v7` | v7.0.0 |
| `actions/upload-artifact@v7` | v7.0.1 |
| `actions/download-artifact@v8` | v8.0.1 |
| `softprops/action-gh-release@v3` | v3.0.3 |

Pinned to majors, so security patches land automatically but a breaking major
never does.

## What is deliberately not here

- **No `publish:` block in `electron-builder.yml`.** The release job uploads
  assets itself and the in-app updater reads the GitHub Releases API directly,
  so electron-builder never needs a `GH_TOKEN` and never generates `latest.yml`
  or `latest-mac.yml`.
- **No notarization.** It needs a paid Apple Developer account. `notarize` is
  left unset and the workflow logs `skipped macOS notarization`, which is
  expected, not a warning to chase.
- **No hardened runtime.** It is only enforced for notarized apps, and combined
  with a non-Apple signature it enables library validation, which rejects the
  Apple-signed Electron framework.
- **No ubuntu job.** We do not ship a Linux build.
