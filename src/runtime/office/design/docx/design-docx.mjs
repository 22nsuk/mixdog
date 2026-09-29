// compose_document → docx operations: front matter, one block per section,
// then page numbers or the footer (see design-docx/*.mjs).
import { createDocxWriter } from './design-docx/writer.mjs';
import { writeDocxFrontMatter } from './design-docx/front-matter.mjs';
import { writeDocxSection } from './design-docx/section.mjs';
import { koreanDesign } from './document-typography.mjs';

function writeDocxFooter(output, operation) {
  if (operation.pageNumbers === true) {
    output.push({
      op: 'add_page_numbers',
      includeTotal: true,
      alignment: 'center',
      prefix: operation.footer ? `${String(operation.footer)} · ` : '',
      separator: ' / ',
    });
  } else if (operation.footer) {
    output.push({ op: 'set_header_footer', header: false, text: String(operation.footer) });
  }
}

export function expandDocxDocument(operation, sourceDesign, state, composition) {
  // Tables and metric strips read the design's faces directly; a Korean document sets its sans roles in the Korean
  // face so their digits match the Hangul beside them, and keeps each serif role paired run by run.
  const design = koreanDesign(sourceDesign, JSON.stringify(operation), { pairsEastAsia: true });
  const writer = createDocxWriter({ operation, design, state, composition });
  writeDocxFrontMatter(writer, operation);
  const sections = Array.isArray(operation.sections) ? operation.sections : [];
  for (const [sectionIndex, section] of sections.entries()) {
    writeDocxSection(writer, section, sectionIndex);
  }
  writeDocxFooter(writer.output, operation);
  return writer.output;
}
