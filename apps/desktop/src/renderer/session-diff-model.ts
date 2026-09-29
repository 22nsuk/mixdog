import { parseUnifiedDiff } from './renderer-logic.mjs';

type SessionDiffFile = {
  path?: unknown;
  oldPath?: unknown;
  status?: unknown;
  additions?: unknown;
  deletions?: unknown;
  binary?: unknown;
};

export type SessionDiffResult = {
  supported?: boolean;
  authoritative?: boolean;
  patch?: unknown;
  patchTruncated?: boolean;
  reason?: unknown;
  files?: SessionDiffFile[];
};

type SessionDiffPart = ReturnType<typeof parseUnifiedDiff>[number];

export type SessionDiffRow = {
  path: string;
  oldPath: string;
  status: string;
  additions: number;
  deletions: number;
  binary: boolean;
  parts: SessionDiffPart[];
};

function cleanPath(value: unknown): string {
  const path = String(value || '').replace(/\\/g, '/');
  return path.replace(/^(?:a|b)\//, '');
}

function partPath(part: SessionDiffPart): string {
  const next = cleanPath(part.newFile?.fileName);
  if (next && next !== '/dev/null') return next;
  const previous = cleanPath(part.oldFile?.fileName);
  return previous === '/dev/null' ? '' : previous;
}

function sumPartStats(parts: readonly SessionDiffPart[]): { additions: number; deletions: number } {
  return parts.reduce(
    (total, part) => {
      const stats = partStats(part);
      total.additions += stats.additions;
      total.deletions += stats.deletions;
      return total;
    },
    { additions: 0, deletions: 0 }
  );
}

function partStats(part: SessionDiffPart): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of part.hunks.join('\n').split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions += 1;
    else if (line.startsWith('-') && !line.startsWith('---')) deletions += 1;
  }
  return { additions, deletions };
}

function parsePatchParts(patch: string): SessionDiffPart[] {
  if (!patch) return [];
  try {
    return parseUnifiedDiff(patch);
  } catch {
    return [];
  }
}

/** The slice of a session review patch that belongs to ONE file (its parts
 *  re-joined as a unified diff), or "" when the patch has no part for it. */
export function sessionDiffFilePatch(patch: string, rel: string): string {
  const target = cleanPath(rel);
  if (!target) return '';
  return parsePatchParts(patch)
    .filter(
      (part) =>
        partPath(part) === target ||
        (cleanPath(part.oldFile?.fileName) === target && cleanPath(part.newFile?.fileName) === '/dev/null')
    )
    .map((part) => part.patch)
    .join('\n');
}

export function buildSessionDiffRows(result: SessionDiffResult | null): SessionDiffRow[] {
  const patch = typeof result?.patch === 'string' ? result.patch : '';
  const partsByPath = new Map<string, SessionDiffPart[]>();
  for (const part of parsePatchParts(patch)) {
    const path = partPath(part);
    if (!path) continue;
    const parts = partsByPath.get(path) || [];
    parts.push(part);
    partsByPath.set(path, parts);
  }
  const rows: SessionDiffRow[] = [];
  const seen = new Set<string>();
  for (const file of Array.isArray(result?.files) ? result.files : []) {
    const path = cleanPath(file?.path);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    const oldPath = cleanPath(file?.oldPath);
    const parts = partsByPath.get(path) || (oldPath ? partsByPath.get(oldPath) : undefined) || [];
    const measured = sumPartStats(parts);
    rows.push({
      path,
      oldPath,
      status: String(file?.status || parts[0]?.status || 'M').toUpperCase(),
      additions: typeof file?.additions === 'number' ? file.additions : measured.additions,
      deletions: typeof file?.deletions === 'number' ? file.deletions : measured.deletions,
      binary: file?.binary === true || parts.some((part) => part.status === 'binary'),
      parts,
    });
  }
  for (const [path, parts] of partsByPath) {
    if (seen.has(path)) continue;
    const measured = sumPartStats(parts);
    rows.push({
      path,
      oldPath: '',
      status: String(parts[0]?.status || 'M').toUpperCase(),
      additions: measured.additions,
      deletions: measured.deletions,
      binary: parts.some((part) => part.status === 'binary'),
      parts,
    });
  }
  return rows;
}
