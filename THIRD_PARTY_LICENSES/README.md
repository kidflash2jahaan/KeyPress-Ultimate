# Third-party licenses

KeyPress Ultimate itself is MIT (see [LICENSE](../LICENSE)). It also ships code and fonts it didn't write. Four of those carry obligations worth spelling out, and the rest are listed at the end. All of them are permissive: nothing here requires you to open-source anything, and nothing here restricts commercial use.

The versions below are the ones installed in `node_modules` at the time of writing. Each license was read from the copy inside the installed package rather than taken from registry metadata.

## koffi 3.2.1, MIT

Copyright (C) 2026 Niels Martignène. https://github.com/Koromix/koffi

The FFI layer. Every call into CoreGraphics on macOS and `user32.dll` on Windows goes through it, and it's the reason this app has no compile step.

This covers the `koffi` package and the three prebuilt binary packages that ship the actual `koffi.node` for each platform: `@koromix/koffi-darwin-arm64`, `@koromix/koffi-darwin-x64`, and `@koromix/koffi-win32-x64`. All are MIT under the same copyright.

Obligation: include the copyright notice and the MIT permission notice with any distribution of the software. That's the whole of it. No attribution in the interface, no source disclosure, no notifying the author.

Where the text lives: `node_modules/koffi/LICENSE.txt` in the repo, and inside the unpacked `node_modules/koffi` directory in every packaged build, since koffi has to sit outside the asar archive to load its native binary.

## Electron 44.3.0, MIT

Copyright (c) Electron contributors. Copyright (c) 2013-2020 GitHub Inc. https://github.com/electron/electron

The application shell: Chromium for the interface, Node for the main process.

Obligation on Electron's own MIT code: include the copyright notice and the permission notice.

The larger obligation is indirect. Electron bundles Chromium, V8, Node and several hundred of their dependencies, and those carry their own licenses, mostly BSD-3-Clause and Apache-2.0 with a few that require an attribution notice. Electron collects every one of them into a `LICENSES.chromium.html` file that ships beside its binary, and electron-builder carries that file and Electron's own `LICENSE` into the packaged output. Don't strip either one from a build you distribute, and check they're still present after any change to the `files` list in `electron-builder.yml`. Dropping them is the one realistic way to end up out of compliance here.

## React 19.2.8 and React DOM 19.2.8, MIT

Copyright (c) Meta Platforms, Inc. and affiliates. https://github.com/facebook/react

The renderer's UI layer. React DOM pulls in `scheduler` 0.27.0, also MIT under the same copyright.

Obligation: include the copyright notice and the permission notice. React dropped its additional patent grant when it relicensed to plain MIT in 2017, so there's nothing beyond the standard MIT terms to comply with. Meta's trademarks are not licensed by the MIT grant, which matters only if you fork this and call the result React.

The license text sits at `node_modules/react/LICENSE` and `node_modules/react-dom/LICENSE`, and the built renderer bundle inherits the obligation along with the code.

## Geist Sans and Geist Mono, SIL Open Font License 1.1

Copyright (c) 2023 Vercel, in collaboration with basement.studio. https://github.com/vercel/geist-font

The two typefaces in the interface. They're vendored as `Geist-Variable.woff2` and `GeistMono-Variable.woff2` under `src/renderer/assets/fonts/`, with the full license text beside them in `src/renderer/assets/fonts/OFL.txt`.

The OFL is the only license here that isn't MIT, and its obligations differ in kind:

- The font files may be bundled, redistributed and sold as part of this software. That's the point of the OFL, and it's why these fonts were chosen.
- The copyright notice and the license must travel with the font files. `OFL.txt` sits in the same directory as the `.woff2` files for exactly that reason, and it gets packaged with them.
- The fonts can't be sold on their own. Selling KeyPress Ultimate is fine; selling the fonts extracted from it is not.
- Modified versions of the fonts stay under the OFL and can't be released under a different license.
- Geist declares no Reserved Font Name, so a modified version doesn't have to be renamed. Check the copyright line in `OFL.txt` before relying on that if you update the fonts, because a future release could add one.

This is also why Fontshare families like Satoshi, General Sans and Clash Display are banned from this repo: their license permits use but not redistribution, so shipping them inside a public repository or an installer would break it. Any font added here has to be OFL or equivalent.

## The rest of what ships

Two other runtime dependencies end up in the renderer bundle. Both are MIT, with the same obligation as the rest: keep the notice with the code.

- zustand 5.0.15, MIT, copyright (c) 2019 Paul Henschel. State management.
- motion 13.2.0, MIT, copyright (c) 2024 Motion B.V. Animation.

Everything else in `package.json` is a development dependency: TypeScript, Vite, electron-vite, electron-builder, ESLint, vitest and their trees. None of it ends up in a packaged build, so none of it carries a distribution obligation. Their licenses still apply to anyone building from source, and they're all MIT or Apache-2.0.

To regenerate a full dependency-by-dependency report, run `npx license-checker-rseidelsohn --production --summary` in the repo root.
