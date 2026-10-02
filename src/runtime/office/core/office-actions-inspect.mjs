import { copyFile, rm } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { callMicrosoftOffice } from '../com/com-adapter.mjs';
import { issuesPortableOoxml, validateLibreOfficeReopen, validatePortableOoxml } from '../portable/portable-ooxml.mjs';
import { issuesPdf, validatePdf } from '../pdf/pdf-adapter.mjs';
import { validateOoxmlSchema } from '../portable/ooxml-validator.mjs';
import { evaluateXlsxAssertions } from '../portable/xlsx-assertions.mjs';
import { mergeXlsxFormulaAudit } from '../portable/xlsx-formula-audit.mjs';
import { pictureDescriptionIssues } from '../portable/portable-validation.mjs';
import { workbookSheets } from '../portable/portable-cells.mjs';
import { loadPackage } from '../portable/portable-opc.mjs';
import { cellInkIssues, columnFitIssues, protectedInputIssues } from '../portable/portable-sheet-audits.mjs';
import { issuesTabular, validateTabular } from './tabular.mjs';
import { evaluateOfficeSubmissionGate, normalizeOfficeReviewIssues } from '../quality/quality-pipeline.mjs';
import { reviewOfficeStructure } from '../quality/assurance.mjs';
import { OOXML_FORMATS, TABULAR_FORMATS } from './office-core.mjs';
import { readComSavedCopy, snapshot } from './office-sessions.mjs';

// A finding is the same finding wherever its code and path agree; the merges below drop the ones a result already holds.
const findingKey = (entry) => `${entry.code}\0${entry.path}`;
const knownFindings = (result) => new Set((result.issues || []).map(findingKey));

// One document read per document version for every review that needs the whole
// document: issues and qa both ask for it, and reading it twice per call costs
// the caller seconds on a large workbook.
const reviewSnapshots = new WeakMap();

export async function reviewSnapshot(session, args = {}) {
  const version = Number(session.snapshotVersion || 0);
  const cached = reviewSnapshots.get(session);
  if (cached && cached.version === version) return cached.read;
  const read = await snapshot(
    session,
    {
      ...args,
      includeStyles: true,
      limit: Math.min(100, Number(args.limit) || 100),
      maxChars: 100_000,
    },
    { full: true }
  );
  reviewSnapshots.set(session, { version, read });
  return read;
}

// What the format review owns — an orphan heading, a chart the page break cuts,
// a sheet with no reading order — is read from the document, not the package.
// Without it `issues` answered "ok, nothing found" for a file qa reports on.
async function structureIssues(session, args) {
  if (!OOXML_FORMATS.has(session.format)) return [];
  try {
    const read = await reviewSnapshot(session, args);
    if (!read?.document) return [];
    return reviewOfficeStructure({
      format: session.format,
      // A PDF's designed sheets are held to the print type floors (assurance-structure-pptx typeFloors).
      document: session.printSheet ? { ...read.document, printSheet: true } : read.document,
      auditProfile: args.auditProfile,
    });
  } catch {
    // A document the reader cannot open is already reported by the package
    // checks; the review simply has nothing to add.
    return [];
  }
}

// The Office host's own read of the document; null off the COM backend.
async function nativeValidation(session, args) {
  if (session.backend !== 'microsoft-office-com') return null;
  if (args.__skipNative === true) {
    return { ok: true, opened: true, issueCount: 0, issues: [], documentSaved: true, reusedReview: true };
  }
  const postSaveNativeValidation = args.__postSave === true || session.mode === 'background';
  const response = await callMicrosoftOffice(
    {
      action: postSaveNativeValidation ? 'post_save_validate' : 'validate',
      session: session.id,
      format: session.format,
      mode: session.mode,
      path: session.target,
      inspectIssues: args.__skipNativeIssues !== true,
      includeSnapshot: args.__skipNativeSnapshot !== true,
    },
    {
      signal: session.activeSignal || null,
      timeoutMs: postSaveNativeValidation ? 300_000 : undefined,
    }
  );
  if (!response.ok) throw new Error(response.error || 'Microsoft Office native validation failed');
  return response.value;
}

function packageValidation(session, args) {
  if (session.format === 'pdf') return validatePdf(session.target);
  if (TABULAR_FORMATS.has(session.format)) return validateTabular(session.target, session.format);
  return validatePortableOoxml(session.target, session.format, {
    original: session.source !== session.target ? session.source : '',
    savedBy: session.backend,
    auditProfile: args.auditProfile,
    author: args.author,
  });
}

