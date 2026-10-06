# Native Teams CSS/JS Loader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Execute sequentially. Parent runs checks after edits; workers skip build/lint/tests/formatters mid-flight.

**Goal:** Load local user CSS and JS extensions in installed native Microsoft Teams with reversible controls and live reload.

**Architecture:** A Node companion configures only its Teams child environment and attaches to loopback WebView2 CDP. A guarded page runtime owns plugin lifecycle and UI; the host owns local files, config validation and inspector stylesheet updates.

**Tech Stack:** Windows PowerShell process/listener discovery, Node.js 22+ stdlib, existing ws dependency updated to the current compatible 8.x release, Chrome DevTools Protocol. No frontend framework or bundler.

**Spec:** docs/superpowers/specs/2026-10-06-teams-custom-design.md

## Global Constraints
- Keep Teams binaries, profile, registry and global environment untouched; never kill Teams or override security policy.
- Only one subagent active at a time; no nested subagents.
- Exact allowed origins: https://teams.live.com, https://teams.microsoft.com, https://teams.cloud.microsoft. Page targets/top-level document only.
- Node.js 22+; trusted plugins, no Node bridge; local CSS via inspector stylesheets; no CSP bypass or remote stylesheet fetch.
- Default data directory %APPDATA%/TeamsCustom; empty enabled lists; safe mode runs no user extensions.
- Work in place: no .git exists. No git initialization, commits, or worktrees.

## Files and interfaces
- Replace index.js: CLI, host orchestration, target attach/discovery, serialized apply, graceful shutdown.
- Create lib/cdp.js: export CdpConnection with connect(url), send(method, params), close(), event subscription; bounded requests, unique IDs, reject pending on disconnect.
- Create lib/extensions.js: export readSnapshot(dataDir, safeMode), validateConfig(value), validateFilename(name, suffix), snapshotExpression(snapshot); deterministic extension enumeration and isolated errors, no path traversal.
- Create lib/windows.js: Teams discovery/launch and listener ownership validation; return data as JSON from PowerShell, use child environment only, no elevation/termination.
- Replace inject/customStyle.js with inject/runtime.js: guarded window.__teamsCustom runtime, serialized apply(snapshot), dispose(), panel UI and plugin lifecycle. Build plugin factory literals host-side so CDP executes local JS without page-side eval/import/remote fetch.
- Update package.json, package-lock.json and README.md; create focused test/*.test.js and local examples if needed for instructions. Delete obsolete remote stylesheet payload only after new runtime exists.

### Task 1: Regression checks before implementation
- [ ] Read the spec and repository source. Write focused regression checks before changing implementation.
- [ ] Use node:test and node:assert/strict. Config tests reject ../outside.js, absolute paths, separators, wrong extensions, prototype-shaped entries and wrong enabled-list types; accept ordinary direct-child filenames. Snapshot tests use isolated temporary directories and prove disabled files do not execute, invalid config does not enable everything, deterministic ordering and revision changes.
- [ ] CDP checks exercise real local WebSocket server behavior for protocol errors, request timeout and close with pending requests; no mocks that merely echo wiring.
- [ ] Return test files and exact commands to parent. Parent runs failing-before checks; expected missing-module/behavior failures are recorded. Do not run checks in worker.

### Task 2: Persistent host and runtime (one integration owner)
- [ ] Implement the files/interfaces above. Prefer one coherent owner because target lifetime, binding messages, config revisions and runtime lifecycle are shared.
- [ ] Use --attach --port 49327 for the proven live Teams instance during parent smoke; default launcher uses a configurable available loopback port and refuses a second companion/unknown listener.
- [ ] Launch ms-teams.exe alias through PowerShell Start-Process with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS set only in the spawned environment. Inspect existing Teams first; actionable error if already running without matching endpoint.
- [ ] Confirm Get-NetTCPConnection listener and Get-CimInstance process ownership before endpoint access. Validate every debugger URL uses loopback and requested port. Validate HTTP responses and target fields.
- [ ] Add DOM/CSS/Page domains, create owned inspector stylesheet per document, update text with enabled themes plus panel CSS. Register binding and page bootstrap, then apply current document immediately. Handle frameNavigated/document changes, newly discovered targets and navigation off allowlist without exposing privileged functionality.
- [ ] Generate plugin factory literals with sourceURL diagnostics from local JS, apply only on eligible origin, await plugin start/stop and abort signal. Serialize applies and panel actions. Preserve unchanged running plugins; report each failure independently.
- [ ] Panel checkboxes change validated config and apply to all eligible targets. Reload rescans local files; safe mode disables loading despite enabled config. Errors must be visible and bounded.
- [ ] Graceful SIGINT/SIGTERM disposes runtime and blanks owned styles before closing CDP. Debugger remains in Teams until Quit; explain this instead of claiming shutdown disables it.
- [ ] Update dependencies/lockfile together; remove obsolete axios and customStyle.js after cutover.
- [ ] Parent runs node --test test/*.test.js and launches the real CLI. Worker does not run checks or UI actions.

### Task 3: Native verification and review
- [ ] Parent creates isolated local theme/plugin fixture under a temporary --data-dir; no auto-enabling unreviewed external code.
- [ ] Run actual companion attached to native Teams. Prove CSS computed style and JS-owned DOM marker, then capture native window screenshot.
- [ ] Exercise panel toggle/reload, theme file edit, plugin file edit with cleanup, syntax/lifecycle failure isolation, disable, SPA navigation, full reload and target discovery. Use harmless DOM/UI operations only.
- [ ] Restart companion in safe mode and confirm no user effects. Exit and confirm cleanup. Quit Teams via UI and launch ordinarily; confirm no debugging listener. Verify launcher mode after clean Quit as well as attach mode.
- [ ] Dispatch one sequential read-only reviewer for spec compliance/security/quality; parent resolves findings through one integration owner and reruns affected proof.
- [ ] Rewrite README with exact launch/attach/safe commands, plugin body example, data/config format, polling behavior, unsupported limitations and rollback. Remove throwaway fixtures after proof; preserve runnable focused checks. Report only observed verification.

## Preflight decisions
Task 1 creates the checks consumed by Task 2; Task 2 produces all shared interfaces consumed by Task 3. One integration owner avoids shared-file races. Task 3 owns UI/process changes, so workers cannot accidentally send messages or force-quit Teams. Spec is approved in chat; files record that approval, not a new approval gate. No git/worktree workflow is possible without initializing an unrelated repository, so in-place edits are the conservative ruling.
