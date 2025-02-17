import { i32 } from '../../../../util/conversion.ts';
import { fullI32Range } from '../../../../util/math.ts';
import { makeCaseCache } from '../case_cache.ts';

export const d = makeCaseCache('unary/i32_arithmetic', {
  negation: () => {
    return fullI32Range().map(e => {
      return { input: i32(e), expected: i32(-e) };
    });
  },
});
