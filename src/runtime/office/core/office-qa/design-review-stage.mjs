// The structural design review QA runs over the whole document, with the
// per-page roles the render review needs; an unreadable document degrades to
// one advisory issue instead of failing QA.
import { inferPptxSlideRoles, reviewOfficeDesign } from '../../quality/design-review.mjs';
import { issue } from '../../quality/assurance-issue.mjs';
import { reviewSnapshot } from '../office-actions-inspect.mjs';
import { documentBriefIssues } from '../../quality/document-brief.mjs';

function unavailableDesignReview(session, error) {
  return {
    ok: false,
    status: 'unavailable',
    profile: session.design?.profile || '',
    requiresVisualInspection: true,
    modelReview: [],
    issues: [issue('design_review_unavailable', '/', error?.message || String(error), 'design-review')],
  };
}

function requestedSlidePlans(session) {
  if (Array.isArray(session.designRequest?.slidePlans)) return session.designRequest.slidePlans;
  if (Array.isArray(session.design?.slidePlans)) return session.design.slidePlans;
  return [];
}

function pageRolesFor(session, reviewSlidePlans, currentSnapshot) {
  // Without composer plans (authored decks) the statement beats are read from
  // the saved shapes so the density gates do not penalise deliberate air.
  if (reviewSlidePlans.length) {
    return Object.fromEntries(
      reviewSlidePlans
        .filter((plan) => Number(plan?.slide) > 0)
        .map((plan) => [Number(plan.slide), { slideRole: plan.slideRole, visualType: plan.visualType }])
    );
  }
  if (session.format === 'pptx') return inferPptxSlideRoles(currentSnapshot?.document);
  return {};
}

export async function reviewQaDesign(session, args) {
  let designReview;
  let currentSnapshot = null;
  let reviewSlidePlans = [];
  try {
    // The review reads the whole document: a bounded (model-facing) snapshot
    // shrinks its page limit to fit maxChars, which left every slide past the
    // first dozen of a long deck without a role or a design review.
    currentSnapshot = await reviewSnapshot(session, args);
    const stateSlidePlans = Array.isArray(session.designState?.slidePlans) ? session.designState.slidePlans : [];
    reviewSlidePlans = stateSlidePlans.length ? stateSlidePlans : requestedSlidePlans(session);
    const pptxDesign = session.format === 'pptx' ? { slidePlans: reviewSlidePlans } : {};
    if (session.format === 'pptx' && session.authoredBrief) pptxDesign.brief = session.authoredBrief;
    designReview = reviewOfficeDesign({
      format: session.format,
      document: currentSnapshot.document,
      design: {
        ...(session.design || {}),
        ...(session.designRequest || {}),
        ...pptxDesign,
        compositions: session.designState?.compositions || [],
      },
      library: session.designLibrary,
      auditProfile: args.auditProfile,
    });
  } catch (error) {
    designReview = unavailableDesignReview(session, error);
  }
  // A PDF of designed pages was read against its brief on the working deck at author time (the plan
  // count, the facts' locators); those readings join the PDF's own review.
  if (session.authoredFrame === true && Array.isArray(session.frameDesignIssues) && session.frameDesignIssues.length) {
    designReview = { ...designReview, issues: [...(designReview.issues || []), ...session.frameDesignIssues] };
  }
  // A Word document or workbook written to a brief: its figures against the facts line, its facts against the sources.
  const briefIssues = documentBriefIssues(session.format, currentSnapshot?.document, session.authoredBrief);
  if (briefIssues.length) designReview = { ...designReview, issues: [...(designReview.issues || []), ...briefIssues] };
  return {
    designReview,
    currentSnapshot,
    reviewSlidePlans,
    pageRoles: pageRolesFor(session, reviewSlidePlans, currentSnapshot),
  };
}
