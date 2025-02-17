import { FP } from '../../../../../util/floating_point.ts';
import { makeCaseCache } from '../../case_cache.ts';

// Cases: [f32|f16|abstract]
const cases = (['f32', 'f16', 'abstract'] as const)
  .map(trait => ({
    [`${trait}`]: () => {
      return FP[trait].generateScalarToIntervalCases(
        FP[trait].scalarRange(),
        'unfiltered',
        FP[trait].truncInterval
      );
    },
  }))
  .reduce((a, b) => ({ ...a, ...b }), {});

export const d = makeCaseCache('trunc', cases);
