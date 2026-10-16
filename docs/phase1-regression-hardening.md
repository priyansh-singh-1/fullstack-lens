# Phase 1 regression hardening — 15 October 2026

Scope: React/JS/TS and Spring REST/STOMP behavior already implemented. No dependencies, AST conversion, message_app changes, commits, or pushes. The pre-existing untracked `.diagnostic-codelens/` directory was left alone.

## Regression matrix

Automated coverage is in `frontendApiScanner.test.ts` (FE), `endpointMatcher.test.ts` (Match), `analysisRefresh.test.ts` (Host), and `phase1Regression.test.ts` (P1). Host tests use real VS Code documents, saves, events and commands; Quick Pick responses are controlled through the API. Physical UI selection and rendered lenses still require manual checks.

| Area | Cases verified | Evidence |
| --- | --- | --- |
| A. Static routes | GET/POST `/api/users`, PUT/DELETE `/api/users/{id}`; correct methods, CRLF source lines and no diagnostics for valid calls | P1 CRUD pipeline |
| B. Dynamic routes | `{id}`, `{userId}`, `${id}`, `${UserId}`, string concatenation; regex-style `{id:\d+}` and nested quantifier braces are recognized as variables | FE, Match, P1 Spring regex fixture |
| C. Specificity | Static wins in either scan order; equally specific dynamic routes give FSL003; deterministic candidates; fallback usage counts stay zero; fallback regains usages when a static endpoint is removed | Match, Host specificity/save tests |
| D. Trailing slash | All frontend/backend combinations of `/api/users` and `/api/users/` match; slash normalization does not change precedence | Match, P1 CRUD |
| E. Query parameters | Static query, `${id}` query, function/member expressions in template/concatenated queries; query complexity does not poison pathname resolution | FE parameterized expressions, P1 direct Axios/fetch parity |
| F. Axios instances | Relative/absolute baseURL; string/template/concatenated routes; complete baseURL expression parsing; complex bases/calls stay partial or unresolved; absolute call overrides base; same names in separate files do not duplicate calls; conflicting definitions in a consumer stay unresolved | FE, P1 Axios cases |
| G. Direct Axios | Strings, simple/complex templates, concatenations, complex query expressions, unresolved whole expressions; exact methods and lines | FE, P1 |
| H. fetch | Default GET; explicit GET/POST/PUT/DELETE/PATCH; concatenation; complex/unresolved routes; nested header `method` ignored; comments in configuration; executable calls inside template interpolation retained | P1 |
| I. Diagnostics | FSL001 missing path, FSL002 method mismatch, FSL003 ambiguity, FSL004 partial/unresolved; valid routes clean; same-line calls have independent CodeLens labels; Problems updates after frontend/backend saves and clears fixed errors | FE, Match, Host |
| J. Navigation | Forward REST, reverse single usage, reverse multiple-usage selection/cancellation/stale selection, ambiguous backend selection/cancellation; exact file and zero-based line; malformed targets rejected | Host |
| K. Save/refresh | All five source extensions invalidate; irrelevant/excluded/outside-workspace saves ignored; unsaved keystrokes retain cache; debounce/disposal; concurrent requests share work; obsolete success/error retries; forced scan; revision payloads; stale provider continuation rejected | Host cache/save/navigation suites |
| L. WebSocket | Publish to prefixed `@MessageMapping`; forward and reverse commands; subscriptions still scanned but excluded from publish matches/usages; `@SendTo` retained | Host, P1 STOMP |
| Scanner hygiene | Comment/string examples and identifier suffixes excluded; source offsets preserved; empty path segments cannot match Spring variables; malformed percent escapes remain usable pathnames; unbalanced input does not consume following calls | FE, P1 |

## Bugs and minimal fixes

