import { existsSync, readFileSync } from 'node:fs';

/** Metadata about tests (that can't be derived at runtime). */
export type TestMetadata = {
  /**
   * Estimated average time-per-subcase, in milliseconds.
   * This is used to determine chunking granularity when exporting to WPT with
   * chunking enabled (like out-wpt/cts-chunked2sec.https.html).
   */
  subcaseMS: number;
};

export type TestMetadataListing = {
  [testQuery: string]: TestMetadata;
};

export function loadMetadataForSuite(suiteDir: string): TestMetadataListing | null {
  const metadataFile = `${suiteDir}/listing_meta.json`;
  if (!existsSync(metadataFile)) {
    return null;
  }

  const metadata: TestMetadataListing = JSON.parse(readFileSync(metadataFile, 'utf8'));
  return metadata;
}
