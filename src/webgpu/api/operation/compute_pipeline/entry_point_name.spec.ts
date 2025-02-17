export const description = `
TODO:
- Test some weird but valid values for entry point name (both module and pipeline creation
  should succeed).
- Test using each of many entry points in the module (should succeed).
- Test using an entry point with the wrong stage (should fail).
`;

import { makeTestGroup } from '../../../../common/framework/test_group.ts';
import { GPUTest } from '../../../gpu_test.ts';

export const g = makeTestGroup(GPUTest);