| Root cause | Fix and regression coverage |
| --- | --- |
| Regex call discovery matched comments, string examples, identifier suffixes, and case-insensitive JavaScript names | Discover against an offset-preserving code mask and require identifier boundaries/case. Preserve executable template interpolation bodies. P1 discovery test |
| Every globally discovered Axios instance was applied to every same-named call, duplicating results and mixing base paths | Prefer definitions in the current file, scan each name once, retain existing cross-file name fallback when consistent, and mark conflicting definitions unresolved. P1 multi-file/order test |
| Axios instance regex captured only the first baseURL literal, silently ignoring concatenation or unsupported expressions; instance calls always appended even absolute URLs | Read the complete immediate baseURL property and reuse the existing route-expression parser; propagate uncertainty; combine only relative call URLs. P1 baseURL test |
| Unsupported complete URL expressions returned no call, hiding FSL004 | Emit unresolved calls for nonempty balanced unsupported expressions. Malformed/unbalanced expressions remain skipped. P1 unresolved test |
| Splitting templates at `?` and matching `${...}` with a flat regex truncated ternaries/nested braces and could claim resolution | Use the existing balanced delimiter reader to isolate interpolations and pathname query boundaries. Protect placeholders during absolute URL parsing. P1 template test |
| A malformed absolute URL escape could make URL decoding fall back to a pathname containing the full scheme/host | Preserve the parsed pathname if percent decoding fails. P1 malformed-escape test |
| fetch searched the entire options object for `method`, including nested headers | Inspect immediate properties only, preserving quoted method values and ignoring comments. P1 fetch options test |
| Spring scanned commented controller/base/method annotations | Mask comments without changing source positions or quoted paths. P1 Spring comment/line test |
| Backend variables accepted empty frontend segments | Reject empty variable segments; retain regex-style variable recognition. P1 matcher test |
| CodeLens inferred method mismatch from any diagnostic on the same line | Check the individual call's path against endpoints. Host same-line test |
| A provider continuation could receive a snapshot invalidated after `getAnalysis` returned | Check revision before producing lenses. Host queued-microtask test |
| Save invalidation refreshed lenses but never republished the Problems collection | Refresh diagnostics from the shared snapshot on the existing debounced CodeLens event, guard revision, and report refresh errors to Output. Host frontend/backend diagnostic save test |

The host run also exposed a test isolation race: Scan Workspace opens Output asynchronously and could steal the following test's editor focus. The scan test now waits for that event. Product Output behavior is unchanged.

## Changed files

- `src/core/parsing/frontend/FrontendApiScanner.ts`
- `src/core/parsing/spring/SpringEndpointScanner.ts`
- `src/core/matching/EndPointMatcher.ts`
- `src/core/codelens/FullStackCodeLensProvider.ts`
- `src/extension.ts`
- `src/test/analysisRefresh.test.ts`
- `src/test/phase1Regression.test.ts`
- `docs/phase1-regression-hardening.md`

`AnalysisService.ts`, `RestDiagnosticAnalyzer.ts`, `HttpCall.ts`, `MatchResult.ts`, the WebSocket scanners/matcher, save registration, indexer, diagnostic manager and existing tests were inspected. Their existing contracts were retained.

## Validation

Final `npm test`: **88 passing (14 seconds), zero failures**, extension host exit code 0 on VS Code 1.142.0. This includes **16 added tests** (12 scanner/pipeline tests and four host lifecycle/navigation tests) and the existing sample test. The pure scanner/matcher subset passes **57 tests**. Regression additions use scenario assertions and table cases rather than count-only tests.

- TypeScript compile: `npm run compile-tests` and `npm run check-types` passed through pretest.
- ESLint: `npm run lint` passed through pretest.
- Extension build: `npm run compile` / esbuild passed through pretest.
- Full suite: `npm test` passed.
- Whitespace validation: `git diff --check` passed.

The initial sandboxed build failed because esbuild could not read an ancestor directory. The same npm test/build command succeeded outside the sandbox after approval. VS Code 1.142.0 is used by the disposable host. No visual CodeLens rendering or performance measurements were performed; automatic rendering is disabled in the test profile.

## Remaining limitations

