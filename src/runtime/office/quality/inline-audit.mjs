// The measured read that rides on every mutating action. author and batch
// attach it so a fit, bounds, contrast, spacing, or package fault is visible in
// the turn that caused it, and the fix loop is counted where it happens: a
// failing audit is answered in the same turn, only a pass counts as done, and
// after two fix rounds the residue is reported instead of polished a third
// time. qa still owns the full review (design read, render read, checklist).
import { issues } from '../core/office-actions-inspect.mjs';
import { OOXML_FORMATS } from '../core/office-core.mjs';
import { normalizeOfficeReviewIssues } from './quality-pipeline.mjs';

export const INLINE_AUDIT_TOP = 12;
export const INLINE_AUDIT_MAX_ROUNDS = 2;

const LOCATION = /^\/(slide|page|sheet|body)(?:\[([^\]]+)\])?/;

// The unit a fix is addressed to: a slide, a sheet, a PDF page, the Word body,
// or the package itself.
function locationOf(path) {
  const match = LOCATION.exec(String(path || ''));
  if (!match) return { key: '/', label: 'document' };
  const [, kind, id] = match;
  if (kind === 'body') return { key: '/body', label: 'body' };
  const location = { key: `/${kind}[${id || ''}]`, label: id ? `${kind} ${id}` : kind };
  if (kind === 'slide' && /^\d+$/.test(id || '')) location.slide = Number(id);
  if (kind === 'page' && /^\d+$/.test(id || '')) location.page = Number(id);
  if (kind === 'sheet' && id) location.sheet = id;
  return location;
}

// The locations a batch touched, read from its operations, so the audit lists
// their defects first: what the author just changed is what the author is
// looking at.
export function touchedLocations(format, operations = []) {
  const keys = new Set();
  for (const operation of Array.isArray(operations) ? operations : []) {
    if (!operation || typeof operation !== 'object') continue;
    if (format === 'pptx') {
      if (Number(operation.slide) > 0) keys.add(`/slide[${Number(operation.slide)}]`);
      for (const slide of Array.isArray(operation.slides) ? operation.slides : []) {
        if (Number(slide) > 0) keys.add(`/slide[${Number(slide)}]`);
      }
    } else if (format === 'xlsx') {
      if (operation.sheet) keys.add(`/sheet[${String(operation.sheet)}]`);
    } else if (format === 'docx') {
      keys.add('/body');
    }
  }
  return [...keys];
}

function severityRank(severity) {
  if (severity === 'error') return 0;
  return severity === 'warning' ? 1 : 2;
}

export function summarizeOfficeAudit(issueList, { touched = [] } = {}) {
  const normalized = normalizeOfficeReviewIssues(issueList);
  const counts = { error: 0, warning: 0, info: 0 };
  const groups = new Map();
  const locationKeys = new Map();
  for (const issue of normalized) {
    // Only the three counted severities are severities: reading the key off
    // the prototype let "toString" or "constructor" through as one and
    // corrupted the counts and the location group it landed in.
    const severity = Object.hasOwn(counts, issue.severity) ? issue.severity : 'warning';
    counts[severity] += 1;
    const location = locationOf(issue.path);
    locationKeys.set(issue, location.key);
    const group = groups.get(location.key) || { ...location, error: 0, warning: 0, info: 0 };
    group[severity] += 1;
    groups.set(location.key, group);
  }
  const touchedKeys = new Set(touched.map(String));
  const isTouched = (issue) => touchedKeys.has(locationKeys.get(issue));
  // Advisory findings stay readable in qa; the audit lists only what a fix
  // must answer.
  const actionable = normalized.filter((issue) => issue.severity !== 'info');
  const top = [...actionable]
    .sort(
      (left, right) =>
        Number(isTouched(right)) - Number(isTouched(left)) ||
        severityRank(left.severity) - severityRank(right.severity) ||
        String(left.path).localeCompare(String(right.path))
    )
    .slice(0, INLINE_AUDIT_TOP)
    .map(({ severity, code, path, message }) => ({ severity, code, path, message }));
  const locations = [...groups.values()]
    .filter((group) => group.error || group.warning)
    .sort(
      (left, right) =>
        Number(touchedKeys.has(right.key)) - Number(touchedKeys.has(left.key)) ||
        right.error - left.error ||
        right.warning - left.warning ||
        left.key.localeCompare(right.key)
    )
    .map(({ key, ...group }) => group);
  return {
    status: actionable.length ? 'fail' : 'pass',
    counts,
    locations,
    top,
    truncated: Math.max(0, actionable.length - top.length),
  };
}

