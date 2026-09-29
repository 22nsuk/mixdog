import { finished } from 'node:stream/promises';
import { createPackageWithOptions } from '@electron/asar';

// @electron/asar resolves createPackageWithOptions with the archive's write
// stream right after calling end(), before its bytes reach the file. Wait for
// the stream to finish so nothing reads or copies a partially written archive.
export async function createAsarPackage(src, dest, options) {
  await finished(await createPackageWithOptions(src, dest, options));
}
