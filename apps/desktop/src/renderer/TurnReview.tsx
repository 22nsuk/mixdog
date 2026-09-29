import { Check, FileDiff, FileText, Undo2, X } from 'lucide-react';
import {
  type Dispatch,
  memo,
  type ReactNode,
  type SetStateAction,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { t } from './i18n';
import { ErrorNotice, errorMessageText } from './ErrorNotice';
import { GitDiffBody } from './ReviewPane';
import { findPatch, PATCH_CACHE_LIMIT } from './TranscriptView';
import { readDiffStyle, TURN_REVIEW_DIFF_STYLE_KEY, type TranscriptItem, writeDiffStyle } from './desktop-types';
import { openDockSlot } from './dock-slot-motion';
import { parseUnifiedDiff, turnReviewScope } from './renderer-logic.mjs';
import { RendererLruCache } from './renderer-lru-cache';
import { isMobileRemoteSurface } from './mobile-surface';
import { registerIdleReclaim } from './idle-reclaim';
import {
  agentReviewCache,
  leadReviewCache,
  leadReviewFilesCache,
  leadReviewSnapshotKindCache,
  leadReviewCheckpointIdCache,
  rememberAgentReviews,
  reviewTagCache,
  type AgentTurnReview,
  type TurnReviewFile,
} from './turn-review-cache';
// biome-ignore format: @ts-expect-error must precede the specifier
// @ts-expect-error The shared runtime module is plain ESM and has no declaration file.
import { classifyToolCategory, parseLineDelta, parseToolArgs, summarizeToolResult } from '../../../../src/runtime/shared/tool-surface.mjs';

// "Review Changes": the headline is one authoritative turn-start → current
// worktree diff. Exact worker apply_patch diffs remain attribution metadata and
// are only added to totals in the non-Git fallback.
type TurnReviewPatchPart = ReturnType<typeof parseUnifiedDiff>[number];
type TurnReviewFileEntry = {
  additions: number;
  deletions: number;
  lineStats: boolean;
  status: string;
  binary: boolean;
  parts: ReturnType<typeof parseUnifiedDiff>;
};
type TurnReviewSummary = {
  files: Map<string, TurnReviewFileEntry>;
  additions: number;
  deletions: number;
  hasLineStats: boolean;
};
const TURN_REVIEW_PATCH_CACHE_MAX_CHARS = 4 * 1024 * 1024;
const TURN_REVIEW_PATCH_CACHE_ENTRY_MAX_CHARS = 512 * 1024;
const turnReviewPatchCache = new RendererLruCache<
  string,
  Array<{
    name: string;
    additions: number;
    deletions: number;
    lineStats: boolean;
    status: string;
    binary: boolean;
    part: TurnReviewPatchPart;
  }>
>({
  name: 'turn-review-parsed',
  maxEntries: PATCH_CACHE_LIMIT,
  maxChars: TURN_REVIEW_PATCH_CACHE_MAX_CHARS,
  measure: (value, patch) => patch.length + JSON.stringify(value).length,
});
registerIdleReclaim(() => {
  turnReviewPatchCache.clear();
});

function analyzeTurnReviewPatch(patch: string) {
  const cached = turnReviewPatchCache.get(patch);
  if (cached) {
    return cached;
  }
  const analyzed = parseUnifiedDiff(patch).flatMap((part) => {
    const name = String(part.newFile?.fileName || '');
    if (!name) return [];
    let additions = 0;
    let deletions = 0;
    for (const line of part.hunks.join('\n').split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) additions += 1;
      else if (line.startsWith('-') && !line.startsWith('---')) deletions += 1;
    }
    const status = String(part.status || '');
    // A bare `diff --git` header is not a file change. It used to survive as
    // an empty parsed part and rendered the misleading “+0 -0” row.
    if (additions === 0 && deletions === 0 && !status) return [];
    return [
      {
        name,
        additions,
        deletions,
        lineStats: additions + deletions > 0,
        status,
        binary: status === 'binary',
        part,
      },
    ];
  });
  if (patch.length <= TURN_REVIEW_PATCH_CACHE_ENTRY_MAX_CHARS) {
    turnReviewPatchCache.set(patch, analyzed);
  }
  return analyzed;
}

function summarizeTurnReviewPatch(patch: string): TurnReviewSummary {
  const files: TurnReviewSummary['files'] = new Map();
  if (patch) {
    try {
      for (const analyzed of analyzeTurnReviewPatch(patch)) {
        const entry = files.get(analyzed.name) || {
          additions: 0,
          deletions: 0,
          lineStats: false,
          status: '',
          binary: false,
          parts: [],
        };
        entry.additions += analyzed.additions;
        entry.deletions += analyzed.deletions;
        entry.lineStats ||= analyzed.lineStats;
        entry.status ||= analyzed.status;
        entry.binary ||= analyzed.binary;
        entry.parts.push(analyzed.part);
        files.set(analyzed.name, entry);
      }
    } catch {
      /* malformed/non-diff payload — skip */
    }
  }
  return turnReviewSummaryOf(files);
}

/** Totals a summary always carries for its own file map. */
function turnReviewSummaryOf(files: Map<string, TurnReviewFileEntry>): TurnReviewSummary {
  let additions = 0;
  let deletions = 0;
  let hasLineStats = false;
  for (const entry of files.values()) {
    additions += entry.additions;
    deletions += entry.deletions;
    hasLineStats ||= entry.lineStats;
  }
  return { files, additions, deletions, hasLineStats };
}

