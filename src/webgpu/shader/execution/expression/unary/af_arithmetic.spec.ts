export const description = `
Execution Tests for Type.abstractFloat arithmetic unary expression operations
`;

import { makeTestGroup } from '../../../../../common/framework/test_group.ts';
import { GPUTest } from '../../../../gpu_test.ts';
import { Type } from '../../../../util/conversion.ts';
import { onlyConstInputSource, run } from '../expression.ts';

import { d } from './af_arithmetic.cache.ts';
import { abstractFloatUnary } from './unary.ts';

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
    u
      .combine('inputSource', onlyConstInputSource)
      .combine('vectorize', [undefined, 2, 3, 4] as const)
  )
  .fn(async t => {
    const cases = await d.get('negation');
    await run(
      t,
      abstractFloatUnary('-'),
      [Type.abstractFloat],
      Type.abstractFloat,
      t.params,
      cases,
      1
    );
  });
