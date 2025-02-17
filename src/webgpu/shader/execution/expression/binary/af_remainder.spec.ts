export const description = `
Execution Tests for non-matrix abstract float remainder expression
`;

import { makeTestGroup } from '../../../../../common/framework/test_group.ts';
import { GPUTest } from '../../../../gpu_test.ts';
import { Type } from '../../../../util/conversion.ts';
import { onlyConstInputSource, run } from '../expression.ts';

import { d } from './af_remainder.cache.ts';
import { abstractFloatBinary } from './binary.ts';

export const g = makeTestGroup(GPUTest);

g.test('scalar')
  .specURL('https://www.w3.org/TR/WGSL/#floating-point-evaluation')
  .desc(
    `
Expression: x % y, where x and y are scalars
Accuracy: Derived from x - y * trunc(x/y)
`
  )
  .params(u => u.combine('inputSource', onlyConstInputSource))
  .fn(async t => {
    const cases = await d.get('scalar');
    await run(
      t,
      abstractFloatBinary('%'),
      [Type.abstractFloat, Type.abstractFloat],
      Type.abstractFloat,
      t.params,
      cases
    );
  });

g.test('vector')
  .specURL('https://www.w3.org/TR/WGSL/#floating-point-evaluation')
  .desc(
    `
Expression: x % y, where x and y are vectors
Accuracy: Derived from x - y * trunc(x/y)
`
  )
  .params(u =>
    u.combine('inputSource', onlyConstInputSource).combine('vectorize', [2, 3, 4] as const)
  )
  .fn(async t => {
    const cases = await d.get('scalar'); // Using vectorize to generate vector cases based on scalar cases
    await run(
      t,
      abstractFloatBinary('%'),
      [Type.abstractFloat, Type.abstractFloat],
      Type.abstractFloat,
      t.params,
      cases
    );
  });

g.test('vector_scalar')
  .specURL('https://www.w3.org/TR/WGSL/#floating-point-evaluation')
  .desc(
    `
Expression: x % y, where x is a vector and y is a scalar
Accuracy: Correctly rounded
`
  )
  .params(u => u.combine('inputSource', onlyConstInputSource).combine('dim', [2, 3, 4] as const))
  .fn(async t => {
    const dim = t.params.dim;
    const cases = await d.get(`vec${dim}_scalar`);
    await run(
      t,
      abstractFloatBinary('%'),
      [Type.vec(dim, Type.abstractFloat), Type.abstractFloat],
      Type.vec(dim, Type.abstractFloat),
      t.params,
      cases
    );
  });

g.test('scalar_vector')
  .specURL('https://www.w3.org/TR/WGSL/#floating-point-evaluation')
  .desc(
    `
Expression: x % y, where x is a scalar and y is a vector
Accuracy: Correctly rounded
`
  )
  .params(u => u.combine('inputSource', onlyConstInputSource).combine('dim', [2, 3, 4] as const))
  .fn(async t => {
    const dim = t.params.dim;
    const cases = await d.get(`scalar_vec${dim}`);
    await run(
      t,
      abstractFloatBinary('%'),
      [Type.abstractFloat, Type.vec(dim, Type.abstractFloat)],
      Type.vec(dim, Type.abstractFloat),
      t.params,
      cases
    );
  });