function summarizeAuthoritativeTurnReview(filesInput: TurnReviewFile[], patch: string): TurnReviewSummary {
  const parsed = summarizeTurnReviewPatch(patch);
  const files: TurnReviewSummary['files'] = new Map();
  for (const row of filesInput) {
    const name = String(row?.path || '');
    if (!name) continue;
    const parsedEntry = parsed.files.get(name) || (row.oldPath ? parsed.files.get(String(row.oldPath)) : undefined);
    const additions = typeof row.additions === 'number' ? row.additions : 0;
    const deletions = typeof row.deletions === 'number' ? row.deletions : 0;
    files.set(name, {
      additions,
      deletions,
      lineStats: additions + deletions > 0,
      status: String(row.status || parsedEntry?.status || 'M'),
      binary: row.binary === true || parsedEntry?.binary === true,
      parts: parsedEntry?.parts || [],
    });
  }
  return turnReviewSummaryOf(files);
}

function mergeTurnReviewSummaries(summaries: TurnReviewSummary[]): TurnReviewSummary {
  const files: TurnReviewSummary['files'] = new Map();
  let additions = 0;
  let deletions = 0;
  for (const summary of summaries) {
    additions += summary.additions;
    deletions += summary.deletions;
    for (const [name, entry] of summary.files) {
      const merged = files.get(name) || {
        additions: 0,
        deletions: 0,
        lineStats: false,
        status: '',
        binary: false,
        parts: [],
      };
      merged.additions += entry.additions;
      merged.deletions += entry.deletions;
      merged.lineStats ||= entry.lineStats;
      merged.status ||= entry.status;
      merged.binary ||= entry.binary;
      merged.parts.push(...entry.parts);
      files.set(name, merged);
    }
  }
  return {
    files,
    additions,
    deletions,
    hasLineStats: summaries.some((summary) => summary.hasLineStats),
  };
}

function statusLabel(entry: TurnReviewFileEntry): string {
  if (entry.binary) return t('Binary');
  if (entry.status === 'R') return t('Renamed');
  if (entry.status === 'C') return t('Copied');
  if (entry.status === 'A') return t('Added');
  if (entry.status === 'D') return t('Deleted');
  if (entry.status === 'T') return t('Metadata');
  return t('Changed');
}

/** The review state the shared cache holds for one turn scope. */
function cachedTurnReviewState(scopeKey: string) {
  return {
    scopeKey,
    reviews: agentReviewCache.get(scopeKey) || [],
    leadPatch: leadReviewCache.get(scopeKey) ?? null,
    files: leadReviewFilesCache.get(scopeKey) || [],
    snapshotKind: leadReviewSnapshotKindCache.get(scopeKey) || '',
    checkpointId: leadReviewCheckpointIdCache.get(scopeKey) || '',
  };
}

function statusCode(entry: TurnReviewFileEntry): string {
  const status = String(entry.status || '').toUpperCase();
  if (['A', 'D', 'M', 'R', 'C', 'T'].includes(status)) return status;
  if (entry.binary) return 'B';
  return entry.lineStats ? 'M' : '';
}

// Single-quoted so the capability-inventory source scan counts this surface.
const TURN_REVIEW_CAPABILITY = 'getTurnReviewDiff';
/** Longest a session entry holds the bar for its first authoritative read. */
const ENTRY_REVIEW_HOLD_MS = 500;

function toolPublishesPatch(item: TranscriptItem): boolean {
  const categories = item.categories;
  if (categories && typeof categories === 'object' && Object.hasOwn(categories, 'Patch')) return true;
  return classifyToolCategory(String(item.name || ''), item.args) === 'Patch';
}

function summarizeTurnReviewOperations(items: TranscriptItem[], turnStart: number) {
  let additions = 0;
  let deletions = 0;
  for (let index = turnStart + 1; index < items.length; index++) {
    const item = items[index];
    if (item?.kind !== 'tool' || !toolPublishesPatch(item)) continue;
    const count = Math.max(1, Number(item.count || 1));
    if (item.isError === true || Number(item.errorCount || 0) >= count) continue;
    if (parseToolArgs(item.args)?.dry_run === true) continue;
    const result = item.result ?? item.rawResult ?? '';
    const summaryText = item.aggregate
      ? String(result)
      : summarizeToolResult(String(item.name || ''), item.args, String(result), false) || '';
    const delta = parseLineDelta(summaryText);
    if (delta.seen) {
      additions += delta.added;
      deletions += delta.removed;
      continue;
    }
    const patch = findPatch(item);
    if (!patch) continue;
    try {
      for (const analyzed of analyzeTurnReviewPatch(patch)) {
        additions += analyzed.additions;
        deletions += analyzed.deletions;
      }
    } catch {
      /* malformed/non-diff payload — skip */
    }
  }
  return {
    additions,
    deletions,
    hasLineStats: additions + deletions > 0,
  };
}

type TurnReviewCapabilityValue = {
  /** The review is exactly the one tagged `etag` the bar already holds. */
  unchanged?: boolean;
  etag?: unknown;
  supported?: boolean;
  authoritative?: boolean;
  snapshotKind?: unknown;
  revertMode?: unknown;
  checkpointId?: unknown;
  patch?: unknown;
  files?: Array<{
    path?: unknown;
    oldPath?: unknown;
    status?: unknown;
    additions?: unknown;
    deletions?: unknown;
    binary?: unknown;
  }>;
  agents?: Array<{
    sessionId?: unknown;
    agent?: unknown;
    tag?: unknown;
    patch?: unknown;
  }>;
} | null;

