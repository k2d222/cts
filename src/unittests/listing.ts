/* eslint-disable import/no-restricted-paths */
import { TestSuiteListing } from '../common/internal/test_suite_listing.ts';
import { makeListing } from '../common/tools/crawl.ts';

export const listing: Promise<TestSuiteListing> = makeListing(import.meta.filename);
