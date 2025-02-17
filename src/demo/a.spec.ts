export const description = 'Description for a.spec.ts';

import { makeTestGroup } from '../common/framework/test_group.ts';
import { UnitTest } from '../unittests/unit_test.ts';

export const g = makeTestGroup(UnitTest);

g.test('not_implemented_yet').unimplemented();
