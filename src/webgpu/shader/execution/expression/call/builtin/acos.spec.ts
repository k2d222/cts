export const description = `
Execution tests for the 'acos' builtin function

S is abstract-float, f32, f16
T is S or vecN<S>
@const fn acos(e: T ) -> T
Returns the arc cosine of e. Component-wise when T is a vector.
`;

import { makeTestGroup } from '../../../../../../common/framework/test_group';
import { GPUTest } from '../../../../../gpu_test';
import { Type } from '../../../../../util/conversion';
import { allInputSources, onlyConstInputSource, run } from '../../expression';

import { d } from './acos.cache';
import { abstractFloatBuiltin, builtin } from './builtin';

export const g = makeTestGroup(GPUTest);

g.test('abstract_float')
  .specURL('https://www.w3.org/TR/WGSL/#float-builtin-functions')
  .desc(`abstract float tests`)
  .params(u =>
    u
      .combine('inputSource', onlyConstInputSource)
      .combine('vectorize', [undefined, 2, 3, 4] as const)
  )
  .fn(async t => {
    const cases = await d.get('abstract_const');
    await run(
      t,
      abstractFloatBuiltin('acos'),
      [Type.abstractFloat],
      Type.abstractFloat,
      t.params,
      cases
    );
  });

g.test('f32')
  .specURL('https://www.w3.org/TR/WGSL/#float-builtin-functions')
  .desc(`f32 tests`)
  .params(u =>
    u.combine('inputSource', allInputSources).combine('vectorize', [undefined, 2, 3, 4] as const)
  )
  .fn(async t => {
    const cases = await d.get(t.params.inputSource === 'const' ? 'f32_const' : 'f32_non_const');
    await run(t, builtin('acos'), [Type.f32], Type.f32, t.params, cases);
  });

g.test('f16')
  .specURL('https://www.w3.org/TR/WGSL/#float-builtin-functions')
  .desc(`f16 tests`)
  .params(u =>
    u.combine('inputSource', allInputSources).combine('vectorize', [undefined, 2, 3, 4] as const)
  )
  .beforeAllSubcases(t => {
    t.selectDeviceOrSkipTestCase('shader-f16');
  })
  .fn(async t => {
    const cases = await d.get(t.params.inputSource === 'const' ? 'f16_const' : 'f16_non_const');
    await run(t, builtin('acos'), [Type.f16], Type.f16, t.params, cases);
  });
