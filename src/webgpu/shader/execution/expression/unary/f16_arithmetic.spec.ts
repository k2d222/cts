export const description = `
Execution Tests for the f16 arithmetic unary expression operations
`;

import { makeTestGroup } from '../../../../../common/framework/test_group.ts';
import { GPUTest } from '../../../../gpu_test.ts';
import { Type } from '../../../../util/conversion.ts';
import { allInputSources, run } from '../expression.ts';

import { d } from './f16_arithmetic.cache.ts';
import { unary } from './unary.ts';

export const g = makeTestGroup(GPUTest);

g.test('negation')
  .specURL('https://www.w3.org/TR/WGSL/#floating-point-evaluation')
  .desc(
    `
Expression: -x
Accuracy: Correctly rounded
`
  )
  .params(u =>
    u.combine('inputSource', allInputSources).combine('vectorize', [undefined, 2, 3, 4] as const)
  )
  .beforeAllSubcases(t => {
    t.selectDeviceOrSkipTestCase({ requiredFeatures: ['shader-f16'] });
  })
  .fn(async t => {
    const cases = await d.get('negation');
    await run(t, unary('-'), [Type.f16], Type.f16, t.params, cases);
  });
