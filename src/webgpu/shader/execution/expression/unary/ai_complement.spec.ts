export const description = `
Execution Tests for the Type.abstractInt bitwise complement operation
`;

import { makeTestGroup } from '../../../../../common/framework/test_group.ts';
import { GPUTest } from '../../../../gpu_test.ts';
import { abstractInt, Type } from '../../../../util/conversion.ts';
import { fullI64Range } from '../../../../util/math.ts';
import { onlyConstInputSource, run } from '../expression.ts';

import { abstractIntUnary } from './unary.ts';

export const g = makeTestGroup(GPUTest);

g.test('complement')
  .specURL('https://www.w3.org/TR/WGSL/#bit-expr')
  .desc(
    `
Expression: ~x
`
  )
  .params(u =>
    u
      .combine('inputSource', onlyConstInputSource)
      .combine('vectorize', [undefined, 2, 3, 4] as const)
  )
  .fn(async t => {
    const cases = fullI64Range().map(e => {
      return { input: abstractInt(e), expected: abstractInt(~e) };
    });
    await run(t, abstractIntUnary('~'), [Type.abstractInt], Type.abstractInt, t.params, cases);
  });