function nextActionFor(audit, format) {
  if (audit.status === 'pass') {
    if (audit.outsideEdit) {
      return `The edited slides pass. ${audit.outsideEdit} measured finding${audit.outsideEdit === 1 ? '' : 's'} sit on slides this batch did not touch and belong to the deck as opened; leave them unless the user asked for those pages. Continue to the render and the visual read.`;
    }
    return 'Audit passed: no measured defect remains. Continue to the render and the visual read; finalize needs both.';
  }
  const count = audit.counts.error + audit.counts.warning;
  if (['docx', 'xlsx', 'pdf'].includes(format)) {
    return `Inspect the ${count} reported finding${count === 1 ? '' : 's'} at their document locations. Fix material defects with targeted edits, then inspect the changed result. Keep automated diagnostics separate from visual judgement; neither a fixed round count nor a diagnostic pass decides design acceptance.`;
  }
  if (audit.round > INLINE_AUDIT_MAX_ROUNDS) {
    return `Audit still fails after ${INLINE_AUDIT_MAX_ROUNDS} fix rounds (${count} measured defect${count === 1 ? '' : 's'}). Stop polishing: report what remains with the deliverable instead of a further pass.`;
  }
  return `Fix the ${count} measured defect${count === 1 ? '' : 's'} in this same turn — re-author the script or batch the reported targets — and read the audit that call returns; only an audit pass counts as done (fix round ${audit.round} of ${INLINE_AUDIT_MAX_ROUNDS}).`;
}

// Rounds count consecutive failing audits on the same deck; a pass resets
// them. The counter lives on the session and is carried across a re-author
// that replaces the session, since the loop belongs to the deck.
export function recordInlineAuditRound(session, audit) {
  if (!audit || !session) return audit;
  session.inlineAudit ||= { rounds: 0 };
  session.inlineAudit.rounds = audit.status === 'pass' ? 0 : session.inlineAudit.rounds + 1;
  audit.round = session.inlineAudit.rounds;
  audit.nextAction = nextActionFor(audit, session.format);
  return audit;
}

// A mutation that landed is never failed by its audit: an inspection error is
// reported as unavailable so the author falls back to qa.
/**
 * @param {{ operations?: object[], exclude?: string[] }} options
 *   exclude: finding codes that do not apply to what the reader receives (a PDF the browser printed is not
 *   held to PowerPoint's text metrics)
 */
export async function inlineOfficeAudit(session, { operations = [], exclude = [] } = {}) {
  if (!session || !OOXML_FORMATS.has(session.format)) return null;
  let measured;
  try {
    measured = await issues(session, {});
  } catch (error) {
    return {
      status: 'unavailable',
      reason: error?.message || String(error),
      nextAction: 'The measured audit could not run on this change; call action:qa render:false before relying on it.',
    };
  }
  // A formula this batch wrote has no cached value until the next recalculation, and render, qa, and finalize
  // recalculate first: the audit reads it as pending, not as a defect to fix — every new portable model otherwise
  // failed its first audit with nothing the author could change. qa and issues still report it as found.
  const pending = (issue) => (issue?.code === 'formula_cache_missing' ? { ...issue, severity: 'info' } : issue);
  const touched = touchedLocations(session.format, operations);
  let list = (measured.issues || []).map(pending).filter((issue) => !exclude.includes(issue?.code));
  // A deck opened for editing — a template, a colleague's deck — is judged on the slides this batch edited: its
  // other pages are kept as they are, and a defect they already carried is not this edit's to fix. A structural
  // change renumbers the pages, so it reads the whole deck; so does an authored deck, every page of which is the
  // author's own. Findings on the package itself always count.
  let outsideEdit = 0;
  const scoped =
    session.format === 'pptx' &&
    session.authored !== true &&
    touched.length > 0 &&
    !operations.some((operation) => STRUCTURAL_SLIDE_OPERATIONS.has(operation?.op));
  if (scoped) {
    const keys = new Set(touched);
    const inScope = (issue) => {
      const key = locationOf(issue.path).key;
      return key === '/' || keys.has(key);
    };
    outsideEdit = list.filter((issue) => issue.severity !== 'info' && !inScope(issue)).length;
    list = list.filter(inScope);
  }
  const audit = summarizeOfficeAudit(list, { touched });
  if (outsideEdit) audit.outsideEdit = outsideEdit;
  return recordInlineAuditRound(session, audit);
}

const STRUCTURAL_SLIDE_OPERATIONS = new Set([
  'add_slide',
  'duplicate_slide',
  'delete_slide',
  'move_slide',
  'keep_slides',
  'import_slides',
  'use_template_page',
]);