/** Narrowing of the turn-review capability reply. Everything the bar trusts
 *  passes through here, so an unsupported or malformed reply (null) can never
 *  reach state or the shared cache. */
function decodeTurnReviewCapabilityValue(value: TurnReviewCapabilityValue): {
  leadPatch: string | null;
  snapshotKind: string;
  checkpointId: string;
  files: TurnReviewFile[];
  reviews: AgentTurnReview[];
} | null {
  if (!value || value.supported === false) return null;
  const authoritative = value.authoritative === true;
  const patchText = typeof value.patch === 'string' ? value.patch : '';
  const leadPatch = authoritative ? patchText : null;
  const snapshotKind = authoritative ? String(value.snapshotKind || '') : '';
  const checkpointId = authoritative ? String(value.checkpointId || '') : '';
  const files = (authoritative && Array.isArray(value.files) ? value.files : []).flatMap((row) => {
    const path = String(row?.path || '');
    if (!path) return [];
    return [
      {
        path,
        oldPath: row?.oldPath ? String(row.oldPath) : null,
        status: row?.status ? String(row.status) : 'M',
        additions: typeof row?.additions === 'number' ? row.additions : null,
        deletions: typeof row?.deletions === 'number' ? row.deletions : null,
        binary: row?.binary === true,
      },
    ];
  });
  const reviews = (Array.isArray(value.agents) ? value.agents : []).flatMap((review) => {
    const childSessionId = String(review?.sessionId || '');
    const patch = typeof review?.patch === 'string' ? review.patch : '';
    if (!childSessionId || !patch) return [];
    return [
      {
        sessionId: childSessionId,
        agent: review?.agent ? String(review.agent) : null,
        tag: review?.tag ? String(review.tag) : null,
        patch,
      },
    ];
  });
  return { leadPatch, snapshotKind, checkpointId, files, reviews };
}

/** Collapsed headline (file count, line stats, attribution) plus the diff
 *  style toggle the expanded bar owns. */
