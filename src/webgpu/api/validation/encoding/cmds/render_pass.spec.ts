export const description = `
Validation tests for render pass encoding.
Does **not** test usage scopes (resource_usages/), GPUProgrammablePassEncoder (programmable_pass),
dynamic state (dynamic_render_state.spec.ts), or GPURenderEncoderBase (render.spec.ts).

TODO:
- executeBundles:
    - with {zero, one, multiple} bundles where {zero, one} of them are invalid objects
`;

import { makeTestGroup } from '../../../../../common/framework/test_group.ts';
import { ValidationTest } from '../../validation_test.ts';

export const g = makeTestGroup(ValidationTest);
