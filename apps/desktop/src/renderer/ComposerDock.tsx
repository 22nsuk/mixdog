import { lazy, Suspense, useEffect, useState, type MutableRefObject, type ReactNode } from 'react';
import type { TranscriptItem } from './desktop-types';
import { SessionGoalHost } from './session-goal-submission';

// The review bar only paints for a file-touching turn, so its diff analysis
// stays out of the first-screen bundle.
const TurnReviewBar = lazy(() => import('./TurnReview').then((module) => ({ default: module.TurnReviewBar })));

/**
 * The chrome stacked ABOVE the prompt input: Goal capsule, runtime progress,
 * tool approval, the draft-only context bar, and the turn-review slot, with
 * the composer itself as the last child.
 *
 * Every slot sits in flow, so its height comes out of the transcript viewport
 * and the follow hook re-pins the tail before paint. Each slot takes space
 * only while it actually renders (user: 실제 UI 뜰 때 바꿔야 한다):
 *   - the review slot is empty until the review bar paints, so an in-flight
 *     diff read never leaves a blank plate above the input;
 *   - the draft context bar leaves through a measured collapse instead of an
 *     instant unmount;
 *   - freed space is never held on a timer. A slot that is really gone
 *     releases its height in the same commit that removes it.
 */

type ComposerContextBarPhase = 'open' | 'collapsing' | 'closed';

/** Draft-only composer context bar: when the surface promotes to a session
 *  the bar collapses over ~140ms (CSS) before unmounting, instead of
 *  vanishing in one frame and dropping the composer 34px (measured layout
 *  shift; user: 첫 프롬 직후 화면이 한 번 툭 튐). */
function useComposerContextBarPhase(
  showProjectSelector: boolean,
  softCollapse: MutableRefObject<boolean>
): ComposerContextBarPhase {
  const [phase, setPhase] = useState<ComposerContextBarPhase>(showProjectSelector ? 'open' : 'closed');
  useEffect(() => {
    if (showProjectSelector) {
      setPhase('open');
      return undefined;
    }
    // Only this pane's OWN draft->session promotion earns the soft collapse —
    // ordinary session renders and tab switches must drop the bar instantly
    // (session chrome asserts its absence).
    if (!softCollapse.current) {
      setPhase('closed');
      return undefined;
    }
    setPhase((current) => (current === 'open' ? 'collapsing' : current));
    const timer = window.setTimeout(() => setPhase('closed'), 180);
    return () => window.clearTimeout(timer);
  }, [showProjectSelector, softCollapse]);
  return phase;
}

export function ComposerDock({
  goalIsland,
  goalSubmissionId,
  runtimeProgress,
  approval,
  showProjectSelector,
  softCollapseContextBar,
  contextBar,
  reviewItems,
  reviewActive,
  reviewBusy,
  reviewSessionId,
  reviewCwd,
  onOpenFile,
  children,
}: {
  goalIsland?: ReactNode;
  /** Closes previous-turn Goal chrome with the optimistic row (see
   *  session-goal-submission). */
  goalSubmissionId: string;
  runtimeProgress?: ReactNode;
  approval?: ReactNode;
  showProjectSelector: boolean;
  /** True only during this pane's own draft -> session promotion. */
  softCollapseContextBar: MutableRefObject<boolean>;
  contextBar?: ReactNode;
  reviewItems: TranscriptItem[];
  reviewActive: boolean;
  reviewBusy: boolean;
  reviewSessionId: string;
  reviewCwd: string;
  onOpenFile?: (project: string, rel: string) => void;
  children: ReactNode;
}) {
  const contextBarPhase = useComposerContextBarPhase(showProjectSelector, softCollapseContextBar);
  return (
    <div className="composer-region">
      <SessionGoalHost placement="composer" submissionId={goalSubmissionId}>
        {goalIsland}
      </SessionGoalHost>
      {runtimeProgress}
      {approval ? <div className="composer-approval-row">{approval}</div> : null}
      {(showProjectSelector || contextBarPhase !== 'closed') && (
        <div className={`composer-context-bar${showProjectSelector ? '' : ' composer-context-bar-collapsing'}`}>
          {contextBar}
        </div>
      )}
      {/* Review sits attached ABOVE the input (user: 채팅창 위에 붙어야 한다).
          It is not a timeline row: as scroll content it read as a detached
          card floating over the composer. */}
      <div className="turn-review-slot">
        <Suspense fallback={null}>
          <TurnReviewBar
            items={reviewItems}
            active={reviewActive}
            busy={reviewBusy}
            sessionId={reviewSessionId}
            cwd={reviewCwd}
            onOpenFile={onOpenFile}
          />
        </Suspense>
      </div>
      {children}
    </div>
  );
}
