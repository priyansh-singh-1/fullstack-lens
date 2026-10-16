# Phase 2 Milestone 3: changed-file rescanning

`AnalysisService` retains an ordered map of `FileAnalysis` entries with the last
committed `AnalysisResult`. Keys use absolute normalized paths, folded to lowercase
on Windows. Source text is not retained. Entries additionally retain discovered
Axios definitions and each Java file's first application-prefix candidate.

Relevant saves call `enqueueFileChange(path)`: revision invalidation is immediate,
while analysis remains demand-driven through the existing debounced refresh and
shared pending promise. A warm update reads and scans each distinct dirty file
once, replaces entries in a private map, then globally derives all matches,
usages, and diagnostics. Existing entries and their order are reused. The map and
snapshot publish together only if the captured revision is still current.

Dirty paths remain queued until publication. Saves during loading invalidate the
candidate and retain the complete dirty set for a serialized retry. Explicit
`clearCache()` / `getAnalysis(true)` requests supersede incremental work and force
workspace discovery and a complete rebuild. Obsolete successes and failures do
not publish or fail requests for the newer revision.

## Full-rebuild fallback

A full rebuild occurs when:

- No committed per-file state exists, including cold start.
- A saved path is not in the committed inventory. This preserves save behavior
  for a previously unindexed file; dedicated create/delete/rename events remain
  outside this milestone.
- Any saved file's ordered Axios definitions change, including additions,
  removals, names, base URLs, or resolution states.
- Any saved Java file's discovered application-prefix candidate changes,
  including removal or an unselected candidate. This intentionally invalidates
  more broadly than just changes to the effective workspace prefix.
- Inventory invariants fail or incremental loading/scanning/derivation throws.
- A full rebuild is explicitly requested.

Configuration discovery uses the existing scanner rules. Changing source lines
or formatting while leaving discovered configuration facts equal does not force
a full rebuild. Route, call, MessageMapping, and publish edits normally read only
the saved file. Cross-file context and all public matching rules stay unchanged.

For a configuration change, the detection read is followed by full loading, so a
single dirty configuration file costs `N + 1` reads for `N` indexed files. A batch
can additionally have detection reads for earlier dirty files. An unindexed save
falls back before reading that path. Ordinary single saves cost one source read
and zero workspace discoveries; repeated saves before analysis coalesce by path.

Fallback is one full attempt per current transaction. If that attempt also fails,
the request rejects, the old committed state stays intact but stale, and a later
request can retry a full rebuild. No retry loop is used for a current failure.

There are no route indexes or incremental match/diagnostic/usage updates yet.
Global derivation and snapshot materialization remain proportional to workspace
entities, and broad configuration changes still require complete source loading.

## Validation

Validated on October 15, 2026 with `npm test`: **130 passing (24 seconds)**,
zero failures, and VS Code 1.142.0 extension host exit code 0. The pretest steps
also passed test compilation, TypeScript checking, ESLint, and the esbuild build.
The initial sandboxed build could not read an ancestor directory; the complete
command passed when rerun outside the sandbox with approval.

The automated suites verify content-scanner equivalence, cold-scan parity,
incremental/full-scan parity for REST and WebSocket entities, diagnostic changes,
usage redistribution, navigation line updates, save coalescing, concurrent saves,
obsolete successes and failures, forced rebuilds, configuration fallbacks, and
recovery after a current read failure. Instrumented source reads confirm one read
and zero workspace discoveries for an ordinary warm save; repeated saves to the
same file before analysis also require one read. Two dirty files require two reads.
These counts establish reduced source loading, not end-to-end UI performance.

Physical CodeLens rendering, manual Quick Pick interaction, and normal-profile
responsiveness remain to be checked using the manual steps in
`docs/phase1-regression-hardening.md`. Dedicated file creation, deletion, and
rename invalidation remain outside this milestone.
