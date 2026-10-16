# Milestone 3 manual validation

Prepared October 16, 2026. Manual status: **Pending**. No visual pass/fail or timing has been observed from this session.

## Setup and timing

The disposable workspace is `.vscode-test/manual-milestone3`, containing `Controller.java` and `Calls.jsx`. These are static-analysis fixtures; no server or Java build is required. Do not edit message_app. The fixture lives under the ignored test directory.

Run `npm run compile`, select **Run Extension**, and press **F5**. In the Extension Development Host, open the fixture folder itself. Its workspace settings enable CodeLens and disable Auto Save. Open Calls.jsx, then Controller.java. Record VS Code version, enabled extensions/profile, and fixture size with results. Repeat in the intended normal profile if the initial run uses an isolated profile.

Measure cold first CodeLens from opening Calls.jsx in a fresh host to the first visible FullStack Lens label; this includes activation/provider delay. Measure warm refresh from pressing Save to the expected labels/counts becoming visible. Use screen recording or a stopwatch and record the method; do not substitute scanner duration. The save debounce is 400 ms, not a display deadline. Record click latency separately after refreshed lenses appear. Run the checks in order; use only normal Save, without Scan Workspace between steps.

Baseline: the dynamic `/users/{id}` endpoint has two usages; static `/users/history` has one; `/chat.send` has one publish usage. Check navigation in both directions, physically selecting each item when Quick Pick appears.

## Checks

1. **Frontend save refresh:** Change the second call from `/api/users/2` to `/api/missing` and save Calls.jsx. Time until it shows **No Backend Found** and the dynamic backend count drops to one. Restore `/api/users/2`, save, and verify two usages return.
2. **Backend route save refresh:** Change `/users/{id}` to `/people/{id}` and save Controller.java. Both `/users/...` calls must become unmatched; the static history call stays matched. Change the first two frontend calls to `/api/people/${id}` (preserving backticks) and `/api/people/2`, then save. Both match again; the dynamic count returns to two. Record backend-save latency separately from frontend-save latency.
3. **Navigation after line move:** Insert five blank lines before the dynamic mapping and save Controller.java. Click each refreshed frontend lens: both must select the moved annotation. Insert three blank lines before the calls and save Calls.jsx. Click the backend usage lens and physically select each Quick Pick entry: each must select the current call line. A click on an obsolete lens before replacement may report out of date; it must never navigate silently to an old line.
4. **Static to dynamic usage redistribution:** Restore the dynamic mapping and first two calls to `/users/{id}` and `/api/users/...`; save both files and wait. Counts must be dynamic two, static one. Remove the static `@GetMapping("/users/history")` annotation and save Controller.java: the history call must now navigate to the dynamic annotation, whose count becomes three. Restore the static annotation and save: counts return to two and one, and history navigation selects the static annotation.
5. **WebSocket save refresh:** Change `/chat.send` to `/chat.other` in Controller.java and save. The existing publish must lose its match. Change the publish destination to `/app/chat.other` and save Calls.jsx. Verify one backend usage and navigation to the current mapping/call in both directions. Record each save's latency.
6. **Rapid repeated saves:** In Calls.jsx, save the second REST call as `/api/missing-a`, then `/api/missing-b`, then `/api/users/2` in quick succession. Repeat while alternating frontend and backend edits, ending with dynamic `/users/{id}`, static `/users/history`, and publish/mapping `/app/chat.other` and `/chat.other`. After settling, expect dynamic two, static one, WebSocket one, all matched. Click every final lens and each Quick Pick item. Verify final targets/lines, no lingering missing-route diagnostics, no dead/stale visible lenses, and no errors in FullStack Lens Output. Record burst duration and time from last save to final correct display separately.

## Results

Date/time and timezone: ______
VS Code version / profile / enabled extensions: ______
Timing method: ______
Workspace file count/size: ______

| Check | Result | Save-to-visible time |
| --- | --- | --- |
| Frontend save refresh | Pending | Not measured |
| Backend route save refresh | Pending | Not measured |
| Navigation after line move | Pending | Not measured |
| Static to dynamic usage redistribution | Pending | Not measured |
| WebSocket save refresh | Pending | Not measured |
| Rapid repeated saves | Pending | Not measured |

Rapid saves final state correct: Pending (Yes / No)

Dead/stale CodeLens after settling: Pending (Yes / No)

Cold first CodeLens: Not measured

Warm frontend refresh: Not measured

Warm backend refresh: Not measured

Click after refresh: Pending (Instant / Delayed; record elapsed time if delayed)

Failures, Output errors, and reproduction notes: ______

Automated tests provide supporting API-level evidence only. They disable automatic CodeLens rendering and cannot complete this manual sign-off or establish normal-profile performance.

## Supporting automated run - October 16, 2026

`npm test`: **129 passing (30 seconds), 1 failing**, runner exit code 1 on VS Code 1.142.0. Test compilation, TypeScript checking, ESLint, and esbuild passed. The initial sandboxed attempt failed on an esbuild ancestor-directory access restriction; this result is from the approved rerun outside the sandbox.

The failure was `Navigation and saved endpoint changes > missing or malformed targets complete without throwing or navigating` at `src/test/analysisRefresh.test.ts`: the final active editor was FullStack Lens Output instead of Navigation.jsx. This suggests an asynchronous Output-focus race following Scan Workspace, but the cause is not confirmed. Do not count this run as a complete automated pass.

The changed-file rescanning suite passed, including frontend/backend edits, moved lines, static-to-dynamic redistribution, WebSocket edits, rapid saves, obsolete results/failures, and full-rebuild fallbacks. These assertions do not supply any of the manual timing values above.
