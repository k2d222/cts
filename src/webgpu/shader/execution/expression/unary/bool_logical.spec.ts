export const description = `
Execution Tests for the boolean unary logical expression operations
`;

import { makeTestGroup } from '../../../../../common/framework/test_group';
import { GPUTest } from '../../../../gpu_test';
import { bool, Type } from '../../../../util/conversion';
import { allInputSources, run } from '../expression';

import { unary } from './unary';

export const g = makeTestGroup(GPUTest);

g.test('negation')
  .specURL('https://www.w3.org/TR/WGSL/#logical-expr')
  .desc(
    `
Expression: !e

Logical negation. The result is true when e is false and false when e is true. Component-wise when T is a vector.
`
  )
  .params(u =>
    u.combine('inputSource', allInputSources).combine('vectorize', [undefined, 2, 3, 4] as const)
  )
  .fn(async t => {
    const cases = [
      { input: bool(true), expected: bool(false) },
      { input: bool(false), expected: bool(true) },
    ];

    await run(t, unary('!'), [Type.bool], Type.bool, t.params, cases);
  });
