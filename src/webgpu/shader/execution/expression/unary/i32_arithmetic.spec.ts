export const description = `
Execution Tests for the i32 arithmetic unary expression operations
`;

import { makeTestGroup } from '../../../../../common/framework/test_group.ts';
import { GPUTest } from '../../../../gpu_test.ts';
import { Type } from '../../../../util/conversion.ts';
import { allInputSources, run } from '../expression.ts';

import { d } from './i32_arithmetic.cache.ts';
import { unary } from './unary.ts';

export const g = makeTestGroup(GPUTest);

g.test('negation')
  .specURL('https://www.w3.org/TR/WGSL/#floating-point-evaluation')
  .desc(
    `
Expression: -x
`
  )
  .params(u =>
    u.combine('inputSource', allInputSources).combine('vectorize', [undefined, 2, 3, 4] as const)
  )
  .fn(async t => {
    const cases = await d.get('negation');
    await run(t, unary('-'), [Type.i32], Type.i32, t.params, cases);
  });
