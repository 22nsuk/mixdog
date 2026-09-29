import { resolveUiLanguage, type UiLanguage } from './i18n';

const MONACO_LOCALE_LOADERS: Partial<Record<UiLanguage, () => Promise<unknown>>> = {
  de: () => import('monaco-editor/esm/nls.messages.de.js'),
  es: () => import('monaco-editor/esm/nls.messages.es.js'),
  fr: () => import('monaco-editor/esm/nls.messages.fr.js'),
  it: () => import('monaco-editor/esm/nls.messages.it.js'),
  ja: () => import('monaco-editor/esm/nls.messages.ja.js'),
  ko: () => import('monaco-editor/esm/nls.messages.ko.js'),
  'pt-BR': () => import('monaco-editor/esm/nls.messages.pt-br.js'),
  ru: () => import('monaco-editor/esm/nls.messages.ru.js'),
  'zh-CN': () => import('monaco-editor/esm/nls.messages.zh-cn.js'),
  'zh-TW': () => import('monaco-editor/esm/nls.messages.zh-tw.js'),
};

let monacoLocaleReady: Promise<void> | null = null;

/** Monaco's Korean table spells the Alt modifier "<Alt>", so keybinding
 *  labels read "Shift+<Alt>+F". Patched before the editor chunk evaluates,
 *  because the modifier labels resolve once at module load. */
function normalizeMonacoModifierLabels(): void {
  const messages = (globalThis as { _VSCODE_NLS_MESSAGES?: unknown })._VSCODE_NLS_MESSAGES;
  if (!Array.isArray(messages)) return;
  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index] === '<Alt>') messages[index] = 'Alt';
  }
}

/**
 * Monaco resolves its module-level labels while the editor chunk evaluates,
 * independently from the app's i18next catalog. Load the matching built-in
 * table first; unsupported locales keep Monaco's readable English fallback.
 */
export function loadMonacoLocale(): Promise<void> {
  if (monacoLocaleReady) return monacoLocaleReady;
  const load = MONACO_LOCALE_LOADERS[resolveUiLanguage()];
  monacoLocaleReady = load
    ? load().then(
        () => normalizeMonacoModifierLabels(),
        () => undefined
      )
    : Promise.resolve();
  return monacoLocaleReady;
}
