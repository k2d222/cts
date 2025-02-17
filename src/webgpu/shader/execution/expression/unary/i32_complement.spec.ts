export const description = `
Execution Tests for the i32 bitwise complement operation
`;

import { makeTestGroup } from '../../../../../common/framework/test_group';
import { GPUTest } from '../../../../gpu_test';
import { i32, Type } from '../../../../util/conversion';
import { fullI32Range } from '../../../../util/math';
import { allInputSources, run } from '../expression';

import { unary } from './unary';

export const g = makeTestGroup(GPUTest);

g.test('i32_complement')
  .specURL('https://www.w3.org/TR/WGSL/#bit-expr')
  .desc(
    `
Expression: ~x
`
  )
  .params(u =>
    u.combine('inputSource', allInputSources).combine('vectorize', [undefined, 2, 3, 4] as const)
  )
  .fn(async t => {
    const cases = fullI32Range().map(e => {
      return { input: i32(e), expected: i32(~e) };
    });
    await run(t, unary('~'), [Type.i32], Type.i32, t.params, cases);
  });
