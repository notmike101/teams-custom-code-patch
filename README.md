# Teams Custom Code Patch

A Windows companion for **native Microsoft Teams (MSIX / WebView2)**. It loads your local CSS themes and trusted JavaScript plugins without editing Teams binaries, its profile, the registry, or global environment variables. This is not BetterDiscord compatibility, an Electron patch, or a supported Microsoft extension API.

## Download and run on Windows

Use the [GitHub releases page](https://github.com/notmike101/teams-custom-code-patch/releases) for a published, manually tested release. Download `SHA256SUMS` and either:

- **Installer:** `TeamsCustom-<version>-windows-x64-setup.exe`. Installs for the current user under `%LOCALAPPDATA%\Programs\TeamsCustom`, with a Start Menu shortcut and a Windows uninstall entry. No administrator access, developer Node/npm installation, or terminal is required.
- **Portable:** `TeamsCustom-<version>-windows-x64-portable.zip`. Extract the entire ZIP to a writable folder, keeping `TeamsCustom.exe`, `runtime`, `app`, and `licenses` together; double-click `TeamsCustom.exe`. Moving that folder does not move your user data.

The Windows x64 package requires Windows 10 version 1809 or later, .NET Framework 4.8 (or a compatible later framework), and installed native Teams. These are packaging prerequisites, not a claim that every Windows/Teams version or deployment policy has been tested. WebView2 must permit remote debugging; the companion does not change security policy or elevate privileges.

**These binaries are unsigned.** Windows or SmartScreen may show an unknown-publisher/reputation warning. Checksums detect different bytes, but do not establish publisher identity or make plugins safe. Review the source, release provenance and your organization's policy; if Windows or another security provider blocks execution, stop and follow its review process rather than bypassing the protection.

Compare the downloaded file's SHA256 with its exact filename in `SHA256SUMS` before running or extracting it. An optional PowerShell check is:

```powershell
Get-FileHash -Algorithm SHA256 -LiteralPath .\TeamsCustom-1.0.0-windows-x64-setup.exe
Get-FileHash -Algorithm SHA256 -LiteralPath .\TeamsCustom-1.0.0-windows-x64-portable.zip
```

Use the filenames for the version you downloaded; the manifest has one setup and one portable entry. GitHub Actions artifacts are **build candidates**, not published releases or proof of live Teams testing. If no tested release is available, see [Developer setup and packaging](#developer-setup-and-packaging).

### Launcher controls

1. Before **every new Launch Teams or safe-mode session**, including relaunching after **Stop Customization** or **Exit** and switching modes, finish any calls, use **Teams tray menu → Quit**, and **wait until Teams has fully exited** before launching. Closing its window is not quitting. The companion never force-terminates Teams or interferes with calls.
2. Open **Teams Custom** from Start or run the portable `TeamsCustom.exe`, then choose **Launch Teams**. It starts the bundled private Node runtime without a console and chooses a verified loopback debugging port.
3. Use the **Teams Custom** button inside Teams to enable trusted local themes/plugins. Nothing is enabled by default. **Reload local files** rescans immediately and retries failed plugins; errors appear in the panel and launcher logs. Closing the panel does not disable extensions.
4. **Launch in safe mode** keeps the inventory/panel but loads no user CSS or JavaScript. Stop the current companion first, then follow step 1 before launching in the new mode; toggles in safe mode affect the next normal run.

**Closing the launcher window hides it to the tray; it does not stop customization.** Double-click the tray icon or use **Show Teams Custom** to reopen it. **Stop Customization** gracefully removes reachable customization without quitting Teams. **Exit** requests the same cleanup, waits for the companion, then exits the launcher. Neither guarantees debugger closure; normal Teams tray **Quit**, followed by waiting for Teams to fully exit, closes the debugger. The tray also provides Stop and Exit. A startup error remains visible and can be retried; **View logs** shows recent output and opens the log folder. Only one GUI launcher runs in a Windows session.

Before installing an upgrade or uninstalling, choose launcher **Exit**, not window close, and wait for it to finish. Setup/uninstall blocks replacement while the launcher is running and never closes or restarts Teams. Upgrade and normal/silent uninstall preserve `%APPDATA%\TeamsCustom`; uninstall does not offer automatic data deletion. Review and remove that folder yourself only if you want to discard its contents. Portable users also need to exit the launcher before replacing or deleting its files. There is no automatic updater.

## Local files and configuration

Default data directory: `%APPDATA%\TeamsCustom`. On first startup it creates:

```text
TeamsCustom/
  config.json
  themes/       # direct-child .css files
  plugins/      # direct-child .js files
  companion.lock
  logs/
    launcher.log
    launcher.log.1  # previous bounded log, when rotated
```

**Open extensions / data** opens this folder. Add your trusted `.css` files to `themes` and `.js` files to `plugins`, then enable them in the Teams panel. GUI logs live in `%APPDATA%\TeamsCustom\logs`; each current/previous launcher log is bounded to 1 MiB, and the viewer shows up to the latest 200 KiB of the current log. Logs may contain local filenames and error details; review them before sharing.

For isolated GUI data, launch from PowerShell with an explicit directory:

```powershell
.\TeamsCustom.exe --data-dir "$env:TEMP\TeamsCustomDemo"
```

That changes configuration, extensions, lock and log paths, not the bundled program files. The default remains `%APPDATA%\TeamsCustom`, including for the portable ZIP.

`config.json` is UTF-8 JSON (a Windows UTF-8 BOM is accepted). Defaults enable nothing:

```json
{
  "themes": [],
  "plugins": []
}
```

Each list contains filenames, not paths. Either list can be omitted and defaults to empty. Duplicates are removed; unrelated keys are ignored, but `__proto__`, `constructor`, and `prototype` keys are rejected. Invalid JSON/types/filenames disable **all** user extensions and show an error; repair the file manually before using panel toggles. Missing enabled files produce isolated errors. Safe mode keeps the inventory and panel, but loads **no user CSS or JS**; toggles change the configuration for the next normal run.

Only regular direct-child files with the appropriate, case-sensitive `.css` / `.js` suffix are accepted. No subdirectories, symlinks/junctions, absolute/drive/UNC paths, separators, alternate data streams, Windows-invalid characters/device names, or trailing spaces/dots. Files are applied in deterministic filename order. Disabled sources are not read or sent to Teams. Panel writes validate the current file/config, serialize across all attached pages, and replace the config atomically; do not edit it concurrently with a panel write (last writer wins).

### Try a local theme and plugin

These commands create files but do not enable them. Start the companion once first, or create the directories:

```powershell
$data = "$env:APPDATA\TeamsCustom"
New-Item -ItemType Directory -Force "$data\themes", "$data\plugins" | Out-Null
'body { --teams-custom-demo-color: #aab4ff; }' | Set-Content -Encoding utf8 "$data\themes\demo.css"
@'
let badge;
return {
  start(api) {
    badge = document.createElement('div');
    badge.id = 'teams-custom-demo-badge';
    badge.textContent = `Local plugin: ${api.id}`;
    badge.style.cssText = 'position:fixed;left:16px;bottom:16px;z-index:2147483646;background:#242424;color:white;padding:8px;border:2px solid #aab4ff;border-radius:6px';
    document.body.append(badge);
    window.addEventListener('resize', () => {
      if (badge) badge.title = `Viewport ${window.innerWidth}px`;
    }, { signal: api.signal });
  },
  stop() {
    badge?.remove();
    badge = undefined;
  }
};
'@ | Set-Content -Encoding utf8 "$data\plugins\demo.js"
```

Enable `demo.css` and `demo.js` in the panel, or save:

```json
{
  "themes": ["demo.css"],
  "plugins": ["demo.js"]
}
```

A plugin file is a **function body**, not an ES module: it must return `{ start(api), stop() }`. Both methods are required and may return promises. `api.id` / `api.name` is the filename; `api.signal` is an AbortSignal. The signal is aborted **before** `stop()` on disable, replacement, failed start, or shutdown. Use it for supported event listeners/fetches, and explicitly remove your DOM, timers, observers, and patches in `stop()`. There is no `require`, import loader, Node bridge, or filesystem/process API in the page.

Each file's factory is compiled independently before injection: a syntax error does not block healthy plugins. Unchanged revisions do not restart. A replacement stops the old plugin before starting the new one; a broken replacement remains stopped with an error rather than silently reverting. Start/stop promises are bounded to **3 seconds per operation**. Timeouts abort the signal and attempt cleanup; subsequent operations are not held indefinitely by an unresolved promise. JavaScript running synchronously in the Teams renderer cannot be preempted, and a promise that later performs side effects cannot be forcibly cancelled. Plugins must cooperate with their signal and clean up their own effects.

## Hot reload and targets

The companion performs a serialized scan every **1.5 seconds after the previous scan finishes**. It hashes enabled file contents, so same-size edits and unchanged timestamps are detected. Slow protocol/lifecycle work can increase that interval. There are no filesystem watchers or build steps.

The runtime bootstrap runs at document start, and the panel waits for `DOMContentLoaded` when needed. The host defers styles and plugin snapshots until an eligible document has a body; the next periodic scan retries even if local files are unchanged. Body availability does not guarantee that Teams has finished rendering its application UI.

Eligible top-level page origins are exactly:

- `https://teams.live.com`
- `https://teams.microsoft.com`
- `https://teams.cloud.microsoft`

Sign-in pages, subframes, workers, and other origins are not activated. The actual document origin is rechecked before application and panel actions. Inspector-owned CSS sheets apply local theme text and panel styling without remote fetching or a global CSP bypass. SPA navigation keeps the runtime; full reloads recreate it. New eligible page targets are discovered (including pop-outs when Teams exposes them); disconnected debugger sessions are retried only after listener ownership is revalidated. On socket-only reconnect, the same companion recovers its sheets by a unique ownership comment in their text, reuses a current-document sheet, and blanks any duplicate owned declarations. Unchanged plugins remain running; unrelated or unmarked inspector sheets are never cleared.

On the tested Teams build, a raw CDP `Page.reload` hides the main window and leaves its old target with an empty document. Open Teams from its tray icon to let the native host recreate the window; the companion discovers the replacement target and reapplies extensions. The loader does not fabricate a document or restart Teams to work around this native behavior. **Reload local files** only refreshes extensions; it does not reload Teams.

## Security and rollback limits

**The debugger is accessible to other local processes and remains enabled until Teams quits.** Treat the machine and every enabled plugin as trusted. This is not a sandbox: plugins execute with the page's privileges and can read/modify visible Teams data, use existing session/network capabilities within browser policy, or break Teams. The panel's bounded binding only accepts validated file toggles/reload actions; it does not expose arbitrary filesystem/process operations. That does not make arbitrary JavaScript safe.

Choose **Stop Customization** or launcher **Exit** (or **Ctrl+C** in the developer companion terminal) to stop. Where targets remain accessible, shutdown removes the future-document bootstrap, aborts/stops plugins, removes the owned panel, and blanks all recovered owned inspector sheets. It does not stop Teams or remove its debugging port. Plugin cleanup failures are reported; arbitrary account/network changes or uncooperative JS effects are not reversible. Renderer crashes, closed targets, forced launcher/terminal termination, and power loss can prevent cleanup.

For a clean rollback:

1. Stop customization with the launcher and wait for cleanup, or use Ctrl+C for the developer CLI.
2. Finish any calls, use Teams tray menu **Quit**, and wait until Teams has fully exited so its debugger closes. Closing the Teams window is not enough.
3. Launch Teams normally from Start, not through the companion. The process-local debugger environment is not present, and no extensions are injected.
4. Optionally remove your TeamsCustom directory after reviewing its contents.

Only one companion may use a data directory. After an abnormal exit, a stale `companion.lock` may remain. Read its PID with `Get-Content "$env:APPDATA\TeamsCustom\companion.lock"`, verify in Task Manager that this companion is no longer running, then remove **only that lock file** and restart. Never remove a live companion's lock. Use one companion per Teams instance: a second companion using a different data directory reports a page-owner conflict instead of applying its styles over another companion's runtime. Stop the original companion first; if it exited abnormally, Quit Teams and relaunch before attaching. There is no automatic takeover of stale runtimes or cleanup of unmarked sheets from older loader versions.

This loader depends on Teams/WebView2 internals and may stop working after updates. It does not promise compatibility with every account, deployment policy, or window type. The original remote stylesheet injector and axios dependency have been removed.

## Developer setup and packaging

Developer tooling is separate from the end-user package. Source CLI/lint metadata permits Node.js **22.13 or newer within 22.x, or 24+**; use the pinned **24.21.0** for Windows distribution work. You need npm and network access for locked dependencies and pinned official downloads.

```powershell
npm ci
node index.js
node index.js --port 49327
node index.js --attach --port 49327
node index.js --data-dir "$env:TEMP\TeamsCustomDemo" --port 49327
node index.js --attach --port 49327 --data-dir "$env:TEMP\TeamsCustomDemo" --safe-mode
```

Launcher CLI mode starts `%LOCALAPPDATA%\Microsoft\WindowsApps\ms-teams.exe`, passing debugger arguments only through that child's environment, and prints the selected port. Keep the terminal running. Attach mode requires Teams already launched with a loopback debugger; an ordinary running Teams cannot be retrofitted. An occupied port is accepted only after verifying a loopback-only `msedgewebview2.exe` listener hosted by and descended from `ms-teams.exe`; unrelated listeners are refused.

The GUI uses the CLI's `--managed` protocol: version-1 JSON status lines on stdout, ordinary logs on stderr, and a bounded stdin `stop` command or parent-pipe EOF for graceful cleanup. Ordinary CLI behavior is unchanged. On Windows, managed redirected output uses **private Node stream internals** to avoid blocking pipe writes. This is a deliberate compatibility ceiling: the package pins Node **24.21.0**; the broad source `engines` range is not evidence that other Node versions work for managed output. Run the actual Windows managed-pipe regressions and GUI/EOF smoke verification before changing that pin.

### Build setup and portable assets

Build on a Windows x64 host with **PowerShell 7+**, the .NET Framework x64 C# compiler at `%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe`, and **Inno Setup 7.1.0**. Framework 4.8 is required at runtime. The script verifies pinned official Node downloads and installs only the locked production `ws` dependency in an isolated staging tree; upstream Node/ws licenses ship in `licenses`. No npm, tests, development dependencies or build tools enter the end-user payload.

```powershell
# Existing compiler at .tools/inno/ISCC.exe:
npm run build:windows

# Or supply an existing Inno 7.1.0 compiler:
pwsh -NoProfile -File .\scripts\build-windows.ps1 -InnoCompiler 'C:\path to Inno Setup 7\ISCC.exe'

# Explicitly provision pinned Inno 7.1.0 per-user into .tools/inno:
npm run build:windows -- -ProvisionInno
```

`-ProvisionInno` is an explicit compiler-install choice, retains the upstream license, and checks the official installer hash and Authenticode signer. Do not combine it with `-InnoCompiler`; compiler provenance for a supplied existing path is your responsibility. There is no implicit compiler installation, Framework installation, elevation or reboot. Build only once at a time per checkout.

For package version `1.0.0`, the outputs are `dist/TeamsCustom-1.0.0-windows-x64-setup.exe`, `dist/TeamsCustom-1.0.0-windows-x64-portable.zip` and `dist/SHA256SUMS`. Names track the validated three-component package version. Setup and ZIP consume the same `build/windows-distribution/payload`; the ZIP puts its contents at the root. Generated `build`, `dist` and `.tools` files are ignored, not source assets.

### CI candidates and exact verified draft promotion

[Windows build](.github/workflows/windows-build.yml) runs on `windows-2025` for master pushes, `v*` tag pushes, pull requests and manual dispatches. It uses Node 24.21.0, `npm ci`, lint, tests and `build-windows.ps1 -ProvisionInno`, then uploads **only** the versioned setup/portable files and `SHA256SUMS` as `teams-custom-windows-x64` (30-day retention). Its repository token is read-only and checkout does not retain credentials. Actions are pinned to official commit revisions.

Promotion is deliberately separate from building:

1. Choose a successful **push or manual** Windows build run in this repository at the commit intended for release. Create an existing immutable `v<package-version>` tag pointing to that commit using your normal reviewed release process. Do not move the tag.
2. Download **that exact run's** `teams-custom-windows-x64` artifact, check both files against its `SHA256SUMS`, and test those downloaded bytes—not a local rebuild or another run. Record the run ID, tag/commit, both tested file hashes, environment and observed QA results.
3. Perform manual QA on the actual setup and portable package: stripped developer Node/npm PATH with isolated data, GUI launch/status/error retry, tray hide/show and graceful Exit, live Teams CSS/JS and safe mode, Stop and parent EOF cleanup, relocation including spaces/non-ASCII, per-user setup/Start Menu, running-launcher upgrade/uninstall blocking, successful upgrade/normal and silent uninstall after Exit, and data/config/extension preservation. Observe cleanup and ordinary Teams launch after normal tray Quit; do not force termination or bypass provider protections.
4. Dispatch [Verified draft release](.github/workflows/verified-draft-release.yml) with the existing tag, build run ID, **verified** confirmation, and the tested setup/portable SHA256 values. This human attestation must describe completed QA, not an intention to test later.
5. Review the resulting draft, its exact assets/hashes, manual QA evidence and limitations before any separate, explicitly approved publication. If artifact retention expires or any tested file changes, select and test another exact candidate; the promotion workflow never rebuilds binaries.

The promotion job alone has `contents: write`, plus `actions: read` for retrieval. It validates strict input formats, the source repository, existing tag object/commit and checked-out version, expected build workflow, successful non-PR event, exact head SHA, one unexpired named artifact, precisely three allowed files, canonical two-file manifest and both human-tested hashes. It rechecks tag stability and refuses an existing draft or published release. It runs no checked-out source/build code; `gh release create --draft --verify-tag` promotes the downloaded bytes without creating a tag or publishing. A failed upload can leave a partial draft; inspect it before retrying, because existing releases are never overwritten.

### Checks and verification limits

```powershell
npm ci
npm run lint
npm test
```

Focused Node checks cover filename/config trust boundaries (including every U+0000–U+001F control character), snapshots/revisions, independent factory compilation, lifecycle abort/stop/timeout behavior (including null/undefined rejection values, explicit retry, and independent-plugin concurrency), runtime owner conflicts, inspector sheet text ownership/recovery/cleanup (including headers added during recovery), listener ownership, and CDP errors/timeouts/disconnections over a real local WebSocket server. Sheet ownership checks model the CDP boundary; native UI behavior, socket-surviving stylesheet recovery, and rollback require testing against installed Teams and are not claimed by these checks.

Earlier **source-companion** native smoke verification used MSTeams **26246.1604.5133.838** / WebView2 **154.0.4258.53**: process-local launch and verified attach, visible local CSS/JS, hot edits with abort/stop/start, failed-plugin isolation and explicit retry, panel toggles synchronized across two targets, SPA navigation, replacement-target discovery after raw reload/tray reopening, stylesheet recovery across separate CDP sockets, safe mode, shutdown cleanup, and ordinary launch without a debugger after tray Quit. Shutdown exercised the actual SIGINT handler through a temporary stdin driver; physical console Ctrl+C was not automated. This is not packaged-launcher/installer proof. Pop-out window types and other Teams deployments were not independently exercised.

Current **local distribution** verification includes a successful Windows package build, lint with zero warnings/errors, 37 passing Node tests, checksum validation, exact 31-file portable/staging and installed/staging name-and-hash parity, pinned private runtime/production dependency and license checks, and generated-output preservation. Both portable and installed GUI launch reached RUNNING with two live Teams targets using the bundled runtime and PATH stripped of developer Node/npm. Local CSS/JS, safe mode, window-close-to-tray, single-instance restore, tray Show/Stop/Exit, logs/folder controls, graceful Stop/active Exit and real managed-input EOF cleanup were exercised without terminating Teams.

Installation QA exercised the actual per-user installer and Start Menu shortcut, launcher-running upgrade/uninstall blocking, a true **1.0.0 → 1.0.1** upgrade fixture, and normal and silent uninstall. The default-data sentinel and isolated profile hashes survived upgrade and both uninstall paths; the initially absent default configuration remained absent. Fresh default windows showed every warning paragraph and control; minimum-height/width resizing provided native scrolling, and keyboard navigation brought the off-screen Exit control into view. The final local 1.0.0 portable was freshly extracted and launched after rebuilding the corrected layout. QA ended with ordinary Teams restored after normal tray Quit and the previous debugger port closed.

Both workflow YAML files and all seven PowerShell run blocks parsed successfully; six invalid promotion-input cases were rejected by the actual guard code before GitHub access. **No GitHub CI run or release is claimed.** These local assets are not an attestation for a future CI candidate: download and test that run's exact files before verified draft promotion.

The approved distribution QA scope is **this existing host with isolated data and PATH stripped of developer Node/npm**, not a clean VM or clean Windows account. Removing Node/npm from PATH does not remove installed software or prove missing-prerequisite behavior. No clean VM/account, older-Windows, or universal Teams compatibility proof is available. Binaries remain unsigned.

### Shared lint configurations

`eslint.config.js` composes the default JavaScript and JSDoc configurations from [notmike101/eslint-configs](https://github.com/notmike101/eslint-configs), without overriding their rules. Node files use Node globals; the injected browser payload is parsed as a script and remains a single function consumed as source text, not a module. Warnings fail `npm run lint`. Apply available automatic fixes with `npm run lint:fix`.

The private packages are bundled as `vendor/notmike101-eslint-config-js-4.0.5.tgz` and `vendor/notmike101-eslint-config-jsdoc-1.0.1.tgz`. `npm ci` installs these local archives and their locked third-party peers; no GitHub credentials or registry publication are needed. ESLint stays on the peer-compatible 9.x line because `eslint-plugin-import` does not declare ESLint 10 support.

To update the configurations, pack the corresponding directories from an updated checkout of that repository using `npm pack <package-directory> --pack-destination vendor`, then install the actual archive filenames with `npm install --save-dev ./vendor/<archive-filename>`. Keep both installed archives in the project and remove archives no longer referenced by `package.json`. Run lint and tests after every update.
