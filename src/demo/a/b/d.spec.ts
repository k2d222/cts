export const description = 'Description for d.spec.ts';

import { makeTestGroup } from '../../../common/framework/test_group.ts';
import { UnitTest } from '../../../unittests/unit_test.ts';

export const g = makeTestGroup(UnitTest);

g.test('test_depth_2,in_single_child_file').fn(() => {});
