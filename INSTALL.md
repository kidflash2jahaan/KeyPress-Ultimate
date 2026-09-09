# Installing KeyPress Ultimate

KeyPress Ultimate isn't code-signed by Apple or Microsoft. Signing costs $99 a year for Apple and a few hundred a year for a Windows certificate, and this is a free app, so both operating systems will warn you the first time you open it. The warnings mean "we don't know who made this", not "we found something bad".

You only have to do this once per machine. Updates installed from inside the app don't trigger any of it again.

Every release ships a `SHA256SUMS.txt` file. If you want to confirm you got the same bytes we built, see [Verifying your download](#verifying-your-download).

## macOS, Apple Silicon and Intel

The `.dmg` is a universal build, so one download works on both M-series and Intel Macs. It needs macOS 13 or later.

### 1. Install it

1. Download `KeyPress-Ultimate-<version>-universal.dmg` from the [Releases page](../../releases/latest).
2. Open the `.dmg` and drag **KeyPress Ultimate** into your **Applications** folder.
3. Eject the disk image.

Do step 2 before you try to open the app. If you launch it straight out of the Downloads folder, macOS runs it from a hidden read-only copy, a mechanism called App Translocation, and the app won't be able to update itself later.

### 2. Get past Gatekeeper

Open KeyPress Ultimate from Applications. On macOS 15 (Sequoia) and macOS 26 (Tahoe) you'll get a dialog like this:

> **"KeyPress Ultimate" Not Opened**
>
> Apple could not verify "KeyPress Ultimate" is free of malware that may harm your Mac or compromise your privacy.
>
> [Move to Trash] [Done]

Click **Done**. Then:

1. Open **System Settings**.
2. Go to **Privacy & Security**.
3. Scroll down to the **Security** section. You'll see "KeyPress Ultimate was blocked to protect your Mac."
4. Click **Open Anyway**.
5. Authenticate with Touch ID or your password.
6. A final confirmation appears. Click **Open Anyway** again.

The app opens and macOS remembers the decision. Every launch after this is normal.

Control-clicking the app and choosing Open no longer works. Apple removed that shortcut in macOS 15, so the System Settings route above is the only supported way now. Older guides on the web still tell you to Control-click, and following them on macOS 15 or 26 gets you the same refusal dialog you started with.

### Terminal alternative

If you'd rather run one command than click through System Settings, strip the quarantine flag your browser attached to the download:

```sh
xattr -dr com.apple.quarantine "/Applications/KeyPress Ultimate.app"
```

Then open the app normally. Nothing else needs to change, and you should not run `sudo spctl --master-disable`. That turns Gatekeeper off for every app on your Mac, which is a far bigger change than you need.

### 3. Grant Accessibility permission

KeyPress Ultimate holds down keys and mouse buttons for you, and macOS only lets an app do that with explicit permission. The app prompts you on first use. If it doesn't, or you dismissed the prompt:

1. Open **System Settings** > **Privacy & Security** > **Accessibility**.
2. Turn on **KeyPress Ultimate**.

macOS shows that prompt once per app identity, so if you clicked Deny it won't come back. The in-app permission screen has a button that deep-links straight to the Accessibility list. If KeyPress Ultimate isn't in the list at all, click the **+** button and pick it from your Applications folder.

Accessibility is the only permission the app asks for. It never requests Input Monitoring, and it can't read what you type: the permission is what lets it write events, and writing events is all it uses it for.

### Re-granting after an update

After an in-app update you may have to turn that switch off and back on. That's a side effect of the app not having a paid Apple signing certificate: macOS identifies the app by a fingerprint that changes with every build, so it treats the updated app as a new one. The app tells you when this has happened rather than sitting there looking broken.

### If you see "is damaged and can't be opened"

That's a different message from the one above, and it means the app bundle itself is broken, not only unverified. Almost always the cause is a partial download, or unpacking the `.zip` with a tool that mangled it. Delete the app, download the `.dmg` again, and check the SHA-256 before installing.

## Windows 10 and 11, 64-bit

### 1. Download

Grab `KeyPress-Ultimate-Setup-<version>-x64.exe` from the [Releases page](../../releases/latest).

Edge and Chrome may block the download itself with a message like "KeyPress-Ultimate-Setup.exe isn't commonly downloaded. Make sure you trust it before you open it." Click the three-dot menu next to the download, choose **Keep**, then **Show more** > **Keep anyway**.

### 2. Get past SmartScreen

Run the installer. Windows shows:

> **Windows protected your PC**
>
> Microsoft Defender SmartScreen prevented an unrecognized app from starting. Running this app might put your PC at risk.
>
> [Don't run]

Click **More info**, then **Run anyway**.

The installer is per-user. It installs to `%LOCALAPPDATA%\Programs\keypress-ultimate` and never asks for administrator rights, so there's no UAC prompt. Uninstall from Settings > Apps like any other program.

SmartScreen stops warning about a given file once enough people have downloaded and run it, so this may disappear on its own for later releases. Until then it comes back on the first download of each new version.

Windows asks for no permission of any kind. There's nothing to grant.

### Portable build

If you'd rather not install anything, download `KeyPress-Ultimate-<version>-x64-portable.exe` instead. It runs from wherever you put it and writes nothing to Program Files. SmartScreen behaves the same way.

The portable build can't update itself, since there's no installer to run. It tells you when a new version is out and links you to the download.

### Windows on ARM

There's no native ARM64 build. The x64 build runs under Windows' x64 emulation on ARM machines, and the key and mouse synthesis works there the same as on an x64 machine.

### If a game ignores the keys on Windows

If the game is running as administrator and KeyPress Ultimate isn't, Windows blocks the input and reports success anyway. The app detects the case and says "<game> is running as administrator, restart KeyPress Ultimate as administrator". Do that, or start the game without elevation.

A few games read virtual keys rather than the scancodes the app sends by default. Settings has a "Send virtual keys instead of scancodes" switch for those. Turn it on only if a game ignores the app entirely, and turn it back off if it makes no difference.

## Verifying your download

Each release includes `SHA256SUMS.txt`. Download it next to your installer, then run one of these.

macOS:

```sh
cd ~/Downloads
shasum -a 256 -c SHA256SUMS.txt --ignore-missing
```

Windows PowerShell:

```powershell
cd $HOME\Downloads
Get-FileHash .\KeyPress-Ultimate-Setup-*.exe -Algorithm SHA256
# compare the Hash column against the matching line in SHA256SUMS.txt
```

The in-app updater runs this check on every update, and refuses to install anything whose hash doesn't match what GitHub published.

## Updates

KeyPress Ultimate checks GitHub Releases when it starts, and you can check manually from the app. When there's a new version you get the release notes and a download progress bar in the app.

- On macOS the update replaces the app bundle in place and relaunches. Because the app downloads the update itself, the file never picks up a quarantine flag, so Gatekeeper doesn't reappear.
- On Windows the update runs the new installer silently and relaunches. There's no SmartScreen prompt, because the app launches the installer rather than Explorer.

If the app can't write to its own location, for example it's installed in `/Applications` and you're on a standard non-admin account, it says so and sends you to the Releases page to install manually. The same thing happens if it finds itself running from `/AppTranslocation/`, which means it was launched from the Downloads folder rather than Applications.
