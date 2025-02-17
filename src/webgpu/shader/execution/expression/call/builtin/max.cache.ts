import { FP } from '../../../../../util/floating_point.ts';
import { makeCaseCache } from '../../case_cache.ts';

// Cases: [f32|f16|abstract]
const cases = (['f32', 'f16', 'abstract'] as const)
  .map(trait => ({
    [`${trait}`]: () => {
      return FP[trait].generateScalarPairToIntervalCases(
        FP[trait].sparseScalarRange(),
        FP[trait].sparseScalarRange(),
        'unfiltered',
        FP[trait].maxInterval
      );
    },
  }))
  .reduce((a, b) => ({ ...a, ...b }), {});

export const d = makeCaseCache('max', cases);