// OOXML schema validation; the COM backend holds the file open, so the
// validator reads a copy.
async function schemaValidation(session, args) {
  if (!OOXML_FORMATS.has(session.format)) return null;
  let schemaCopy = '';
  try {
    if (session.backend === 'microsoft-office-com') {
      schemaCopy = join(tmpdir(), `mixdog-schema-${randomUUID()}${extname(session.target)}`);
      await copyFile(session.target, schemaCopy);
    }
    return await validateOoxmlSchema(schemaCopy || session.target, {
      dataDir: session.dataDir,
      download: args.downloadDependencies !== false,
      signal: session.activeSignal || null,
    });
  } catch (error) {
    return { available: false, ok: false, errors: [], reason: error?.message || String(error) };
  } finally {
    if (schemaCopy) await rm(schemaCopy, { force: true }).catch(() => {});
  }
}

async function assertionValidation(session, args) {
  if (!Array.isArray(args.assertions) || !args.assertions.length) return null;
  if (session.format !== 'xlsx') throw new Error('assertions are supported for XLSX sessions only');
  const asserted = await snapshot(session, { limit: 10_000, maxChars: 100_000, includeStyles: false }, { full: true });
  return evaluateXlsxAssertions(asserted.document, args.assertions);
}

export async function validate(session, args = {}) {
  const native = await nativeValidation(session, args);
  const packageResult = await packageValidation(session, args);
  const schema = await schemaValidation(session, args);
  const assertions = await assertionValidation(session, args);
  const compatibility =
    args.compatibility === true && OOXML_FORMATS.has(session.format)
      ? await validateLibreOfficeReopen(session.target, { signal: session.activeSignal || null })
      : null;
  const postSaveGate =
    native?.persisted != null
      ? evaluateOfficeSubmissionGate({
          issues: native?.issues || [],
          persisted: native?.persisted === true,
        })
      : null;
  return {
    session: session.id,
    mode: session.mode,
    backend: session.backend,
    path: session.target,
    ...packageResult,
    ok:
      packageResult.ok &&
      (!schema ||
        schema.ok ||
        schema.disabled === true ||
        (args.downloadDependencies === false && schema.downloadRequired === true)) &&
      (!assertions || assertions.ok) &&
      (!native || (native.ok && (session.mode === 'background' || native.documentSaved))) &&
      (!postSaveGate || postSaveGate.ok) &&
      (!compatibility?.available || compatibility.opened),
    schema,
    assertions,
    native,
    postSaveGate,
    compatibility,
  };
}

// PowerPoint's host reads what COM exposes: text bounds, a shape's own fill, fonts, edges. The measured
// read the portable backend runs on the package — vertical balance and hollow bands, contrast against the
// plane that actually covers a box, block spacing, stat labels, fragmentation, dead vector charts, chart
// package faults — never ran on a PowerPoint session, so the same deck passed on one backend and failed
// on the other. The live document is copied aside (never saved over the user's file) and read as a
// package; the host's own overflow verdict, measured by PowerPoint itself, stays authoritative.
const HOST_OWNED_PPTX_CODES = new Set(['text_overflow']);

// A saved copy's portable audits, started before the application's own issues pass. The host takes requests in
// order, so the copy is written first and its audits run in this process while the application answers: a deck's
// measured read (0.4-1 s) had followed PowerPoint's 1.7 s pass instead of overlapping it.
function auditSavedCopy(session, audit) {
  return readComSavedCopy(session, audit).then(
    (value) => ({ value }),
    (error) => ({ error })
  );
}

function mergeComPptxMeasuredRead(result, { value: measured, error }) {
  if (error) return { ...result, measuredRead: { status: 'unavailable', reason: error?.message || String(error) } };
  const seen = knownFindings(result);
  const added = (measured.issues || []).filter(
    (issue) => !HOST_OWNED_PPTX_CODES.has(String(issue.code || '')) && !seen.has(findingKey(issue))
  );
  if (!added.length) return { ...result, measuredRead: { status: 'merged', added: 0 } };
  const issues = normalizeOfficeReviewIssues([...(result.issues || []), ...added]);
  return {
    ...result,
    issues,
    issueCount: issues.length,
    ok: !issues.some((entry) => entry.severity === 'error'),
    measuredRead: { status: 'merged', added: added.length },
  };
}

// Excel's host reads a sample of the cells it shows (### in the first 32) and nothing of a protected sheet's
// validated cells, so a cut label, a figure run into the label beside it, ink nobody can see, a number cut below the
// sample, and a form nobody can type into passed on Excel while the portable audit reported them. The saved copy is
// read by the portable audits themselves; a number the host already saw cut in a column stays the host's finding.
const cellColumn = (path) =>
  /^\/sheet\[(.*)\]\/cell\[\$?([A-Z]+)\$?\d+\]$/
    .exec(String(path || ''))
    ?.slice(1)
    .join('\0');

