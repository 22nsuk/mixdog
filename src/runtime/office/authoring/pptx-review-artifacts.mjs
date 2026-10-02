import { snapshot } from '../core/office-sessions.mjs';
import { attachRenderedAir, compositionReceipt, receiptForDelivery } from './pptx-receipt.mjs';
import { writeContactSheet } from './pptx-contact-sheet.mjs';
import { renderedAirByPage } from '../quality/render-air.mjs';

export async function readCompositionReceipt(session) {
  try {
    const current = await snapshot(session, { includeStyles: true, limit: 100, maxChars: 100_000 }, { full: true });
    return compositionReceipt(current?.document, session.authoredBrief);
  } catch {
    return null;
  }
}

const CONTACT_SHEET_IMAGE_MIN_PAGES = 4;

// Author and standalone render expose the same review artifacts; QA uses the
// raw page preview so contact sheets never enter pixel-level page checks.
export async function pptxReviewArtifacts(session, preview) {
  const result = { ...preview, _images: [...(preview._images || [])] };
  // The receipt reads an authored deck against the brief it was written to. A deck opened for editing has no
  // brief, and its pages are reviewed as edits, so its render carries the pages alone — a template's receipt
  // ran to fifteen thousand characters beside three page images.
  // A PDF of designed pages keeps the receipt its working deck was read into at author time (the PDF
  // itself holds no shapes); each render reads its own copy against the printed pixels.
  const receipt = session.authoredFrame
    ? session.frameReceipt
      ? structuredClone(session.frameReceipt)
      : null
    : session.authored === true
      ? await readCompositionReceipt(session)
      : null;
  if (receipt) {
    const air = await renderedAirByPage(result._images).catch(() => null);
    if (air) attachRenderedAir(receipt, air);
    // A render of some pages answers for those pages; the deck line still reads the whole sequence.
    const rendered = new Set(result._images.map((image) => Number(image.page)).filter((page) => page > 0));
    if (rendered.size && rendered.size < (Number(preview.pageCount) || 0) && Array.isArray(receipt.slides)) {
      receipt.slides = receipt.slides.filter((slide) => rendered.has(Number(slide.slide)));
    }
    result.receipt = receiptForDelivery(receipt, session);
  }
  const sheet = await writeContactSheet(result._images, preview.output).catch(() => null);
  if (sheet) {
    const { data, ...meta } = sheet;
    result.contactSheet = meta;
    // Up to four slides arrive as page images the reader already sees in order;
    // the sheet's pixels repeat them. The file is written either way.
    const pages = Number(preview.pageCount) || result._images.length;
    if (pages > CONTACT_SHEET_IMAGE_MIN_PAGES) result._images.push({ page: 0, ...meta, data });
  }
  return result;
}
