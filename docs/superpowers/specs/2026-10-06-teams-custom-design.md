# Native Teams local CSS/JS extensions

Approved in chat before implementation. Native feasibility was proven on MSTeams 26246.1604.5133.838 / WebView2 154.0.4258.53: launch the ms-teams.exe execution alias with a process-local WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS containing --remote-debugging-port=49327 --remote-debugging-address=127.0.0.1. /json/version responded; listener ownership was the Teams WebView2 browser; JS evaluation and CSS.createStyleSheet/CSS.setStyleSheetText produced a visible marker in the native Teams window. Marker removed. No registry/global environment changes.

## Scope
A Windows local companion, not an Electron patch, DLL injector, browser replacement, or BetterDiscord compatibility layer. Keep Teams binaries/profile untouched. This folder has no .git directory, so work in place; do not initialize git or fabricate commits/worktrees. Only one subagent active at a time.

## Behavior
- Node.js CLI launches Teams with child-process-only debugger arguments, or attaches to an already debug-enabled Teams instance. If Teams runs without the requested debugger, report how to Quit Teams; never force-kill it.
- Verify debugger listener is loopback-only and owned by msedgewebview2.exe whose host is ms-teams.exe and whose ancestor is ms-teams.exe. Never attach to an unrelated listener.
- Discover exact eligible page origins: https://teams.live.com, https://teams.microsoft.com, https://teams.cloud.microsoft. Exclude workers and sign-in origins. Recheck origin in the evaluated document; remove loader when an attached page leaves the allowlist. Apply the runtime to the top-level document only.
- Persistent companion discovers new eligible targets; full document reloads recreate runtime and CSS. SPA navigation does not itself require reinjection. Detect disconnection and rediscover while companion remains running.
- %APPDATA%/TeamsCustom/config.json stores enabled theme/plugin filenames. themes/*.css and plugins/*.js are local files only; validate config types and safe direct-child filenames. Defaults enable no plugins/themes. --data-dir supports isolated smoke runs. Deterministic filename ordering.
- CSS is read locally and applied through CDP inspector stylesheet APIs, not remote fetch or global CSP bypass. Runtime panel styling uses the same channel.
- Plugins are trusted JS function bodies returning {start(api), stop()}; no imports/require/Node bridge. api supplies plugin identity and AbortSignal; abort and call stop before disable/replacement. Await lifecycle, isolate failures, display errors. Plugin authors own cleanup of DOM/listeners/timers/patches. Store per-file revision so unchanged plugins do not restart on every scan. A bad replacement stops the old version and reports failure, without breaking other plugins. Do not imply arbitrary side effects can be reversed.
- A small accessible native-page overlay manages theme/plugin enablement and reload, displays errors/status, and opens/closes without changing Teams settings. Controls send bounded JSON messages through Runtime.addBinding. Host validates action/type/file against current discovered files and allowed schemas before changing config. Never expose filesystem/process operations through this binding. Catch duplicate clicks and serialize changes.
- Hot reload observes changes to config and extension files. Use a simple periodic scan if it reduces Windows fs.watch complexity; name polling ceiling in a ponytail comment. Debounce/serialize snapshot application; do not accumulate duplicate layers/listeners/panels.
- Safe mode applies no plugins or themes but retains management access. Exiting companion stops plugins, removes owned DOM/panel and blanks owned inspector stylesheets where targets remain accessible. An ordinarily launched Teams after Quit has no debug port and no extensions. Warn explicitly that loopback debugger is accessible to local processes and persists until Teams quits.

## Verification
First keep focused runnable regression checks for trust-boundary filename/config validation, CDP error/timeout/disconnect behavior, and lifecycle replacement/cleanup where practical. Parent runs checks after worker edits, not workers mid-flight. Prove actual native surface: launch/attach, visible local theme and plugin, panel controls, theme edit, plugin edit stop/start, failed plugin isolation, disable cleanup, SPA navigation, full reload, safe mode, companion exit cleanup and normal-launch rollback. New targets/pop-out handling must have direct CDP scenario evidence; do not send messages, start calls, or alter account settings.

## Sources
- https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.core.corewebview2environment.createasync
- https://learn.microsoft.com/en-us/microsoft-edge/webview2/how-to/debug-visual-studio-code
- https://github.com/MicrosoftEdge/WebView2Feedback/issues/5640 (elevated-host hardening; full trust is not elevation)
- https://github.com/BetterDiscord/BetterDiscord/blob/main/scripts/inject.ts
