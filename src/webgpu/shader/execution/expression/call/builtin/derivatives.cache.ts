import { FP } from '../../../../../util/floating_point';
import { sparseScalarF32Range } from '../../../../../util/math';
import { makeCaseCache } from '../../case_cache';

export const d = makeCaseCache('derivatives', {
  scalar: () => {
    return FP.f32.generateScalarPairToIntervalCases(
      sparseScalarF32Range(),
      sparseScalarF32Range(),
      'unfiltered',
      FP.f32.subtractionInterval
    );
  },
});
