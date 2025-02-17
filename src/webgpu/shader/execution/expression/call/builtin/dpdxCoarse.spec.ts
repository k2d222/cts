export const description = `
Execution tests for the 'dpdxCoarse' builtin function

T is f32 or vecN<f32>
fn dpdxCoarse(e:T) ->T
Returns the partial derivative of e with respect to window x coordinates using local differences.
This may result in fewer unique positions that dpdxFine(e).
`;

import { makeTestGroup } from '../../../../../../common/framework/test_group.ts';
import { GPUTest } from '../../../../../gpu_test.ts';

import { d } from './derivatives.cache.ts';
import { runDerivativeTest } from './derivatives.ts';

export const g = makeTestGroup(GPUTest);

const builtin = 'dpdxCoarse';

g.test('f32')
  .specURL('https://www.w3.org/TR/WGSL/#derivative-builtin-functions')
  .params(u =>
    u
      .combine('vectorize', [undefined, 2, 3, 4] as const)
      .combine('non_uniform_discard', [false, true])
  )
  .fn(async t => {
    const cases = await d.get('scalar');
    runDerivativeTest(t, cases, builtin, t.params.non_uniform_discard, t.params.vectorize);
  });
