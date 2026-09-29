import { X } from 'lucide-react';
import { createPortal } from 'react-dom';
import { ErrorNotice, errorSummary } from './ErrorNotice';
import { t } from './i18n';
import { MxIcon } from './MxIcon';

/** Error/notice banners and the file-drop overlay that float ABOVE the input
 *  card (user-flagged: they previously rendered inside the pill and read as
 *  composer content). */
export function ComposerBanners({
  attachmentError,
  notice,
  draggingFiles,
  transitioning,
  dropTarget,
  onDismissAttachmentError,
  onDismissNotice,
}: {
  attachmentError: string;
  notice: string;
  draggingFiles: boolean;
  transitioning: boolean;
  dropTarget: HTMLElement | null;
  onDismissAttachmentError: () => void;
  onDismissNotice: () => void;
}) {
  return (
    <>
      {attachmentError && <ErrorNotice error={attachmentError} onDismiss={onDismissAttachmentError} />}
      {notice && (
        <p className="composer-notice" role="status">
          <span>{errorSummary(notice)}</span>
          <button
            type="button"
            className="composer-banner-close"
            aria-label={t('Dismiss notice')}
            onClick={onDismissNotice}
          >
            <X size={14} />
          </button>
        </p>
      )}
      {draggingFiles &&
        !transitioning &&
        dropTarget &&
        createPortal(
          <div className="task-drop-overlay" role="status">
            <MxIcon name="photo" size={16} />
            <span>{t('Drop files or paths')}</span>
          </div>,
          dropTarget
        )}
    </>
  );
}
