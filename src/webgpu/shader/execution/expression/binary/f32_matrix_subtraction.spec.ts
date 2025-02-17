export const description = `
Execution Tests for matrix f32 subtraction expression
`;

import { makeTestGroup } from '../../../../../common/framework/test_group.ts';
import { GPUTest } from '../../../../gpu_test.ts';
import { Type } from '../../../../util/conversion.ts';
import { allInputSources, run } from '../expression.ts';

import { binary, compoundBinary } from './binary.ts';
import { d } from './f32_matrix_subtraction.cache.ts';

export const g = makeTestGroup(GPUTest);

g.test('matrix')
  .specURL('https://www.w3.org/TR/WGSL/#floating-point-evaluation')
  .desc(
    `
Expression: x - y, where x and y are matrices
Accuracy: Correctly rounded
`
  )
  .params(u =>
    u
      .combine('inputSource', allInputSources)
      .combine('cols', [2, 3, 4] as const)
      .combine('rows', [2, 3, 4] as const)
  )
  .fn(async t => {
    const cols = t.params.cols;
    const rows = t.params.rows;
    const cases = await d.get(
      t.params.inputSource === 'const' ? `mat${cols}x${rows}_const` : `mat${cols}x${rows}_non_const`
    );
    await run(
      t,
      binary('-'),
      [Type.mat(cols, rows, Type.f32), Type.mat(cols, rows, Type.f32)],
      Type.mat(cols, rows, Type.f32),
      t.params,
      cases
    );
  });

g.test('matrix_compound')
  .specURL('https://www.w3.org/TR/WGSL/#floating-point-evaluation')
  .desc(
    `
Expression: x -= y, where x and y are matrices
Accuracy: Correctly rounded
`
  )
  .params(u =>
    u
      .combine('inputSource', allInputSources)
      .combine('cols', [2, 3, 4] as const)
      .combine('rows', [2, 3, 4] as const)
  )
  .fn(async t => {
    const cols = t.params.cols;
    const rows = t.params.rows;
    const cases = await d.get(
      t.params.inputSource === 'const' ? `mat${cols}x${rows}_const` : `mat${cols}x${rows}_non_const`
    );
    await run(
      t,
      compoundBinary('-='),
      [Type.mat(cols, rows, Type.f32), Type.mat(cols, rows, Type.f32)],
      Type.mat(cols, rows, Type.f32),
      t.params,
      cases
    );
  });
