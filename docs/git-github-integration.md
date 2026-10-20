# Git & GitHub

Git installation and GitHub CLI installation/sign-in live in
**Extensions → Plugin → Git & GitHub**. The existing `git` feature id, install
marker, enabled flag, and CLI credentials are preserved. Disabling the feature
does not uninstall Git or sign out.

Source Control commits require a manually entered summary and accept an optional
description. There are no commit-message presets, format checks, autocomplete,
or AI generation. Legacy `desktop.git` preferences are no longer read or written.

The **GitHub** side view retains the pull-request list and adds repositories,
issues, Actions runs, workflows, releases, and notifications. Lists are paged.
The repository selector accepts `owner/name`; Enterprise requests can specify a
DNS hostname. Clone requires an absolute new destination under an existing
parent. Review submissions carry the PR head commit id.

The `github` agent tool and desktop IPC use the same allowlisted command builder
and CLI process runner in `src/runtime/github`. No arbitrary `gh` command, raw
API endpoint, token, shell script, or local request-body filename is accepted.
The CLI owns credentials. API bodies are JSON on stdin. CLI and API errors are
visible, responses are bounded, and uncertain writes are not automatically
replayed. Mutations are serialized per host/repository within the executor.
Local checkout/clone also use the Git repository write lock.

## Supported operations

- Repositories: list, inspect, create, clone, fork.
- Issues: list, inspect, create, edit, close/reopen, comment, read comments.
- Pull requests: list, inspect, create, checkout, merge, review/approve/request
  changes, comment, read inline review comments.
- Actions: list workflows/runs, inspect runs, read logs, dispatch workflows,
  rerun all/failed jobs, cancel runs.
- Releases: list, inspect, create, edit/publish drafts.
- Notifications: list and mark individual threads read.

Actions dispatches and published releases can trigger deployment. The UI warns
and confirms before submitting them; the agent tool requires explicit user
approval for writes. Repository creation requires an explicit visibility choice.
Release creation in the UI defaults to a draft.

GitHub permissions still apply: issues/PR writes need repository access,
workflow dispatch needs Actions permission, and notifications require the
account's notifications scope. A permission failure is not treated as an empty
list. Authentication is managed in the plugin details.

## Workspace activity recovery

Mixdog keeps turn, command and management leases in the repository's shared
`mixdog-workspace-admission.json` ledger and a recovery copy named
`mixdog-workspace-admission.json.management`. The latter name is retained for
compatibility; new copies cover all three lease kinds. Both copies are written
under the same lock before a new admission succeeds.

If a release cannot update both copies, its error still reaches the caller,
but the runtime remembers that the work finished. The heal timer or the next
admission retries that release before granting new activity, without requiring
the caller to keep the release handle. Completed leases are not republished as
live ownership; other running leases remain protected.

A damaged or missing ledger is rebuilt from the complete recovery copy.
Damaged bytes are preserved as `.corrupt-<timestamp>-<id>`. Live holders remain
protected even when their runtime is paused or cannot run its heal timer.
Readers continue unless a management lease holds their checkout. Management
resumes when conflicting leases are released or their processes are confirmed
dead; a recovery timeout no longer clears ownership. A refused request still
persists the recovered state, so retrying cannot bypass it.

A healthy ledger also repairs its recovery copy. If neither copy can establish
all ownership, or only an older management-only copy survives, the unknown
state is preserved across retries and restarts. Readers can continue under the
known management holds, but destructive workspace changes refuse with
"Workspace activity cannot be verified. Nothing was changed." Waiting does
not establish that missing holders stopped. If both copies are lost, missing
management holds cannot be reconstructed either; use the recovery procedure
below. A real read or write access failure refuses admission until access is
restored.

Automatic recovery requires participating runtimes to write the full recovery
copy. Finish or restart older runtimes using this repository and its linked
worktrees when upgrading: older versions record readers only in the ledger,
so a mixed-version recovery copy cannot establish all live ownership.

An existing management hold also survives a worktree registry recovery or a
reader using a different profile. A fallback registry that omits the checkout
does not cancel its published hold. This does not reconstruct lost managed
worktree registration; the external-checkout policy for new holds is unchanged.

To recover when ownership cannot be reconstructed:

1. Finish or stop all Mixdog work using the repository **and its linked
   worktrees**, including background commands in every profile. Stop those
   runtimes so new work cannot enter during recovery; closing a window alone
   may leave its runtime or commands running.
2. From a checkout, locate the shared Git directory with
   `git rev-parse --path-format=absolute --git-common-dir`. Inspect and preserve
   its ledger and `.management` recovery copy.
3. If permissions or storage errors prevented the read, restore access instead
   of resetting the ledger. If the contents are damaged and all work is stopped,
   manually move **both admission files** to separate names for inspection,
   then restart Mixdog. The absent pair can now start empty without losing
   live ownership. Do not delete the Git directory or substitute an older
   snapshot that may omit still-running work.

## Reference review

Reference repositories: `github-desktop` and
`vscode-pull-request-github`. Their repository-scoped state,
PR/issue separation, and review flows informed the integration. The official
`github-cli` source (https://github.com/cli/cli) was consulted for command/API
behavior. No reference source code
was copied into Mixdog.

## Verification

Runtime contracts and agent integration:

```powershell
node --test src/runtime/github/github.test.mjs src/session-runtime/builtin-features.test.mjs src/session-runtime/tool-profile.test.mjs
```

Desktop integration (from `apps/desktop`):

```powershell
node --import ./scripts/test-env.mjs --import tsx --test src/main/github-service.test.mjs src/renderer/github/github-ui.test.mjs src/renderer/settings/git-plugin.test.mjs src/renderer/source-control-commit.test.mjs
npm run typecheck
```

No tests publish a release, trigger a workflow, or write to a real repository.
