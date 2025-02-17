import { FP } from '../../../../../util/floating_point';
import { fullU32Range } from '../../../../../util/math';
import { makeCaseCache } from '../../case_cache';

export const d = makeCaseCache('unpack2x16float', {
  u32_const: () => {
    return FP.f32.generateU32ToIntervalCases(
      fullU32Range(),
      'finite',
      FP.f32.unpack2x16floatInterval
    );
  },
  u32_non_const: () => {
    return FP.f32.generateU32ToIntervalCases(
      fullU32Range(),
      'unfiltered',
      FP.f32.unpack2x16floatInterval
    );
  },
});
