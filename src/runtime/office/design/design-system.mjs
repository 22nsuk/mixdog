import { bindOfficeContent, summarizeOfficeContentModel } from './content-model.mjs';
import { planOfficeComposition, summarizeOfficeCompositions } from './composition-system.mjs';
import { applyOfficeCreativeBrief, directOfficeStory } from './design-creative-director.mjs';
import { expandDocxDocument } from './docx/design-docx.mjs';
import { compactDesign, resolveOfficeDesign } from './design-tokens.mjs';
import { expandXlsxSheet } from './xlsx/design-xlsx.mjs';
import { nativeDesignReceipt, nativeOfficeDesign, usesNativeOfficeDesign } from './native-design.mjs';

export { officeDesignCatalog, resolveOfficeDesign } from './design-tokens.mjs';

export function expandOfficeDesignOperations({
  format,
  operations = [],
  design: request = {},
  library = null,
  created = false,
  snapshotVersion = 0,
} = {}) {
  const normalizedFormat = String(format || '').toLowerCase();
  if (usesNativeOfficeDesign(normalizedFormat, request, operations)) {
    const design = nativeOfficeDesign(normalizedFormat, request);
    return {
      operations: operations.map((operation) => bindOfficeContent(operation, design.content).operation),
      semantic: [],
      design: nativeDesignReceipt(design),
      content: summarizeOfficeContentModel(design.content),
      composition: summarizeOfficeCompositions(normalizedFormat, []),
    };
  }
  const resolvedDesign = resolveOfficeDesign(normalizedFormat, request, { library });
  const creative = directOfficeStory(normalizedFormat, operations, resolvedDesign);
  const design = { ...resolvedDesign, creative };
  const output = [];
  const semantic = [];
  const docxState = { paragraph: 0, table: 0 };
  const composedSheets = new Set();
  const compositionUsage = new Map();
  for (const [operationIndex, operation] of (operations || []).entries()) {
    const directedOperation = applyOfficeCreativeBrief(operation, creative, operationIndex);
    const bound = bindOfficeContent(directedOperation, design.content);
    const contentOperation = bound.operation;
    const name = String(contentOperation?.op || '');
    // Decks are designed by the author, not composed by the runtime: a slide is
    // written as a pptxgenjs script (action:author, pptx skill) and an existing
    // deck is edited with the slide and shape operations.
    if (normalizedFormat === 'pptx' && name === 'compose_slide') {
      throw new Error(
        'compose_slide is no longer supported: author a new deck with action:author (pptx skill) and edit an existing deck with add_slide, add_textbox, add_chart, set_text, and the other slide operations.'
      );
    }
    if (normalizedFormat === 'docx' && name === 'compose_document') {
      const composition = planOfficeComposition(normalizedFormat, contentOperation, design, {
        usage: compositionUsage,
      });
      output.push(...expandDocxDocument(contentOperation, design, docxState, composition));
      semantic.push({
        op: name,
        sections: Array.isArray(contentOperation.sections) ? contentOperation.sections.length : 0,
        composition,
        ...(bound.binding ? { contentBinding: bound.binding } : {}),
      });
      continue;
    }
    if (normalizedFormat === 'xlsx' && name === 'compose_sheet') {
      const composition = planOfficeComposition(normalizedFormat, contentOperation, design, {
        usage: compositionUsage,
      });
      // A fresh workbook only carries one locale-named default sheet, so the
      // first composed sheet claims it by name and later sheets are created.
      const sheetName = String(contentOperation.sheet || 'Sheet1');
      if (created && Number(snapshotVersion || 0) === 0) {
        const sheetKey = sheetName.toLowerCase();
        if (!composedSheets.size) output.push({ op: 'rename_sheet', name: sheetName });
        else if (!composedSheets.has(sheetKey)) output.push({ op: 'add_sheet', name: sheetName });
        composedSheets.add(sheetKey);
      }
      output.push(...expandXlsxSheet(contentOperation, design, composition));
      semantic.push({
        op: name,
        sheet: sheetName,
        composition,
        ...(bound.binding ? { contentBinding: bound.binding } : {}),
      });
      continue;
    }
    output.push(contentOperation);
  }
  return {
    operations: output,
    semantic,
    design: compactDesign(design),
    content: summarizeOfficeContentModel(design.content),
    composition: summarizeOfficeCompositions(normalizedFormat, semantic),
  };
}

export function applyPdfDesign(blocks = [], designRequest = {}, { library = null } = {}) {
  if (usesNativeOfficeDesign('pdf', designRequest)) {
    return {
      blocks: structuredClone(blocks),
      properties: {},
      design: nativeDesignReceipt(nativeOfficeDesign('pdf', designRequest)),
    };
  }
  const design = resolveOfficeDesign('pdf', designRequest, { library });
  const colors = design.tokens.colors;
  const type = design.tokens.typography;
  let headingIndex = 0;
  const styledBlocks = (blocks || []).map((block) => {
    const typeName = String(block?.type || 'paragraph').toLowerCase();
    if (typeName === 'heading') {
      headingIndex += 1;
      const level = Number(block.level) || 0;
      const title = level === 1 || (!level && headingIndex === 1);
      let headingSize = design.format.heading;
      if (title) headingSize = design.format.title;
      else if (level >= 3) headingSize = Math.round(design.format.heading * 0.85 * 2) / 2;
      // The PDF writer sets every block in the one face it embeds (`properties.fontName`);
      // a per-block `font` is not a block field, and the block contract refused it.
      return {
        ...block,
        size: block.size || headingSize,
        // Only the document title is set apart; counted by position, the first of
        // two level-2 headings under a cover came out in ink and the second in accent.
        color: block.color || (title ? colors.ink : colors.accent),
        after: block.after ?? (title ? 18 : 10),
      };
    }
    if (typeName === 'paragraph') {
      return {
        ...block,
        size: block.size || design.format.body,
        color: block.color || colors.ink,
        lineHeight: block.lineHeight || design.format.body * 1.5,
        after: block.after ?? 8,
      };
    }
    if (typeName === 'table') {
      return {
        ...block,
        color: block.color || colors.ink,
        headerFill: block.headerFill || colors.inverse,
        headerColor: block.headerColor || colors.onInverse,
        zebraFill: block.zebraFill || colors.surface,
        borderColor: block.borderColor || colors.surface2,
      };
    }
    // The anatomy blocks carry the preset's accent too: left to the writer's default they drew a teal cover rule
    // and teal figures under the preset's green headings.
    if (['cover', 'stats', 'quote'].includes(typeName)) return { ...block, accent: block.accent || colors.accent };
    if (typeName === 'callout') {
      return { ...block, labelColor: block.labelColor || colors.accent, fill: block.fill || colors.surface };
    }
    return block;
  });
  return {
    blocks: styledBlocks,
    properties: {
      margin: design.format.margin,
      background: colors.canvas,
      fontName: type.body,
      ...compactDesign(design),
    },
    design: compactDesign(design),
  };
}
