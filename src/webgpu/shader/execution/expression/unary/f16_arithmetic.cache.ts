import { FP } from '../../../../util/floating_point';
import { scalarF16Range } from '../../../../util/math';
import { makeCaseCache } from '../case_cache';

export const d = makeCaseCache('unary/f16_arithmetic', {
  negation: () => {
    return FP.f16.generateScalarToIntervalCases(
      scalarF16Range({ neg_norm: 250, neg_sub: 20, pos_sub: 20, pos_norm: 250 }),
      'unfiltered',
      FP.f16.negationInterval
    );
  },
});
