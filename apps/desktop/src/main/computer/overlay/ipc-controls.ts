import type { WebContents } from 'electron';
import { appendComputerRunRecord } from '../session/run-log';
import type { createComputerOverlayController, ComputerUseOverlayControls } from './controls';

/** Every press the overlay delivers leaves a record, so "the button did
 *  nothing" can be told apart from "the press never arrived". The record
 *  carries the control and its outcome, never anything the user typed. */
function recordOverlayPress(
  sessionIds: string[],
  action: string,
  generation: number,
  outcome: Record<string, unknown>
): void {
  appendComputerRunRecord(sessionIds[0] || 'overlay', {
    action: `overlay_${action}`,
    generation,
    sessions: sessionIds.length,
    ...outcome,
  });
}

export function bindComputerOverlayControls(
  contents: WebContents,
  controller: ReturnType<typeof createComputerOverlayController>,
  controls: ComputerUseOverlayControls,
  presentation: () => { sessionIds: string[]; generation: number }
): void {
  contents.ipc.handle('computer-overlay-control', async (event, request) => {
    if (
      event.sender !== contents ||
      event.senderFrame !== contents.mainFrame ||
      !request ||
      typeof request !== 'object' ||
      Array.isArray(request)
    ) {
      throw new Error('Invalid overlay sender');
    }
    if (
      request.action === 'configure' &&
      Object.keys(request).every((key) => ['action', 'seconds'].includes(key)) &&
      Number.isInteger(request.seconds) &&
      request.seconds >= 0 &&
      request.seconds <= 60
    ) {
      if (!controls.configureIdleResume) throw new Error('Idle resume configuration unavailable');
      controls.configureIdleResume(request.seconds);
      return { accepted: true };
    }
    if (
      request.action === 'press' &&
      Object.keys(request).every((key) => ['action', 'control'].includes(key)) &&
      request.control === 'stop'
    ) {
      // The pointer went down on Stop. Next to the overlay_stop record it
      // separates a press this window never received from one that never
      // became a click.
      const current = presentation();
      recordOverlayPress(current.sessionIds, 'press', current.generation, { control: request.control });
      return { accepted: true };
    }
    if (
      // Stop is the overlay's only control: pausing is the user's own input,
      // and that pause resumes by itself or ends with Stop.
      request.action !== 'stop' ||
      Object.keys(request).some((key) => !['action', 'generation'].includes(key)) ||
      !Number.isSafeInteger(request.generation) ||
      request.generation < 0
    ) {
      throw new Error('Invalid overlay request');
    }
    const current = presentation();
    // A repeated press joins the running Stop, so every press is applied.
    await controller.invoke('stop', current.sessionIds);
    recordOverlayPress(current.sessionIds, 'stop', request.generation, { ...controller.state(), ok: true });
    return { accepted: true, ...controller.state() };
  });
}
