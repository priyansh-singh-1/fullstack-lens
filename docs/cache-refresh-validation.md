# Analysis cache refresh validation

Implemented a shared cache generation, immediate relevant-save invalidation, a 400 ms debounced CodeLens event, and revision-tagged navigation payloads. Requests share one scan; obsolete results and obsolete scan errors are discarded before a sequential retry. Warm navigation reuses the snapshot. An old lens from a previous revision reports that it is out of date rather than using an old line number. Explicit Scan Workspace forces a new generation and then refreshes lenses.

Validation on 11 October 2026: TypeScript, ESLint, full esbuild compilation and `npm test` passed. The final isolated VS Code 1.141.0 run reported **21 passing (9 seconds)**, including the original sample test. Tests cover relevant/irrelevant saves, excluded folders, rapid saves, disposal, refresh events, unsaved edits, concurrent requests, invalidation during both initial and follow-up scans, obsolete errors, explicit refresh, REST/template path navigation, WebSocket navigation, usage counts, unmatched lenses, malformed targets, and navigation after endpoint lines move. Multiple-usage counts and the Quick Pick command were asserted; physical selection inside Quick Pick was not automated.

The test configuration uses a disposable workspace and fresh profile, disables third-party extensions, and turns off automatic editor CodeLens requests to make scan race assertions deterministic. Providers/events and real commands are exercised through the VS Code extension API. This does not measure visual rendering or reproduce normal-profile Java-extension interference. No dependencies, scanners, matchers or message_app files were changed.

## Exact manual VS Code tests

Create `.vscode-test/manual-cache-refresh` inside the extension repository. Use this disposable folder for edits; do not edit message_app. Add the two files below. They are static-analysis fixtures and do not need a running application or a Java build.

`Controller.java`:

```java
@RestController
@RequestMapping("/api")
class Controller {
    @GetMapping("/users/{id}")
    void user() {}
    @MessageMapping("/chat.send")
    void chat() {}
}
class Config {
    void configure() {
        registry.setApplicationDestinationPrefixes("/app");
    }
}
```

`Calls.jsx`:

```jsx
const id = 1;
axios.get(`/api/users/${id}`);
axios.get('/api/users/2');
axios.get('/api/missing');
client.publish({ destination: '/app/chat.send' });
```

1. Run `npm run compile`, then press **F5** with **Run Extension** selected. In the Extension Development Host use **File → Open Folder** to open `.vscode-test/manual-cache-refresh`. Set `editor.codeLens` to `true` and `files.autoSave` to `off` in that host. Open both fixture files. Other extensions may add startup/provider delays; a 400 ms debounce is not a guaranteed display deadline.
2. Click a REST **Go to Backend** lens in Calls.jsx. Expect Controller.java's `@GetMapping`. Click its **2 Frontend Usages** lens; expect a Quick Pick containing both calls. Select each entry in turn and check that the corresponding call is highlighted. `/api/missing` should show **No Backend Found**. Click the publish lens and the backend WebSocket usage lens; expect navigation in both directions.
3. Insert five blank lines immediately before `@GetMapping`, then save Controller.java. After the refresh, its lens should move with the annotation. Click a newly refreshed frontend REST lens; expect the new annotation line. Click the new backend lens; Quick Pick navigation should still work. If an old lens is clicked before replacement, an out-of-date notification is acceptable; it must not silently use an old line or crash.
4. Change `@GetMapping("/users/{id}")` to `@GetMapping("/people/{id}")` and save. Expect the two `/users/...` frontend lenses to become **No Backend Found**, and the backend count to become zero. Change both frontend URLs to `/api/people/...` and save Calls.jsx; expect matching and the count of two to return. This also checks template and dynamic path matching after invalidation.
5. Insert blank lines before the frontend calls, save, and repeat backend Quick Pick navigation. Expect the new frontend lines. Change the WebSocket mapping to `/chat.other`, save Controller.java, then change the publish destination to `/app/chat.other` and save Calls.jsx. Expect the usage count and both navigation directions to reflect the new destination.
6. After a completed analysis, edit Calls.jsx without saving. The extension should reuse the saved snapshot and should not start a workspace scan for each keystroke. Save to update the analysis. Confirm with Extension Host logs if needed; VS Code can adjust visible lens positions independently of analysis.
7. Edit both fixture files and use **File → Save All**. Expect the final saved contents to be reflected after analysis. Saves within the debounce window coalesce into one save-triggered refresh. Independent VS Code provider requests during a save burst may demand scans sooner; all scans must remain serialized.
8. Create and save `notes.txt`, `config.json`, and `.js`/`.java` files under `node_modules`, `dist`, `build`, and `target`. With a warm snapshot, these saves should not invalidate it or trigger a FullStack Lens workspace scan. Relevant files outside the opened workspace are also ignored.
9. Run **FullStack Lens: Scan Workspace** from the Command Palette. Expect a new full analysis, updated output, and refreshed lenses. Repeated navigation afterward should use the cache.
10. Save a relevant fixture and immediately use **Developer: Reload Window** before the debounce expires. There should be no callback from the disposed provider after reload. The fresh activation may perform its own analysis. Timer cancellation and listener disposal are also covered by automated tests.

## Remaining limits

Refresh is save-driven and scanners still read disk. Unsaved changes, external filesystem writes, deletes, renames and workspace-folder changes do not invalidate automatically; use Scan Workspace for those changes. Older lens payloads without a revision remain supported for compatibility but cannot receive the same stale-revision check. Current-generation scan failures propagate to callers; obsolete-generation failures are retried. Multiple-usage navigation rechecks the snapshot revision after Quick Pick, so a save while it is open requires retrying with refreshed lenses. Visual rendering, mouse clicks and performance improvements have not been measured.
