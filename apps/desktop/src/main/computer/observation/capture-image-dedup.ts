/**
 * The same pixels, sent again, teach the caller nothing and cost a full frame
 * of budget. A follow-up capture that matches the last frame delivered for the
 * same target keeps its fresh text metadata and drops the duplicate image,
 * saying so, so the caller knows the earlier frame still describes the screen.
 */
import { createHash } from 'node:crypto';
import { evictOldest } from '../shared/common';

export function createCaptureImageDedupStore(maxEntries = 64) {
  const digestByTarget = new Map<string, string>();
  return {
    /** Records this frame for the target and reports whether it repeats the
     *  previous one. */
    isRepeat(targetKey: string, imageData: string): boolean {
      if (!targetKey || !imageData) return false;
      const digest = createHash('sha256').update(imageData).digest('hex');
      const repeat = digestByTarget.get(targetKey) === digest;
      digestByTarget.delete(targetKey);
      digestByTarget.set(targetKey, digest);
      evictOldest(digestByTarget, maxEntries);
      return repeat;
    },
    forget(targetKey: string): void {
      digestByTarget.delete(targetKey);
    },
    releasePrefix(prefix: string): void {
      for (const key of digestByTarget.keys()) {
        if (key.startsWith(prefix)) digestByTarget.delete(key);
      }
    },
  };
}
