// The serif Latin faces the presets set their display role in.
export const SERIF_FACE =
  /^(?:cambria|georgia|bookman old style|times new roman|garamond|book antiqua|palatino linotype|constantia)$/i;
export const HANGUL = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/u;

// The Latin faces the presets assign that carry no Hangul. Set beside Hangul,
// their digits print smaller than the Korean face the reader substitutes
// ("20시", "1% 미만"), so a Korean document or sheet sets each such role in the
// Korean face of its class. Serif roles keep their Latin face where the format
// pairs a Korean face per run (Word); a sheet cell holds one face, so there a
// serif role takes Batang. Any other face is the author's and stays.
const LATIN_OFFICE_FACE =
  /^(?:calibri|arial|cambria|bookman old style|courier new|times new roman|georgia|segoe ui|aptos)$/i;
export function koreanDesign(design, text, { pairsEastAsia = false } = {}) {
  const typography = design?.tokens?.typography;
  if (!typography || !HANGUL.test(text)) return design;
  const faces = Object.fromEntries(
    Object.entries(typography).map(([role, face]) => {
      const name = String(face || '').trim();
      if (!LATIN_OFFICE_FACE.test(name)) return [role, face];
      if (SERIF_FACE.test(name)) return [role, pairsEastAsia ? face : 'Batang'];
      return [role, 'Malgun Gothic'];
    })
  );
  return { ...design, tokens: { ...design.tokens, typography: faces } };
}

/** Font coverage is script-specific, not a choice of document genre. Callers
 *  can name the recipient's East Asian font independently of the Latin face.
 *  Unnamed, the Korean face follows the class of the Latin one beside it: Cambria
 *  digits beside Malgun Gothic Hangul read as two typefaces in one heading, so a
 *  serif role takes Batang (바탕), the serif Korean Windows and Office carry. */
export function documentTypography(operation, typography) {
  const text = JSON.stringify([operation.title, operation.subtitle, operation.summary, operation.sections]);
  const korean = /^ko(?:-|$)/i.test(operation.language || '') || HANGUL.test(text);
  const eastAsia = operation.nameEastAsia || (korean ? 'Malgun Gothic' : '');
  return {
    ...typography,
    eastAsia,
    eastAsiaFor: (latin) =>
      !operation.nameEastAsia && korean && SERIF_FACE.test(String(latin || '').trim()) ? 'Batang' : eastAsia,
  };
}
