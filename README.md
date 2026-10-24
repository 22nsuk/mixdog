# Issue 224 visual evidence

Four unmodified screenshots from a hidden, isolated Electron BrowserWindow using the real renderer components and repository CSS:

| Capture | Fixture route / action | Observed result |
| --- | --- | --- |
| before-saved.png | Stored contextPercent: 80, contextTokens: 750000 | Context shows 30% / 300k (catalog default) |
| after-saved.png | Identical stored route | Context shows 75% / 750k; no Apply footer |
| before-edit.png | Stored contextPercent: 30; change only Context slider to 100% | 100% / 1M; Apply footer absent |
| after-edit.png | Identical context-only change | 100% / 1M; enabled Apply footer present |

## Capture implementation

The fixture imports real AgentProfilePane, RouteChainEditor, ModelRouteEditor, RouteEditor, their dependencies, the actual desktop font packages, tokens.css, styles.css, font-faces.css, desktop.css, pane-layout.css and routines.css. The surrounding 500x820 panel uses the repository agent-panel/agent-panel-view classes, with only fixture geometry added. The Electron content window is 800x860 CSS pixels; native screen scaling determines PNG dimensions.

API data alone is synthetic. The generic Cursor model fixture follows agent-profile.test.mjs at d26ed191e: 300000 default context, 1000000 maximum, high effort, fast false. Both stored routes preserve modelParameters: {context: '300k'}, which avoids introducing an unrelated hidden-parameter difference while editing Context. There is no real provider connection, user profile, daemon, credential, or API request. Electron request interception rejects non-file/data requests; capture JSON records zero blocked network requests and zero renderer errors.

The build uses git show d141c52f61daf767cb2bad98d49f867c5b77282a:apps/desktop/src/renderer/AgentProfilePane.tsx for before. After uses those exact source bytes plus two numeric field copies in routeSelection, preserving contextPercent and contextTokens. The esbuild onLoad override changes only the in-memory AgentProfilePane source used for the bundle. Product files and git state are never changed by the recipe. Unrelated Monaco worker imports are built as real worker bundles, with no component or worker stubs. The recipe follows apps/desktop/scripts/probe-fixture-runner.mjs, electron-harness.mjs, and composer-layout-probe/main.cjs approaches.

The fixture opens the real model trigger and real Context menu. The edit case changes the native range value, dispatches an input event, then commits through the control's ArrowRight keyup handler. Each PNG's adjacent JSON contains stored data, slider percentage, context heading, Apply state, API calls, errors and blocked requests. All four PNGs were visually inspected: text, slider and bottom footer differences are clear.

## Reproduce

With the repository's declared desktop dependencies installed, use PowerShell 7:

```powershell
node ./recipe/run.mjs <path-to-mixdog-checkout>
```

This regenerates all four PNG/JSON pairs and capture-provenance.json. The runner asserts expected slider percentages, Apply presence/enabled state, and absence of renderer errors or network requests. It creates task-owned bundles and isolated Electron profiles under this evidence directory's runtime folder. The reproducible source recipe is retained.

The after source hash was checked against product commit 2957cdcce0bbf29915e9931517f0340459183fd8. The four capture outputs were checked with `node recipe/verify.mjs <evidence-directory>` after capture. Each PNG is 884x949 native pixels.

## Scope and limits

These are real primary-route agent profile renders in an isolated fixture, not full desktop app screenshots. The visual set covers exact-context loading and context-only dirty detection. Fallback-chain behavior, full save/reload persistence and backend validation should be covered by repository tests; these screenshots make no claim about those paths. The capture does not click Apply or call a save endpoint.
