export const description = `
Execution tests for the 'cross' builtin function

T is abstract-float, f32, or f16
@const fn cross(e1: vec3<T> ,e2: vec3<T>) -> vec3<T>
Returns the cross product of e1 and e2.
`;

import { makeTestGroup } from '../../../../../../common/framework/test_group.ts';
import { GPUTest } from '../../../../../gpu_test.ts';
import { Type } from '../../../../../util/conversion.ts';
import { allInputSources, onlyConstInputSource, run } from '../../expression.ts';

import { abstractFloatBuiltin, builtin } from './builtin.ts';
import { d } from './cross.cache.ts';

export const g = makeTestGroup(GPUTest);

g.test('abstract_float')
  .specURL('https://www.w3.org/TR/WGSL/#float-builtin-functions')
  .desc(`abstract float tests`)
  .params(u => u.combine('inputSource', onlyConstInputSource))
  .fn(async t => {
    const cases = await d.get('abstract_const');
    await run(
      t,
      abstractFloatBuiltin('cross'),
      [Type.vec(3, Type.abstractFloat), Type.vec(3, Type.abstractFloat)],
      Type.vec(3, Type.abstractFloat),
      t.params,
      cases
    );
  });

g.test('f32')
  .specURL('https://www.w3.org/TR/WGSL/#float-builtin-functions')
  .desc(`f32 tests`)
  .params(u => u.combine('inputSource', allInputSources))
  .fn(async t => {
    const cases = await d.get(t.params.inputSource === 'const' ? 'f32_const' : 'f32_non_const');
    await run(t, builtin('cross'), [Type.vec3f, Type.vec3f], Type.vec3f, t.params, cases);
  });

g.test('f16')
  .specURL('https://www.w3.org/TR/WGSL/#float-builtin-functions')
  .desc(`f16 tests`)
  .params(u => u.combine('inputSource', allInputSources))
  .beforeAllSubcases(t => {
    t.selectDeviceOrSkipTestCase({ requiredFeatures: ['shader-f16'] });
  })
  .fn(async t => {
    const cases = await d.get(t.params.inputSource === 'const' ? 'f16_const' : 'f16_non_const');
    await run(t, builtin('cross'), [Type.vec3h, Type.vec3h], Type.vec3h, t.params, cases);
  });
