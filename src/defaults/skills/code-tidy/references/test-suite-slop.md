# Test-suite slop

Read this when tests are in scope for agent-level cleanup. Tests accumulate
through repeated agent corrections the same way production code does:

First distinguish redundant coverage from removing a supported behavior.
Keep distinct observable success, rejection, error, and compatibility cases.
Before removing a behavior and its tests, require independent evidence from
current requirements, real callers, or a specification; tests existing only
for that branch are neither proof of necessity nor permission to delete it.

- **Dominated tests** — several tests reach the same branch and the same
  result; one asserts the observable output, the others only check
  construction, type, or non-emptiness. Keep the strongest, delete the rest
  and the fixtures that served only them.
- **Accumulated regression tests** — a near-identical test appended after each
  correction, or parameter permutations whose values never cross a new branch,
  equivalence class, or failure mode. Keep the smallest set that still covers
  distinct regressions, and a permutation only where it marks a real boundary.
- **Tautological assertions** — assertions that cannot fail: `assert True`,
  two equal literals compared, a state the fixture itself guarantees, a mock
  verifying the setup that fed it. Delete, or rewrite against the observable
  result.
- **Verification theater** — checksums, receipts, validators, or
  recomputation where producer and verifier share the same information and
  failure domain. They cannot fail independently; delete.
- **Closed justification loop** — a fallback exists because a test exercises
  it and the test exists because the fallback was added. Neither is evidence
  for deleting the pair. Apply the independent-evidence gate above first;
  unresolved intent blocks deletion. A distinct externally observable
  rejection, error, or compatibility test is not a loop; preserve its coverage.
