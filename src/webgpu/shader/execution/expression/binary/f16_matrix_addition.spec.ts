export const description = `
Execution Tests for matrix f16 addition expression
`;

import { makeTestGroup } from '../../../../../common/framework/test_group';
import { GPUTest } from '../../../../gpu_test';
import { Type } from '../../../../util/conversion';
import { allInputSources, run } from '../expression';

import { binary, compoundBinary } from './binary';
import { d } from './f16_matrix_addition.cache';

export const g = makeTestGroup(GPUTest);

g.test('matrix')
  .specURL('https://www.w3.org/TR/WGSL/#floating-point-evaluation')
  .desc(
    `
Expression: x + y, where x and y are matrices
Accuracy: Correctly rounded
`
  )
  .params(u =>
    u
      .combine('inputSource', allInputSources)
      .combine('cols', [2, 3, 4] as const)
      .combine('rows', [2, 3, 4] as const)
  )
  .beforeAllSubcases(t => {
    t.selectDeviceOrSkipTestCase({ requiredFeatures: ['shader-f16'] });
  })
  .fn(async t => {
    const cols = t.params.cols;
    const rows = t.params.rows;
    const cases = await d.get(
      t.params.inputSource === 'const' ? `mat${cols}x${rows}_const` : `mat${cols}x${rows}_non_const`
    );
    await run(
      t,
      binary('+'),
      [Type.mat(cols, rows, Type.f16), Type.mat(cols, rows, Type.f16)],
      Type.mat(cols, rows, Type.f16),
      t.params,
      cases
    );
  });

g.test('matrix_compound')
  .specURL('https://www.w3.org/TR/WGSL/#floating-point-evaluation')
  .desc(
    `
Expression: x =+ y, where x and y are matrices
Accuracy: Correctly rounded
`
  )
  .params(u =>
    u
      .combine('inputSource', allInputSources)
      .combine('cols', [2, 3, 4] as const)
      .combine('rows', [2, 3, 4] as const)
  )
  .beforeAllSubcases(t => {
    t.selectDeviceOrSkipTestCase({ requiredFeatures: ['shader-f16'] });
  })
  .fn(async t => {
    const cols = t.params.cols;
    const rows = t.params.rows;
    const cases = await d.get(
      t.params.inputSource === 'const' ? `mat${cols}x${rows}_const` : `mat${cols}x${rows}_non_const`
    );
    await run(
      t,
      compoundBinary('+='),
      [Type.mat(cols, rows, Type.f16), Type.mat(cols, rows, Type.f16)],
      Type.mat(cols, rows, Type.f16),
      t.params,
      cases
    );
  });
