import { FP } from '../../../../../util/floating_point.ts';
import { fullU32Range } from '../../../../../util/math.ts';
import { makeCaseCache } from '../../case_cache.ts';

export const d = makeCaseCache('unpack4x8unorm', {
  u32_const: () => {
    return FP.f32.generateU32ToIntervalCases(
      fullU32Range(),
      'finite',
      FP.f32.unpack4x8unormInterval
    );
  },
  u32_non_const: () => {
    return FP.f32.generateU32ToIntervalCases(
      fullU32Range(),
      'unfiltered',
      FP.f32.unpack4x8unormInterval
    );
  },
});
