import { lazy, Suspense, type ReactNode } from 'react';
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
 * Slots take space only while their content renders. Their geometry commits
 * once, with no retained closing card or height animation: each animation
 * step used to resize and scroll the entire transcript above the input.
 * The timeline applies the resulting viewport change before paint.
 */

export function ComposerDock({
  goalIsland,
  goalSubmissionId,
  runtimeProgress,
  approval,
  showProjectSelector,
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
  contextBar?: ReactNode;
  reviewItems: TranscriptItem[];
  reviewActive: boolean;
  reviewBusy: boolean;
  reviewSessionId: string;
  reviewCwd: string;
  onOpenFile?: (project: string, rel: string) => void;
  children: ReactNode;
}) {
  return (
    <div className="composer-region">
      <SessionGoalHost placement="composer" submissionId={goalSubmissionId}>
        {goalIsland}
      </SessionGoalHost>
      {runtimeProgress}
      {approval && <div className="composer-approval-row">{approval}</div>}
      {showProjectSelector && <div className="composer-context-bar">{contextBar}</div>}
      {/* Review sits attached ABOVE the input (user: 채팅창 위에 붙어야 한다).
          It is not a timeline row: as scroll content it read as a detached
          card floating over the composer. */}
      <div className="turn-review-slot">
        <Suspense fallback={<span hidden data-entry-pending />}>
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
