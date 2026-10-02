# Memory maintenance

Conversation history and standing instructions have separate owners:

- **Cycle 1** summarizes conversation by session/topic, keeps source links, and
  generates search embeddings. Default interval: `10m`.
- **Standing memory** is user-curated through `memory` (`add`, `edit`, `delete`,
  `list`), with approval for the exact content and scope. Cycles cannot populate,
  rewrite, merge, or delete these entries.

There is no relationship-review cycle, third cycle, candidate queue, importance promotion/demotion, or
generated-instruction exclusion operation. The memory tool lists curated records;
use `recall` for generated conversation history.

Public recall supports page sizes up to 100 and offsets up to 500. Internal
retrieval windows cover the requested page, and existing duplicate grouping runs again
after supplemental results and time filters are combined. Embedding and
backfill failures propagate as failures, with committed progress retained in
the result instead of being reported as a successful empty run.

## Existing databases

The retired Cycle 2 no longer schedules or dispatches LLM work. Its manual
`cycle2` and `sleep` actions are removed; `flush`, `rebuild` and `backfill`
run summarization and embedding maintenance only.

Existing `entries.cycle2_reviewed_at` metadata, `duplicate_of` search aliases
and concept/lineage links are preserved. Recall still uses these relationships;
it does not generate new ones. New databases do not create the retired review
column, and maintenance no longer reads or updates it on existing databases.
A duplicate is collapsed only when its
representative is in the same filtered result, before limits and pagination.
Existing history, summaries, curated
entries, and obsolete metadata are not bulk rewritten or dropped. Old
`pending`/`active`/`archived` records remain searchable, including records with
old promotion metadata. Legacy archived curated entries remain inactive.
Conflicting legacy CORE keys are preserved and reported; startup defers the
unique index until explicit edits/deletes resolve them. Per-pool locked key
checks prevent new conflicting writes even while that index is deferred.

Old second- and third-cycle configuration and queue metadata are ignored.
Session snapshots contain only curated
entries; older snapshots with generated data can still be read, but that data
is never injected. Applying this code does not itself restart or deploy the app.

New databases do not create promotion-only columns/indexes or an active-only
materialized search view. Existing unused columns and indexes are left in place;
normal startup neither refreshes nor purges them. An old derived search view is
dropped only when an embedding-model migration needs to release its dependency.