function turnReviewHead({
  expanded,
  setExpanded,
  setOpenFile,
  setConfirmFile,
  setRevertError,
  summary,
  headlineStats,
  transcriptSummary,
  agentSummary,
  agentSources,
  authoritativeWorktreeSnapshot,
  diffStyle,
  setDiffStyle,
}: {
  expanded: boolean;
  setExpanded: Dispatch<SetStateAction<boolean>>;
  setOpenFile(value: string): void;
  setConfirmFile(value: string): void;
  setRevertError(value: string): void;
  summary: TurnReviewSummary;
  headlineStats: { hasLineStats: boolean; additions: number; deletions: number };
  transcriptSummary: TurnReviewSummary;
  agentSummary: TurnReviewSummary;
  agentSources: Array<{ key: string; label: string; summary: TurnReviewSummary }>;
  authoritativeWorktreeSnapshot: boolean;
  diffStyle: 'unified' | 'split';
  setDiffStyle(style: 'unified' | 'split'): void;
}) {
  return (
    <div className="turn-review-head">
      <button
        type="button"
        className="turn-review-summary"
        aria-expanded={expanded}
        onClick={() =>
          setExpanded((value) => {
            const next = !value;
            // Collapsing also closes any open inline diff/confirm so reopening
            // starts from the tidy list, not a tall stale diff.
            if (!next) {
              setOpenFile('');
              setConfirmFile('');
              setRevertError('');
            }
            return next;
          })
        }
      >
        <FileDiff size={14} aria-hidden="true" />
        <strong>
          {summary.files.size === 1 ? t('1 file changed') : t('{{count}} files changed', { count: summary.files.size })}
        </strong>
        {/* The counters belong to the TITLE, not to the (now removed)
            expander side of the row. */}
        {headlineStats.hasLineStats && (
          <span className="diff-stats">
            {headlineStats.additions > 0 && <i>+{headlineStats.additions}</i>}
            {headlineStats.deletions > 0 && <em>-{headlineStats.deletions}</em>}
          </span>
        )}
        {agentSources.length > 0 && (
          <span className="turn-review-attribution">
            {authoritativeWorktreeSnapshot
              ? t('Agents {{agents}} attributed', { agents: agentSummary.files.size })
              : t('Lead {{lead}} · Agents {{agents}}', {
                  lead: transcriptSummary.files.size,
                  agents: agentSummary.files.size,
                })}
          </span>
        )}
      </button>
      {expanded && (
        <div className="turn-review-controls">
          <div className="review-style-toggle turn-review-style" role="radiogroup" aria-label={t('Diff style')}>
            <button type="button" aria-pressed={diffStyle === 'unified'} onClick={() => setDiffStyle('unified')}>
              {t('Unified')}
            </button>
            <button type="button" aria-pressed={diffStyle === 'split'} onClick={() => setDiffStyle('split')}>
              {t('Split')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Per-file revert to the start of the turn, behind an explicit confirm step.
 *  The runtime decides at click time; a refusal is surfaced, never swallowed. */
function turnReviewRevertControl({
  name,
  rel,
  confirming,
  canRevertFile,
  sessionId,
  requestedCheckpointId,
  turnBoundaryKey,
  setConfirmFile,
  setRevertError,
  setReverted,
  setRevertedBoundary,
  refreshAgentReviews,
}: {
  name: string;
  rel: string;
  confirming: boolean;
  canRevertFile: boolean;
  sessionId: string | undefined;
  requestedCheckpointId: string;
  turnBoundaryKey: string;
  setConfirmFile(value: string): void;
  setRevertError(value: string): void;
  setReverted: Dispatch<SetStateAction<string[]>>;
  setRevertedBoundary(value: string): void;
  refreshAgentReviews(refreshWorktree?: boolean): Promise<void>;
}) {
  if (!confirming) {
    return (
      <button
        type="button"
        className="turn-review-revert"
        aria-label={t('Revert {{file}}', { file: rel })}
        data-tooltip={t('Revert file to turn start')}
        disabled={!canRevertFile}
        onClick={() => setConfirmFile(name)}
      >
        <Undo2 size={12} />
      </button>
    );
  }
  return (
    <span
      className="turn-review-confirm"
      role="group"
      aria-label={t('Confirm reverting {{file}} to the start of this turn', { file: rel })}
    >
      <button
        type="button"
        className="turn-review-revert"
        aria-label={t('Cancel revert')}
        data-tooltip={t('Cancel')}
        onClick={() => setConfirmFile('')}
      >
        <X size={12} />
      </button>
      <button
        type="button"
        className="turn-review-revert danger"
        aria-label={t('Confirm revert of {{file}}', { file: rel })}
        data-tooltip={t('Revert to turn start')}
        onClick={() => {
          setConfirmFile('');
          setRevertError('');
          void window.mixdogDesktop
            .invokeCapability?.({
              capability: 'revertTurnReviewFile',
              args: [rel, requestedCheckpointId],
              sessionId,
            })
            .then(async () => {
              setReverted((current) => [...current, name]);
              setRevertedBoundary(turnBoundaryKey);
              await refreshAgentReviews();
            })
            .catch((reason: unknown) => setRevertError(errorMessageText(reason)));
        }}
      >
        <Check size={12} />
      </button>
    </span>
  );
}

/** One changed file: status, project-relative path, line stats, the open-file
 *  action, its revert slot, and the inline diff it discloses. */
function turnReviewFileRow({
  entry,
  rel,
  rowKey,
  isReverted,
  openFile,
  setOpenFile,
  cwd,
  onOpenFile,
  diffStyle,
  revertControl,
}: {
  entry: TurnReviewFileEntry;
  rel: string;
  rowKey: string;
  isReverted: boolean;
  openFile: string;
  setOpenFile: Dispatch<SetStateAction<string>>;
  cwd: string | undefined;
  onOpenFile: ((project: string, rel: string) => void) | undefined;
  diffStyle: 'unified' | 'split';
  revertControl: ReactNode;
}) {
  const code = statusCode(entry);
  const label = statusLabel(entry);
  return (
    <li key={rowKey} data-open={openFile === rowKey ? 'true' : 'false'} data-reverted={isReverted ? 'true' : 'false'}>
      <button
        type="button"
        className="turn-review-file"
        aria-expanded={openFile === rowKey}
        onClick={() => setOpenFile((current) => (current === rowKey ? '' : rowKey))}
      >
        <span className="turn-review-status" data-status={code} aria-label={label} data-tooltip={label}>
          {code}
        </span>
        <code>{rel}</code>
        {entry.lineStats && (
          <span className="diff-stats">
            <i>{entry.additions > 0 ? `+${entry.additions}` : ''}</i>
            <em>{entry.deletions > 0 ? `-${entry.deletions}` : ''}</em>
          </span>
        )}
        {!entry.lineStats && (
          <span className="diff-stats" aria-hidden="true">
            <i />
            <em />
          </span>
        )}
      </button>
      <span className="turn-review-action-slot">
        <button
          type="button"
          className="turn-review-open"
          aria-label={t('Open file {{file}}', { file: rel })}
          data-tooltip={t('Open file')}
          disabled={!cwd || !onOpenFile || (code === 'D' && !isReverted)}
          onClick={() => {
            if (cwd) onOpenFile?.(cwd, rel);
          }}
        >
          <FileText size={12} aria-hidden="true" />
        </button>
        {revertControl}
      </span>
      {openFile === rowKey && (
        <div className="turn-review-diff">
          {entry.parts.length > 0 ? (
            entry.parts.map((file, index) => <GitDiffBody key={`${rowKey}:${index}`} file={file} mode={diffStyle} />)
          ) : (
            <span className="turn-review-status">{t('Diff detail unavailable')}</span>
          )}
        </div>
      )}
    </li>
  );
}

export const TurnReviewBar = memo(function TurnReviewBar({
  items,
  cwd,
  sessionId,
  active = true,
  busy = false,
  onOpenFile,
}: {
  items: TranscriptItem[];
  cwd?: string;
  sessionId?: string;
  active?: boolean;
  busy?: boolean;
  onOpenFile?: (project: string, rel: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [openFile, setOpenFile] = useState('');
  // Whether the bar shows file bodies right now. A collapsed bar on a phone
  // asks for files and line counts only; opening it re-reads in full.
  const detailShown = useRef(false);
  detailShown.current = expanded || openFile !== '';
  const [confirmFile, setConfirmFile] = useState('');
  const [reverted, setReverted] = useState<string[]>([]);
  // A refused revert used to vanish into an empty catch, so a legitimate
  // runtime refusal was indistinguishable from a dead button.
  const [revertError, setRevertError] = useState('');
  // The turn boundary at which the last revert succeeded. Until a new tool
  // completes, the runtime's (now emptier) diff outranks the transcript's
  // per-edit uiDiff, which still describes the mutation that was just undone.
  const [revertedBoundary, setRevertedBoundary] = useState('');
  // An expanded review closes on the first pointer press OUTSIDE its own box.
  // Presses inside (rows, revert, diff style) keep it open, so the disclosure
  // never collapses under its own controls.
  const barElement = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!expanded) return undefined;
    const closeOnOutsidePointer = (event: Event) => {
      const element = barElement.current;
      const target = event.target as Node | null;
      if (!element || (target && element.contains(target))) return;
      setExpanded(false);
      setOpenFile('');
      setConfirmFile('');
      setRevertError('');
    };
    window.addEventListener('pointerdown', closeOnOutsidePointer, true);
    return () => window.removeEventListener('pointerdown', closeOnOutsidePointer, true);
  }, [expanded]);
  // A long turn's prompt row can fall out of the transcript tail the daemon
  // sends. The rows left are still that turn, so it keeps its scope: the
  // shared `none` scope held an unrelated earlier review and skipped the
  // checkpoint check (user: 컴포저 위 디프가 엉뚱한 숫자가 나왔다 사라짐).
  const reviewSession = String(sessionId || 'draft');
  const rememberedScope = useRef<{ session: string; key: string } | null>(null);
  const reviewScope = useMemo(() => {
    const scope = turnReviewScope(items);
    if (!scope.truncated) {
      if (scope.key !== 'none') rememberedScope.current = { session: reviewSession, key: scope.key };
      return scope;
    }
    const remembered = rememberedScope.current;
    return remembered?.session === reviewSession ? { ...scope, key: remembered.key } : scope;
  }, [items, reviewSession]);
  const turnScopeKey = `${String(sessionId || 'draft')}:${reviewScope.key}`;
  const activeScope = useRef(turnScopeKey);
  activeScope.current = turnScopeKey;
  const [agentReviewState, setAgentReviewState] = useState<{
    scopeKey: string;
    reviews: AgentTurnReview[];
    leadPatch: string | null;
    files: TurnReviewFile[];
    snapshotKind: string;
    checkpointId: string;
  }>(() => cachedTurnReviewState(turnScopeKey));
  // Keying the read as well as the write prevents a one-frame stale bar before
  // effects run when the user switches sessions or opens New task.
  const reviewState =
    agentReviewState.scopeKey === turnScopeKey ? agentReviewState : cachedTurnReviewState(turnScopeKey);
  const agentReviews = reviewState.reviews;
  const authoritativeLeadPatch = reviewState.leadPatch;
  const authoritativeLeadFiles = reviewState.files;
  const authoritativeSnapshotKind = reviewState.snapshotKind;
  const authoritativeCheckpointId = reviewState.checkpointId;
  // A recorded ("scoped") review is the same Git diff as a live worktree
  // baseline, only limited to the session's own paths, so its file list is
  // trusted the same way. Otherwise a revert served from the record left the
  // transcript's stale diff on screen and looked like nothing had happened.
  const authoritativeWorktreeSnapshot =
    authoritativeSnapshotKind === 'worktree' || authoritativeSnapshotKind === 'scoped';
  const capabilityRequestInFlight = useRef(false);
  // The read issued in the current synchronous pass (one commit's effects),
  // cleared at the next microtask.
  const sameCommitRequest = useRef<{ scopeKey: string; boundaryKey: string; refreshWorktree: boolean } | null>(
    null
  );
  const pendingCapabilityRefresh = useRef<{
    scopeKey: string;
    refreshWorktree: boolean;
  } | null>(null);
  const refreshAgentReviewsRef = useRef<(refreshWorktree?: boolean) => Promise<void>>(async () => undefined);
  const lastAgentReviewSignature = useRef<string | null>(null);
  useEffect(() => {
    pendingCapabilityRefresh.current = null;
    lastAgentReviewSignature.current = null;
    setExpanded(false);
    setOpenFile('');
    setConfirmFile('');
    setReverted([]);
    setRevertedBoundary('');
  }, [turnScopeKey]);
  // Only probe once the transcript shows turn activity: a fresh/empty session
  // has no child review and passive mounts must not fire capability calls.
  const hasTurnActivity = reviewScope.hasActivity;
  // Entering a session with no read for its turn yet shows no bar until the
  // first authoritative read answers. The transcript estimate also counts
  // edits outside the worktree: it painted "1 file changed" on entry, the read
  // removed it ~1s later and the transcript dropped by the bar's height (user:
  // 세션 처음 열 때 잔상이 남았다가 툭 튄다). A cached read answers in tens of
  // milliseconds, so the bar lands with the transcript; a slow read falls back
  // to the estimate. A live turn in a session already answered never waits.
  const [answeredSession, setAnsweredSession] = useState('');
  const entryPending =
    Boolean(sessionId) &&
    active &&
    hasTurnActivity &&
    answeredSession !== reviewSession &&
    !leadReviewSnapshotKindCache.has(turnScopeKey);
  const entryPendingRef = useRef(entryPending);
  entryPendingRef.current = entryPending;
  useEffect(() => {
    if (!entryPending) return undefined;
    const timer = window.setTimeout(() => setAnsweredSession(reviewSession), ENTRY_REVIEW_HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [entryPending, reviewSession]);
  // Refresh on turn boundaries, not every streaming transcript publication.
  const turnBoundaryKey = useMemo(() => {
    for (let index = items.length - 1; index >= 0; index--) {
      const item = items[index];
      if (!item) continue;
      if (item.kind === 'turndone' || item.kind === 'statusdone' || item.kind === 'tool') {
        return `${String(item.id ?? index)}:${String(item.completedAt ?? item.completedCount ?? '')}`;
      }
    }
    return '';
  }, [items]);
  const reviewBoundaryKey = JSON.stringify([turnScopeKey, turnBoundaryKey, busy]);
  const refreshAgentReviews = useCallback(
    async (refreshWorktree = false) => {
      const api = window.mixdogDesktop as
        | {
            invokeCapability?: (request: {
              capability: string;
              args: unknown[];
              sessionId?: string;
            }) => Promise<{ value?: unknown }>;
          }
        | undefined;
      const requestedScope = turnScopeKey;
      const requestedCheckpoint = reviewScope.key;
      if (!sessionId || !api?.invokeCapability) return;
      if (document.visibilityState === 'hidden') return;
      if (capabilityRequestInFlight.current) {
        // The boundary effect and the busy poll both ask when one commit moves
        // a boundary: the read already sent for it answers both, so a queued
        // follow-up would only repeat it.
        const issued = sameCommitRequest.current;
        if (
          issued?.scopeKey === requestedScope &&
          issued.boundaryKey === reviewBoundaryKey &&
          (issued.refreshWorktree || !refreshWorktree)
        ) {
          return;
        }
        const pending = pendingCapabilityRefresh.current;
        pendingCapabilityRefresh.current = {
          scopeKey: requestedScope,
          refreshWorktree: refreshWorktree || (pending?.scopeKey === requestedScope && pending.refreshWorktree),
        };
        return;
      }
      capabilityRequestInFlight.current = true;
      const issued = { scopeKey: requestedScope, boundaryKey: reviewBoundaryKey, refreshWorktree };
      sameCommitRequest.current = issued;
      queueMicrotask(() => {
        if (sameCommitRequest.current === issued) sameCommitRequest.current = null;
      });
      try {
        // This bar belongs to the pane's session. During a tab switch the host's
        // focused view can already point elsewhere, so omitting this address
        // mixed another turn's diff into the bar and could hit a stale view.
        // The tag lives with the cached review it names, so `unchanged` is only
        // ever asked for a review this scope still holds.
        // A `none` scope names no turn, so nothing read under it is kept for
        // a later mount to show as its own review.
        const cacheable = requestedCheckpoint !== 'none';
        const known = cacheable ? (reviewTagCache.get(requestedScope) ?? '') : '';
        // Over the relay the patch text is most of each re-read; the collapsed
        // bar never draws it. The desktop's local IPC keeps full reads.
        const summary = isMobileRemoteSurface() && !detailShown.current;
        const result = await api.invokeCapability({
          capability: TURN_REVIEW_CAPABILITY,
          args: [{ refresh: refreshWorktree, ...(known ? { known } : {}), ...(summary ? { summary } : {}) }],
          sessionId,
        });
        const value = (result?.value ?? null) as TurnReviewCapabilityValue;
        if (value?.unchanged === true) return;
        const decoded = decodeTurnReviewCapabilityValue(value);
        if (!decoded) {
          return;
        }
        const { leadPatch, snapshotKind, checkpointId, files, reviews } = decoded;
        // Until the runtime opens the new turn (and before its first tool),
        // it still answers with the previous turn's review. Shown under the
        // new prompt, that brought the old diff back above the composer.
        if (checkpointId && requestedCheckpoint !== 'none' && checkpointId !== requestedCheckpoint) return;
        const signature = JSON.stringify([leadPatch, files, snapshotKind, checkpointId, reviews]);
        if (cacheable) {
          rememberAgentReviews(
            requestedScope,
            reviews,
            leadPatch,
            files,
            snapshotKind,
            checkpointId,
            typeof value?.etag === 'string' ? value.etag : ''
          );
        }
        if (lastAgentReviewSignature.current === signature) return;
        lastAgentReviewSignature.current = signature;
        if (activeScope.current === requestedScope) {
          setAgentReviewState({
            scopeKey: requestedScope,
            reviews,
            leadPatch,
            files,
            snapshotKind,
            checkpointId,
          });
        }
      } catch {
        // The next turn boundary, visibility change, expansion, or bounded idle
        // refresh retries. A transient read must never permanently lock Revert.
      } finally {
        if (activeScope.current === requestedScope) setAnsweredSession(String(sessionId));
        capabilityRequestInFlight.current = false;
        const pending = pendingCapabilityRefresh.current;
        pendingCapabilityRefresh.current = null;
        if (pending && activeScope.current === pending.scopeKey) {
          void refreshAgentReviewsRef.current(pending.refreshWorktree);
        }
      }
    },
    [sessionId, turnScopeKey, reviewScope.key, reviewBoundaryKey]
  );
  refreshAgentReviewsRef.current = refreshAgentReviews;
  useEffect(() => {
    // A tool/turn boundary is the authoritative point at which the visible
    // count must catch up. If an older request is still running, the callback
    // above coalesces this into one mandatory follow-up refresh instead of
    // dropping the final file set and leaving an earlier count on screen.
    if (active && hasTurnActivity) {
      // An idle entry asks the runtime's held snapshot first (fast), then the
      // fresh worktree read queues behind it.
      if (entryPendingRef.current && !busy) void refreshAgentReviews(false);
      void refreshAgentReviews(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- turnBoundaryKey stands in for items
  }, [active, busy, refreshAgentReviews, hasTurnActivity, turnBoundaryKey]);
  useEffect(() => {
    if (!active || (!hasTurnActivity && agentReviews.length === 0)) return undefined;
    // While a turn is active (or the review is open), keep the display fresh.
    // Once idle, use a bounded backoff window to catch a late child completion
    // without leaving every mounted session on a permanent six-second poll.
    if (busy || expanded) {
      void refreshAgentReviews(true);
      // Every tool/turn boundary already re-reads (effect above). On a phone
      // each timed re-read of a working turn moves its whole diff over the
      // relay and re-diffs the desktop worktree, so the timer only backstops.
      const timer = window.setInterval(
        () => {
          void refreshAgentReviews(true);
        },
        isMobileRemoteSurface() ? 30_000 : 6_000
      );
      return () => window.clearInterval(timer);
    }
    const delays = [6_000, 12_000, 24_000, 48_000];
    let index = 0;
    let timer = 0;
    const schedule = () => {
      if (index >= delays.length) return;
      timer = window.setTimeout(() => {
        index += 1;
        void refreshAgentReviews(false);
        schedule();
      }, delays[index]);
    };
    schedule();
    return () => window.clearTimeout(timer);
  }, [active, busy, expanded, refreshAgentReviews, hasTurnActivity, agentReviews.length, turnBoundaryKey]);
  // The bar's own persisted Unified/Split choice, separate from the Source
  // Control and Session Diff tabs (user: 3개 분리 저장).
  const [diffStyle, setDiffStyle] = useState<'unified' | 'split'>(() => readDiffStyle(TURN_REVIEW_DIFF_STYLE_KEY));
  useEffect(() => {
    writeDiffStyle(TURN_REVIEW_DIFF_STYLE_KEY, diffStyle);
  }, [diffStyle]);
  const transcriptSummary = useMemo(() => {
    const patches: string[] = [];
    let latestUiDiff: string | null = null;
    for (let index = reviewScope.startIndex + 1; index < items.length; index++) {
      const item = items[index];
      if (item?.kind !== 'tool') continue;
      if (Object.hasOwn(item, 'uiDiff')) {
        latestUiDiff = typeof item.uiDiff === 'string' ? item.uiDiff : '';
        continue;
      }
      const count = Math.max(1, Number(item.count || 1));
      const failed = item.isError === true || Number(item.errorCount || 0) >= count;
      if (failed) continue;
      // Shell/test output can legitimately contain `@@` or a printed unified
      // diff. It is evidence to show inside that tool row, not evidence that
      // the tool changed files. Shell mutations arrive through the
      // authoritative worktree snapshot instead.
      if (!toolPublishesPatch(item)) continue;
      const patch = findPatch(item);
      if (typeof patch !== 'string' || !patch) continue;
      patches.push(patch);
    }
    // The completed tool item is published in the same frame as the mutation
    // and therefore beats the polled capability snapshot during rapid,
    // same-card edits. An explicit empty uiDiff is authoritative too: it means
    // the latest apply_patch restored the turn baseline.
    if (authoritativeWorktreeSnapshot) {
      return summarizeAuthoritativeTurnReview(authoritativeLeadFiles, authoritativeLeadPatch || '');
    }
    // After a revert the transcript's uiDiff is exactly the change that was
    // undone, so the runtime's exact-tracker diff wins until the next tool
    // completes and moves the boundary.
    const afterRevert =
      revertedBoundary !== '' && revertedBoundary === turnBoundaryKey && authoritativeLeadPatch !== null;
    // A collapsed phone bar got the tracker's counts as files, without the
    // patch text; they stand in wherever that patch would have been read.
    const trackerCountsOnly =
      authoritativeSnapshotKind === 'tool' && !authoritativeLeadPatch && authoritativeLeadFiles.length > 0;
    if (trackerCountsOnly && (afterRevert || latestUiDiff === null)) {
      return summarizeAuthoritativeTurnReview(authoritativeLeadFiles, '');
    }
    return summarizeTurnReviewPatch(
      afterRevert ? authoritativeLeadPatch : (latestUiDiff ?? authoritativeLeadPatch ?? patches.join('\n'))
    );
  }, [
    authoritativeLeadFiles,
    authoritativeLeadPatch,
    authoritativeSnapshotKind,
    authoritativeWorktreeSnapshot,
    items,
    reviewScope.startIndex,
    revertedBoundary,
    turnBoundaryKey,
  ]);
  const agentSources = useMemo(
    () =>
      agentReviews.flatMap((review, index) => {
        const reviewSummary = summarizeTurnReviewPatch(review.patch);
        if (reviewSummary.files.size === 0) return [];
        const label =
          review.tag && review.agent && review.tag !== review.agent
            ? `${review.tag} · ${review.agent}`
            : review.tag || review.agent || '';
        return [
          {
            key: `${review.sessionId}:${index}`,
            label,
            summary: reviewSummary,
          },
        ];
      }),
    [agentReviews]
  );
  const agentSummary = useMemo(
    () => mergeTurnReviewSummaries(agentSources.map((source) => source.summary)),
    [agentSources]
  );
  const summary = useMemo(
    () =>
      authoritativeWorktreeSnapshot ? transcriptSummary : mergeTurnReviewSummaries([transcriptSummary, agentSummary]),
    [transcriptSummary, agentSummary, authoritativeWorktreeSnapshot]
  );
  const operationSummary = useMemo(
    () => summarizeTurnReviewOperations(items, reviewScope.startIndex),
    [items, reviewScope.startIndex]
  );
  // The file set and expanded rows remain the authoritative turn-start → current
  // diff. The collapsed headline mirrors the activity cards' edit workload so
  // replaced/deleted intermediate lines do not disappear into a net +N count.
  // A truncated transcript holds only part of the turn's edits, so its
  // workload count is partial; the review's own totals stand in.
  const headlineStats = operationSummary.hasLineStats && !reviewScope.truncated ? operationSummary : summary;
  const sources = useMemo(() => {
    const transcriptSource = {
      key: authoritativeWorktreeSnapshot ? 'turn' : 'lead',
      label: authoritativeWorktreeSnapshot ? 'Turn' : 'Lead',
      summary: transcriptSummary,
    };
    return [...(transcriptSummary.files.size > 0 ? [transcriptSource] : []), ...agentSources];
  }, [transcriptSummary, agentSources, authoritativeWorktreeSnapshot]);
  const reviewVisible = !entryPending && summary.files.size > 0;
  const requestedCheckpointId = reviewScope.key === 'none' ? authoritativeCheckpointId : reviewScope.key;
  const checkpointMatches = !authoritativeCheckpointId || authoritativeCheckpointId === requestedCheckpointId;
  // Revert availability is decided by the runtime at click time. A transient
  // or stale capability read must not permanently disable an otherwise valid
  // checkpoint, but a known ID mismatch is never allowed to hit another turn.
  const canRevertTurn = Boolean(cwd && sessionId && requestedCheckpointId && checkpointMatches);
  // Tool patches sometimes carry ABSOLUTE paths; display and revert use the
  // project-relative form (git confinement expects it).
  const normalizedCwd = String(cwd || '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '');
  // A bar that appears while the transcript is on screen opens its slot over
  // the dock motion; one already there when a session is entered lands at full
  // height. The opening runs once, on appearance: a CSS animation gated on the
  // entry flag replayed its unfinished part the moment the flag dropped, and
  // the freshly revealed transcript slid up again (user: 웹앱에서 트랜스크립트가
  // 위아래로 튄다). Removal stays instant.
  useLayoutEffect(() => {
    if (!reviewVisible) return undefined;
    const slot = barElement.current?.closest<HTMLElement>('.turn-review-slot');
    const opening = slot ? openDockSlot(slot) : null;
    return () => opening?.cancel();
  }, [reviewVisible]);
  // The prior turn's review must leave at the next user boundary. Conversation
  // reserves geometry only after the CURRENT turn actually touches files, so
  // carrying an empty review row through every busy turn creates a fixed black
  // gap above the composer while new output streams above it.
  // An undecided entry holds the conversation's reveal (use-transcript-reveal).
  if (!reviewVisible) return entryPending ? <span hidden data-entry-pending /> : null;
  return (
    <section
      ref={barElement}
      className="turn-review-bar"
      aria-label={t('Files changed this turn')}
      data-expanded={expanded ? 'true' : 'false'}
    >
      {turnReviewHead({
        expanded,
        setExpanded,
        setOpenFile,
        setConfirmFile,
        setRevertError,
        summary,
        headlineStats,
        transcriptSummary,
        agentSummary,
        agentSources,
        authoritativeWorktreeSnapshot,
        diffStyle,
        setDiffStyle,
      })}
      {/* A refusal stays OUTSIDE the disclosure so its reason is readable
          without expanding the bar. */}
      {revertError && <ErrorNotice error={revertError} />}
      <div className="turn-review-collapse" inert={!expanded} aria-hidden={!expanded}>
        <div className="turn-review-collapse-inner">
          <ul className="turn-review-files">
            {sources.flatMap((source) => {
              const sourceHeader = (
                <li key={`${source.key}:source`} className="turn-review-source">
                  {/* Turn/Lead are catalog keys; agent tags are user data, never keys. */}
                  <strong>
                    {source.key === 'turn' || source.key === 'lead' ? t(source.label) : source.label || t('Agent')}
                  </strong>
                  <span className="diff-stats" aria-hidden={!source.summary.hasLineStats}>
                    <i>{source.summary.additions > 0 ? `+${source.summary.additions}` : ''}</i>
                    <em>{source.summary.deletions > 0 ? `-${source.summary.deletions}` : ''}</em>
                  </span>
                </li>
              );
              const rows = [...source.summary.files.entries()].map(([name, entry]) => {
                const normalizedName = name.replace(/\\/g, '/');
                const rel =
                  normalizedCwd && normalizedName.toLowerCase().startsWith(`${normalizedCwd.toLowerCase()}/`)
                    ? normalizedName.slice(normalizedCwd.length + 1)
                    : normalizedName;
                const rowKey = `${source.key}:${name}`;
                const isReverted = reverted.includes(name);
                const confirming = confirmFile === name;
                const ownFile = source.key === 'turn' || source.key === 'lead';
                const canRevertFile = ownFile && canRevertTurn && !busy && !isReverted;
                return turnReviewFileRow({
                  entry,
                  rel,
                  rowKey,
                  isReverted,
                  openFile,
                  setOpenFile,
                  cwd,
                  onOpenFile,
                  diffStyle,
                  revertControl:
                    ownFile && !isReverted
                      ? turnReviewRevertControl({
                          name,
                          rel,
                          confirming,
                          canRevertFile,
                          sessionId,
                          requestedCheckpointId,
                          turnBoundaryKey,
                          setConfirmFile,
                          setRevertError,
                          setReverted,
                          setRevertedBoundary,
                          refreshAgentReviews,
                        })
                      : null,
                });
              });
              return [sourceHeader, ...rows];
            })}
          </ul>
        </div>
      </div>
    </section>
  );
});
