/* eslint-disable import/no-restricted-paths */
import { TestSuiteListing } from '../common/internal/test_suite_listing';
import { makeListing } from '../common/tools/crawl';

export const listing: Promise<TestSuiteListing> = makeListing(__filename);
