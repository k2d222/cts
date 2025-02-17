export const description = `
Execution Tests for the abstract-int comparison expressions
`;

import { makeTestGroup } from '../../../../../common/framework/test_group';
import { GPUTest } from '../../../../gpu_test';
import { bool, abstractInt, Type } from '../../../../util/conversion';
import { vectorI64Range } from '../../../../util/math';
import { Case } from '../case';
import { onlyConstInputSource, run } from '../expression';

import { binary } from './binary';

export const g = makeTestGroup(GPUTest);

/**
 * @returns a test case for the provided left hand & right hand values and
 * expected boolean result.
 */
function makeCase(lhs: bigint, rhs: bigint, expected_answer: boolean): Case {
  return { input: [abstractInt(lhs), abstractInt(rhs)], expected: bool(expected_answer) };
}

g.test('equals')
  .specURL('https://www.w3.org/TR/WGSL/#comparison-expr')
  .desc(
    `
Expression: x == y
`
  )
  .params(u =>
    u
      .combine('inputSource', onlyConstInputSource)
      .combine('vectorize', [undefined, 2, 3, 4] as const)
  )
  .fn(async t => {
    const cases = vectorI64Range(2).map(v => makeCase(v[0], v[1], v[0] === v[1]));
    await run(t, binary('=='), [Type.abstractInt, Type.abstractInt], Type.bool, t.params, cases);
  });

g.test('not_equals')
  .specURL('https://www.w3.org/TR/WGSL/#comparison-expr')
  .desc(
    `
Expression: x != y
`
  )
  .params(u =>
    u
      .combine('inputSource', onlyConstInputSource)
      .combine('vectorize', [undefined, 2, 3, 4] as const)
  )
  .fn(async t => {
    const cases = vectorI64Range(2).map(v => makeCase(v[0], v[1], v[0] !== v[1]));
    await run(t, binary('!='), [Type.abstractInt, Type.abstractInt], Type.bool, t.params, cases);
  });

g.test('less_than')
  .specURL('https://www.w3.org/TR/WGSL/#comparison-expr')
  .desc(
    `
Expression: x < y
`
  )
  .params(u =>
    u
      .combine('inputSource', onlyConstInputSource)
      .combine('vectorize', [undefined, 2, 3, 4] as const)
  )
  .fn(async t => {
    const cases = vectorI64Range(2).map(v => makeCase(v[0], v[1], v[0] < v[1]));
    await run(t, binary('<'), [Type.abstractInt, Type.abstractInt], Type.bool, t.params, cases);
  });

g.test('less_equals')
  .specURL('https://www.w3.org/TR/WGSL/#comparison-expr')
  .desc(
    `
Expression: x <= y
`
  )
  .params(u =>
    u
      .combine('inputSource', onlyConstInputSource)
      .combine('vectorize', [undefined, 2, 3, 4] as const)
  )
  .fn(async t => {
    const cases = vectorI64Range(2).map(v => makeCase(v[0], v[1], v[0] <= v[1]));
    await run(t, binary('<='), [Type.abstractInt, Type.abstractInt], Type.bool, t.params, cases);
  });

g.test('greater_than')
  .specURL('https://www.w3.org/TR/WGSL/#comparison-expr')
  .desc(
    `
Expression: x > y
`
  )
  .params(u =>
    u
      .combine('inputSource', onlyConstInputSource)
      .combine('vectorize', [undefined, 2, 3, 4] as const)
  )
  .fn(async t => {
    const cases = vectorI64Range(2).map(v => makeCase(v[0], v[1], v[0] > v[1]));
    await run(t, binary('>'), [Type.abstractInt, Type.abstractInt], Type.bool, t.params, cases);
  });

g.test('greater_equals')
  .specURL('https://www.w3.org/TR/WGSL/#comparison-expr')
  .desc(
    `
Expression: x >= y
`
  )
  .params(u =>
    u
      .combine('inputSource', onlyConstInputSource)
      .combine('vectorize', [undefined, 2, 3, 4] as const)
  )
  .fn(async t => {
    const cases = vectorI64Range(2).map(v => makeCase(v[0], v[1], v[0] >= v[1]));
    await run(t, binary('>='), [Type.abstractInt, Type.abstractInt], Type.bool, t.params, cases);
  });
