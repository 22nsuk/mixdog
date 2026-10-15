import { t } from './i18n';
import { record } from './record-utils';
import { statsCount, statsTokens } from './usage-stats-model';

const duration = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? `${(value / 1000).toFixed(1)} s` : '—';

/** The ledger API scopes roots to this session. Reject a stale other-session
 * snapshot here too; older hosts simply omit this optional versioned field. */
export function TaskUsage({ value, sessionId }: { value: unknown; sessionId: unknown }) {
  const data = record(value);
  if (!sessionId || data.version !== 1 || data.sessionId !== sessionId || !Array.isArray(data.tasks)) return null;
  return (
    <details className="context-task-usage">
      <summary>
        {t('Task usage')} · {statsCount(data.tasks.length)}
      </summary>
      <p>
        {t(
          'Recent runtime turns and explicitly linked descendants. Ledger subtotals may be incomplete; settlement is not verified completion. Reopen to refresh.'
        )}
      </p>
      {data.tasks.length === 0 && <p>{t('No recorded task runs.')}</p>}
      {data.tasks.map((value) => {
        const task = record(value),
          totals = record(task.totals),
          runs = record(task.runs),
          sends = record(task.sends);
        const uncertain =
          Number(runs.uncertainInputs || 0) +
          Number(task.unallocatedSubmissions || 0) +
          Number(task.ambiguousRecords || 0);
        const started = typeof task.startedAt === 'number' ? new Date(task.startedAt) : null;
        return (
          <article key={String(task.id)}>
            <code title={String(task.id)}>{String(task.id).slice(0, 8)}</code>
            {started && Number.isFinite(started.getTime()) && (
              <time dateTime={started.toISOString()}> · {started.toLocaleString()}</time>
            )}
            <dl>
              <div>
                <dt>{t('Linked runs')}</dt>
                <dd>{statsCount(runs.runs)}</dd>
              </div>
              <div>
                <dt>{t('Ledger records')}</dt>
                <dd>{statsCount(totals.records)}</dd>
              </div>
              <div>
                <dt>{t('Input')}</dt>
                <dd>{Number(totals.records) ? statsTokens(totals.input) : '—'}</dd>
              </div>
              <div>
                <dt>{t('Output')}</dt>
                <dd>{Number(totals.records) ? statsTokens(totals.output) : '—'}</dd>
              </div>
              <div>
                <dt>{t('Measured input / output records')}</dt>
                <dd>
                  {statsCount(totals.inputMeasured)} / {statsCount(totals.outputMeasured)}
                </dd>
              </div>
              <div>
                <dt>{t('First turn duration')}</dt>
                <dd>{duration(task.firstTurnMs)}</dd>
              </div>
              <div>
                <dt>{t('Linked settlement span')}</dt>
                <dd>{duration(task.linkedSettlementMs)}</dd>
              </div>
              <div>
                <dt>{t('Calls without usage')}</dt>
                <dd>{statsCount(sends.unreported)}</dd>
              </div>
              <div>
                <dt>{t('Unsettled work')}</dt>
                <dd>
                  {statsCount(
                    Number(runs.unsettled || 0) + Number(sends.unsettled || 0) + Number(task.pendingSubmissions || 0)
                  )}
                </dd>
              </div>
              <div>
                <dt>{t('Attribution gaps')}</dt>
                <dd>{statsCount(uncertain)}</dd>
              </div>
            </dl>
          </article>
        );
      })}
    </details>
  );
}
