export const description = 'Description for a.spec.ts';

import { makeTestGroup } from '../common/framework/test_group.ts';
import { UnitTest } from '../unittests/unit_test.ts';

export const g = makeTestGroup(UnitTest);

g.test('json')
  .paramsSimple([{ p: { x: 1, y: 'two' } }])
  .fn(() => {});
