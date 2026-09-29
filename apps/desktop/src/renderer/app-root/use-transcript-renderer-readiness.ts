import { useEffect, useState } from 'react';
import type { NavigationSelection } from '../navigation';
import { isMarkdownBodyReady, preloadMarkdownBody } from '../markdown-body-loader';
import { paneActiveSelection } from '../pane-layout';
import type { usePaneWorkspace } from '../pane-workspace-state';

/** Preloads the markdown body and reports whether session transcripts must wait for it. */
export function useTranscriptRendererReadiness(
  leaves: ReturnType<typeof usePaneWorkspace>['leaves'],
  navigationSelection: NavigationSelection
) {
  const [markdownBodyReadyForTranscript, setMarkdownBodyReadyForTranscript] = useState(isMarkdownBodyReady);
  const paneTranscriptRendererPending =
    leaves.some((leaf) => paneActiveSelection(leaf)?.kind === 'session') && !markdownBodyReadyForTranscript;
  const transcriptRendererPending = navigationSelection.kind === 'session' && !markdownBodyReadyForTranscript;
  useEffect(() => {
    if (markdownBodyReadyForTranscript) return undefined;
    let active = true;
    void preloadMarkdownBody()
      .catch(() => undefined)
      .finally(() => {
        if (active) setMarkdownBodyReadyForTranscript(true);
      });
    return () => {
      active = false;
    };
  }, [markdownBodyReadyForTranscript]);
  return { paneTranscriptRendererPending, transcriptRendererPending };
}
