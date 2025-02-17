import { abstractInt } from '../../../../../util/conversion.ts';
import { FP } from '../../../../../util/floating_point.ts';
import { absBigInt, fullI64Range } from '../../../../../util/math.ts';
import { CaseListBuilder, makeCaseCache } from '../../case_cache.ts';

// Cases: [f32|f16|abstract_float|abstract_int]
const cases: Record<string, CaseListBuilder> = {
  ...(['f32', 'f16', 'abstract'] as const)
    .map(trait => ({
      [`${trait === 'abstract' ? 'abstract_float' : trait}`]: () => {
        return FP[trait].generateScalarToIntervalCases(
          FP[trait].scalarRange(),
          'unfiltered',
          FP[trait].absInterval
        );
      },
    }))
    .reduce((a, b) => ({ ...a, ...b }), {}),
  abstract_int: () => {
    return fullI64Range().map(e => {
      return { input: abstractInt(e), expected: abstractInt(absBigInt(e)) };
    });
  },
};

export const d = makeCaseCache('abs', cases);
