import { abstractInt } from '../../../../util/conversion';
import { fullI64Range } from '../../../../util/math';
import { makeCaseCache } from '../case_cache';

export const d = makeCaseCache('unary/ai_arithmetic', {
  negation: () => {
    return fullI64Range().map(e => {
      return { input: abstractInt(e), expected: abstractInt(-e) };
    });
  },
});
