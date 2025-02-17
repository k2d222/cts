export const description = `
Tests for validation in createQuerySet.
`;

import { makeTestGroup } from '../../../../common/framework/test_group.ts';
import { kQueryTypes, kMaxQueryCount } from '../../../capability_info.ts';
import { ValidationTest } from '../validation_test.ts';

export const g = makeTestGroup(ValidationTest);

g.test('count')
  .desc(
    `
Tests that create query set with the count for all query types:
- count {<, =, >} kMaxQueryCount
- x= {occlusion, timestamp} query
  `
  )
  .params(u =>
    u
      .combine('type', kQueryTypes)
      .beginSubcases()
      .combine('count', [0, kMaxQueryCount, kMaxQueryCount + 1])
  )
  .beforeAllSubcases(t => {
    t.selectDeviceForQueryTypeOrSkipTestCase(t.params.type);
  })
  .fn(t => {
    const { type, count } = t.params;

    t.expectValidationError(() => {
      t.createQuerySetTracked({ type, count });
    }, count > kMaxQueryCount);
  });
