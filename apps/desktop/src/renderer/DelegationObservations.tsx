import { memo, useMemo, useState } from 'react';
import { delegationObservations, type DelegationObservationRow } from '../../../../src/ui/delegation-observations.mjs';
import { t } from './i18n';

const PAGE_SIZE = 25;

function modeLabel(mode: DelegationObservationRow['mode']): string {
  switch (mode) {
    case 'none':
      return t('Solo');
    case 'focused':
      return t('Assisted');
    case 'balanced':
      return t('Collaborative');
    case 'swarm':
      return t('Swarm');
    default:
      return t('Unknown');
  }
}

function outcomeLabel(row: DelegationObservationRow): string {
  switch (row.outcome) {
    case 'completed':
      return t('Completed');
    case 'failed':
      return t('Failed');
    case 'cancelled':
      return t('Cancelled');
    case 'partial':
      return t('Partial handoff');
    default:
      return row.phase === 'queued'
        ? t('Queued')
        : row.phase === 'preparing'
          ? t('Preparing')
          : row.phase === 'running'
            ? t('Running')
            : t('Unknown');
  }
}

function duration(value: number | null): string {
  return value === null ? '—' : `${(value / 1000).toFixed(1)} s`;
}

function count(value: number | null): string {
  return value === null ? '—' : value.toLocaleString();
}

function Observation({ row }: { row: DelegationObservationRow }) {
  const measures = [
    [t('Admission wait'), duration(row.queueWaitMs)],
    [t('Preparation'), duration(row.preparationMs)],
    [t('Execution'), duration(row.executionMs)],
    [t('Time to outcome'), duration(row.elapsedMs)],
    [t('Input'), count(row.inputTokens)],
    [t('Output'), count(row.outputTokens)],
    [t('Tool calls'), count(row.toolCalls)],
  ];
  return (
    <article className="delegation-observation" data-task-id={row.id}>
      <header>
        <strong>{row.tag || row.agent || row.id}</strong>
        <span>
          {modeLabel(row.mode)} · {outcomeLabel(row)}
        </span>
      </header>
      <p className="delegation-route">
        {row.operation === 'spawn' ? t('New worker') : row.operation === 'send' ? t('Worker follow-up') : t('Unknown')}
        {row.agent ? ` · ${row.agent}` : ''}
        {row.provider || row.model ? ` · ${[row.provider, row.model].filter(Boolean).join('/')}` : ''}
      </p>
      <time dateTime={row.startedAt}>{row.startedAt}</time>
      <dl>
        {measures.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </article>
  );
}

/** Direct caller's retained jobs, not the global pool or session lifetime spend.
 *  The parent keys this component by session, so expansion resets on switching. */
export const DelegationObservations = memo(function DelegationObservations({
  jobs,
  sessionId,
}: {
  jobs: unknown;
  sessionId: string;
}) {
  const model = useMemo(() => delegationObservations(jobs, sessionId), [jobs, sessionId]);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const shown = model.rows.slice(0, limit);
  return (
    <details className="delegation-observations">
      <summary>
        <span>{t('Delegation activity')}</span>
        <strong>{model.rows.length}</strong>
      </summary>
      <div className="delegation-observations-body">
        <p>{t('Finished jobs expire after 30 minutes; restart or capacity cleanup can remove history sooner.')}</p>
        <p>{t('— means unmeasured. Usage is for the returned turn, not the whole job or a bill.')}</p>
        <p>{t('An outcome is not a quality check. Follow-ups are not automatically rework.')}</p>
        {!model.available && <p role="status">{t('Observation data unavailable.')}</p>}
        {model.available && model.rows.length === 0 && <p role="status">{t('No observed jobs in this snapshot.')}</p>}
        {model.unmeasured > 0 && <p>{t('Jobs without observation data: {{total}}.', { total: model.unmeasured })}</p>}
        <div className="delegation-observation-modes" aria-label={t('Delegation modes')}>
          {(['focused', 'balanced', 'swarm', 'none', null] as const).map((mode) => {
            const total = model.rows.filter((row) => row.mode === mode).length;
            return total > 0 ? (
              <span key={mode || 'unknown'}>
                {modeLabel(mode)} <strong>{total}</strong>
              </span>
            ) : null;
          })}
        </div>
        {shown.map((row) => (
          <Observation key={row.id} row={row} />
        ))}
        {model.rows.length > shown.length && (
          <div className="delegation-observations-more">
            <span>{t('Showing {{shown}} of {{total}} jobs.', { shown: shown.length, total: model.rows.length })}</span>
            <button type="button" onClick={() => setLimit((value) => value + PAGE_SIZE)}>
              {t('Show more')}
            </button>
          </div>
        )}
      </div>
    </details>
  );
});
