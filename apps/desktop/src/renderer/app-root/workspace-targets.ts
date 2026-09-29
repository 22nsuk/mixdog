/** Rendered size of a pane, or undefined while its element is not mounted. */
export function paneSize(leafId: string): { width: number; height: number } | undefined {
  const paneElement = Array.from(document.querySelectorAll<HTMLElement>('[data-pane-id]')).find(
    (element) => element.dataset.paneId === leafId
  );
  const rect = paneElement?.getBoundingClientRect();
  return rect ? { width: rect.width, height: rect.height } : undefined;
}

/** Trimmed project and slash-normalised relative path of a diff target; null when either is empty. */
export function cleanDiffTarget(project: string, rel: string): { project: string; rel: string } | null {
  const cleanProject = String(project || '').trim();
  const cleanRel = String(rel || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '');
  return cleanProject && cleanRel ? { project: cleanProject, rel: cleanRel } : null;
}