- Scanners remain lightweight textual recognizers. They do not resolve imports, aliases, scopes, arbitrary JavaScript values, regex literals, every JSX/Java syntax form, or all string escape semantics. Cross-file Axios lookup is still name based; conflicting definitions are now conservative, but consistent names do not establish an actual import relationship.
- Spring recognizes positional quoted mapping paths. Bare/empty mappings, named `value`/`path` arguments, arrays, composed annotations, generic method-level RequestMapping, and multiple controller scopes are outside this pass. Regex-style variables act as nonempty segment wildcards; regex constraints are not executed or ranked, and regexes containing `/` are not fully modeled.
- fetch method inference handles literal immediate options properties. Runtime options, spread/conditional overrides and computed methods are not evaluated; unknown method values retain the existing GET fallback.
- Complex template/member/function route pieces are partial; whole unsupported URL expressions are unresolved. This is static navigation, not runtime route execution.
- Analysis uses saved disk contents. Unsaved edits do not invalidate; file creation/deletion/rename and external changes do not have dedicated invalidation here and may require Scan Workspace. Saves still trigger a full workspace scan, now also demanded by diagnostics after the debounce.
- WebSocket parsing retains existing textual behavior, including first-endpoint selection and the bounded nearby SendTo lookup; full broker configuration and scope inference are not validated.
- API-driven host tests establish provider/command correctness, not rendered-lens responsiveness, normal-profile extension interactions, or physical Quick Pick usability. No new performance claim is justified.

## Exact manual VS Code checks

Use an isolated fixture workspace, with `editor.codeLens` enabled. Reuse the fixtures in `docs/cache-refresh-validation.md`; add `@GetMapping("/users/history")`, a second dynamic endpoint `@GetMapping("/users/{userId}")`, and matching calls as needed. Do not edit message_app.

1. Launch the Extension Development Host with F5. Open `.jsx`, `.tsx`, `.js`, `.ts` and Java fixture files. Confirm visible REST/STOMP lens labels, icons, source lines and counts; inspect Problems for FSL001–FSL004. Verify one valid route has neither a warning nor an information diagnostic.
2. Click a resolved frontend lens and a single reverse-usage lens. Confirm the exact file, annotation/call line, selection, reveal and temporary highlight. Exercise GET/POST/PUT/DELETE with static and dynamic paths.
3. Add a second frontend usage. Click the backend lens, physically select the second Quick Pick item, and verify its exact line. Repeat and press Escape; the source editor must stay put.
4. Add the second equally specific dynamic backend endpoint. Confirm FSL003 and Ambiguous Route; physically select each candidate in turn. Add a static `/users/history` endpoint and call; confirm the static target wins and dynamic usage counts exclude that call.
5. Keep a Quick Pick open, save a changed target file in another editor, then select an old item. Confirm navigation is rejected. Move endpoint lines, save, and click the refreshed lens to verify the new line.
6. Fix a missing/mismatched route and save; verify Problems clears and lenses/counts update after the debounce without Scan Workspace. Break it again through a backend edit and verify Problems returns. Make rapid relevant saves; verify final-state labels. Save a text file and a file under an excluded folder; verify no analysis refresh caused by those saves.
7. Try `/api/users/`, static/dynamic query parameters and complex query expressions. Confirm the pathname retains valid matching. Try a whole `buildUrl(id)` expression and a complex pathname interpolation; confirm FSL004 and no backend navigation.
8. Click a STOMP publish lens and reverse backend usage lens; confirm exact lines. Add subscriptions and verify they do not inflate publish counts or receive publish-navigation lenses.
9. Run Scan Workspace, let Output open, return to source and navigate again. Repeat with Java/Spring extensions enabled in a normal profile. Observe visible refresh/flicker/responsiveness separately; record real host measurements before making performance claims.

## Recommendation

**Phase 1: GO for the documented supported syntax on automated evidence; manual release sign-off remains pending. Phase 2 incremental-analysis engineering: GO.** The current behavior has a useful regression baseline; retain the manual checks above as the release gate. Incremental analysis should preserve these snapshot/revision, diagnostic publication, specificity and usage-count contracts. This pass does not implement incremental analysis or establish rendering performance.
