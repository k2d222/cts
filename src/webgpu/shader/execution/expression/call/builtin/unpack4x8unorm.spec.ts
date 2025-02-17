export const description = `
Decomposes a 32-bit value into four 8-bit chunks, then reinterprets each chunk
as an unsigned normalized floating point value.
Component i of the result is v ÷ 255, where v is the interpretation of bits 8×i
through 8×i+7 of e as an unsigned integer.
`;

import { makeTestGroup } from '../../../../../../common/framework/test_group.ts';
import { GPUTest } from '../../../../../gpu_test.ts';
import { Type } from '../../../../../util/conversion.ts';
import { allInputSources, run } from '../../expression.ts';

import { builtin } from './builtin.ts';
import { d } from './unpack4x8unorm.cache.ts';

export const g = makeTestGroup(GPUTest);

g.test('unpack')
  .specURL('https://www.w3.org/TR/WGSL/#unpack-builtin-functions')
  .desc(
    `
@const fn unpack4x8unorm(e: u32) -> vec4<f32>
`
  )
  .params(u => u.combine('inputSource', allInputSources))
  .fn(async t => {
    const cases = await d.get(t.params.inputSource === 'const' ? 'u32_const' : 'u32_non_const');
    await run(t, builtin('unpack4x8unorm'), [Type.u32], Type.vec4f, t.params, cases);
  });
