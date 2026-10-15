import { t, uiFormatLocale } from './i18n';
// @ts-expect-error Shared runtime contract has no separate declaration file.
import { readRouteDiagnostics } from '../../../../src/runtime/shared/route-diagnostics.mjs';
import './route-diagnostics.css';

// A stable machine diagnostic, not a translated UI label.
const UNAVAILABLE_DIAGNOSTIC = 'route-diagnostics-unavailable';

type Fields = Record<string, unknown>;
const scalar = (value: unknown): string => {
  if (typeof value === 'boolean') return value ? t('On') : t('Off');
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value.toLocaleString(uiFormatLocale());
  return '—';
};

function FieldsView({ fields }: { fields: Fields }) {
  return (
    <dl className="route-diagnostics-fields">
      {Object.entries(fields).map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd><code>{scalar(value)}</code></dd>
        </div>
      ))}
    </dl>
  );
}

function SettingsView({ settings }: { settings: Fields }) {
  return <FieldsView fields={{
    [t('Provider')]: settings.provider,
    [t('Model')]: settings.model,
    [t('Effort')]: settings.effort,
    [t('Fast')]: settings.fast,
    [t('Auto reasoning')]: settings.autoEffort,
    autoEffortSource: settings.autoEffortSource,
    contextWindow: settings.contextWindow,
    serviceTier: settings.serviceTier,
  }} />;
}

/** Additive /context data: absent on old hosts. Field/reason identifiers are
 * stable diagnostic codes; human-facing headings reuse the translated UI. */
export function RouteDiagnostics({ value, sessionId, routeAutoEffort, loading = false }: {
  value: unknown;
  sessionId: string;
  routeAutoEffort?: boolean;
  loading?: boolean;
}) {
  if (loading) return null;
  const data = readRouteDiagnostics(value, sessionId);
  const last = data?.lastTurn;
  return (
    <details className="route-diagnostics">
      <summary>{t('Model')} · {t('Details')}</summary>
      <p className="route-diagnostics-note"><code>{data?.evidence || UNAVAILABLE_DIAGNOSTIC}</code></p>
      {data && (
        <div className="route-diagnostics-columns">
          <section>
            <h4>{t('Current')}</h4>
            <FieldsView fields={{ [t('Source')]: data.currentSource }} />
            <SettingsView settings={data.current} />
          </section>
          <section>
            <h4>{t('History')}</h4>
            {last ? <>
              {last.at > 0 && last.at <= 8640000000000000 && <time dateTime={new Date(last.at).toISOString()}>{new Date(last.at).toLocaleString(uiFormatLocale())}</time>}
              <SettingsView settings={last.configured} />
              <FieldsView fields={{
                preparedEffort: last.preparedEffort,
                recordedEffort: last.recordedEffort,
                [t('Source')]: last.effortSource,
              }} />
            </> : <p>{t('Unavailable')}</p>}
          </section>
        </div>
      )}
      {last && <section>
        <h4>{t('Auto reasoning')}</h4>
        <FieldsView fields={{
          mode: last.auto.mode,
          [t('Source')]: last.auto.source,
          [t('Status')]: last.auto.reason,
          judge: last.auto.judge,
          selectedEffort: last.auto.selectedEffort,
          effortChanged: last.auto.applied,
        }} />
      </section>}
      <section>
        <h4>{t('Connection')}</h4>
        <FieldsView fields={{ routeAutoEffort: routeAutoEffort === true ? t('Available') : routeAutoEffort === false ? t('Unavailable') : null }} />
      </section>
    </details>
  );
}
