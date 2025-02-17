import { i32 } from '../../../../util/conversion';
import { fullI32Range } from '../../../../util/math';
import { makeCaseCache } from '../case_cache';

export const d = makeCaseCache('unary/i32_arithmetic', {
  negation: () => {
    return fullI32Range().map(e => {
      return { input: i32(e), expected: i32(-e) };
    });
  },
});
