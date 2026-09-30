// Main-process confirmations (close to background, quit while working) in the
// app's own confirm dialog instead of a native message box (user: 이거 팝업
// 우리 테마로 좀 바꾸고). Receipt is acknowledged at once so main keeps its
// native fallback only for a window that cannot show this.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import type { DesktopAppPrompt, DesktopAppPromptState } from '../../shared/contract';
import { SettingsConfirmDialog } from '../settings/capability-controls';

export function AppPromptHost() {
  const [prompt, setPrompt] = useState<DesktopAppPrompt | null>(null);
  const settled = useRef(false);
  useEffect(
    () =>
      window.mixdogDesktop?.onAppPrompt?.((next) => {
        // Still behind the boot cover the dialog would paint unseen: stay
        // silent so main's native fallback asks instead.
        if ((window as typeof window & { __mixdogDesktopRevealed?: boolean }).__mixdogDesktopRevealed !== true) return;
        window.mixdogDesktop?.answerAppPrompt?.(next.id, 'shown');
        settled.current = false;
        setPrompt(next);
      }),
    []
  );
  if (!prompt) return null;
  const finish = (state: DesktopAppPromptState) => {
    if (settled.current) return;
    settled.current = true;
    window.mixdogDesktop?.answerAppPrompt?.(prompt.id, state);
    setPrompt(null);
  };
  return createPortal(
    <SettingsConfirmDialog
      options={{
        title: prompt.title,
        description: prompt.description,
        confirmLabel: prompt.confirmLabel,
        danger: prompt.danger,
        onConfirm: () => finish('confirm'),
        ...(prompt.alternateLabel !== undefined
          ? { alternateLabel: prompt.alternateLabel, onAlternate: () => finish('alternate') }
          : {}),
      }}
      // The dialog closes before it confirms: a cancel waits one microtask so
      // a confirm in the same click wins.
      onClose={() => queueMicrotask(() => finish('cancel'))}
    />,
    document.body
  );
}