function xlsxSheetAudits(session, args) {
  return auditSavedCopy(session, async (copy) => {
    const zip = await loadPackage(copy);
    const sheets = (await workbookSheets(zip)).filter((sheet) => !args.sheet || sheet.name === args.sheet);
    return [
      ...(await columnFitIssues(zip, sheets)),
      ...(await protectedInputIssues(zip, sheets)),
      ...(await cellInkIssues(zip, sheets)),
    ];
  });
}

function mergeXlsxSheetAudits(result, { value: found, error }) {
  if (error) return { ...result, sheetAudit: { status: 'unavailable', reason: error?.message || String(error) } };
  const known = knownFindings(result);
  const overflowing = new Set(
    (result.issues || []).filter((entry) => entry.code === 'cell_overflow').map((entry) => cellColumn(entry.path))
  );
  const added = found.filter(
    (entry) =>
      !known.has(findingKey(entry)) && !(entry.code === 'column_too_narrow' && overflowing.has(cellColumn(entry.path)))
  );
  if (!added.length) return { ...result, sheetAudit: { status: 'merged', added: 0 } };
  return {
    ...result,
    issues: normalizeOfficeReviewIssues([...(result.issues || []), ...added]),
    sheetAudit: { status: 'merged', added: added.length },
  };
}

async function microsoftOfficeIssues(session, args) {
  let copyAudit = null;
  if (session.format === 'pptx') copyAudit = auditSavedCopy(session, (copy) => issuesPortableOoxml(copy, 'pptx', args));
  else if (session.format === 'xlsx') copyAudit = xlsxSheetAudits(session, args);
  const response = await callMicrosoftOffice(
    {
      action: 'issues',
      session: session.id,
      format: session.format,
      mode: session.mode,
      path: session.target,
      sheet: args.sheet,
      range: args.range,
      pages: args.pages,
      target: args.target,
      auditProfile: args.auditProfile,
    },
    {
      signal: session.activeSignal || null,
      timeoutMs: args.auditProfile === 'financial-model' ? 300_000 : undefined,
    }
  );
  if (!response.ok) throw new Error(response.error || 'Microsoft Office issue inspection failed');
  let result = response.value;
  // Excel's host reports its own subset; the shared formula audit reads the
  // same cells (cached for an owned background session) and adds the rest.
  if (session.format === 'xlsx') {
    const read = await snapshot(session, { includeStyles: true }, { full: true });
    result = mergeXlsxFormulaAudit(result, read?.document, { auditProfile: args.auditProfile, sheet: args.sheet });
    result = mergeXlsxSheetAudits(result, await copyAudit);
  }
  if (session.format === 'pptx') result = mergeComPptxMeasuredRead(result, await copyAudit);
  // Word's host audits no picture's description; its reading lists every picture with the one Word holds, so the
  // portable rule applies to it and an unlabelled figure no longer passes on Word alone.
  if (session.format === 'docx') {
    const read = await snapshot(session, {}, { full: true });
    const known = knownFindings(result);
    const added = pictureDescriptionIssues(read?.document || {}).filter((entry) => !known.has(findingKey(entry)));
    if (added.length) result = { ...result, issues: normalizeOfficeReviewIssues([...(result.issues || []), ...added]) };
  }
  return result;
}

function portableIssues(session, args) {
  if (session.format === 'pdf') return issuesPdf(session.target, args);
  if (TABULAR_FORMATS.has(session.format)) return issuesTabular(session.target, session.format, args);
  return issuesPortableOoxml(session.target, session.format, session.printSheet ? { ...args, printSheet: true } : args);
}

export async function issues(session, args = {}) {
  const result =
    session.backend === 'microsoft-office-com'
      ? await microsoftOfficeIssues(session, args)
      : await portableIssues(session, args);
  // A finding the package reader already made at the same place is the same finding worded twice: the portable
  // contrast measure (against the resolved surface) and the format review's (against the slide) both reported
  // "Hard to read" once the portable snapshot carried text colours. The package reader's, the more exact, stays.
  const found = knownFindings(result);
  const structural = (await structureIssues(session, args)).filter((entry) => !found.has(findingKey(entry)));
  // Normalized whether or not the structure review added anything: skipped when it found nothing, a portable deck's
  // overflow and overlap kept the warning the Office backend's copy of the same finding had been raised from.
  const merged = normalizeOfficeReviewIssues([...(result.issues || []), ...structural]);
  return {
    session: session.id,
    mode: session.mode,
    backend: session.backend,
    path: session.target,
    ...result,
    issues: merged,
    issueCount: merged.length,
    ok: !merged.some((entry) => entry.severity === 'error'),
  };
}
