import { abstractInt } from '../../../../util/conversion.ts';
import { fullI64Range } from '../../../../util/math.ts';
import { makeCaseCache } from '../case_cache.ts';

export const d = makeCaseCache('unary/ai_arithmetic', {
  negation: () => {
    return fullI64Range().map(e => {
      return { input: abstractInt(e), expected: abstractInt(-e) };
    });
  },
});
