import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

/** Source execution reads the packaged face; desktop bundles embed these calls. */
export function loadOverlayFont(specifier: string): string {
  if (!/^pretendard\/[\w./-]+\.woff2$/.test(specifier)) throw new Error('invalid overlay font asset');
  return readFileSync(createRequire(import.meta.url).resolve(specifier)).toString('base64');
}
