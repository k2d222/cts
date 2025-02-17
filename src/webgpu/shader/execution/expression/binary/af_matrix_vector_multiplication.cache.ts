import { FP } from '../../../../util/floating_point.ts';
import { sparseMatrixF64Range, sparseVectorF64Range } from '../../../../util/math.ts';
import { selectNCases } from '../case.ts';
import { makeCaseCache } from '../case_cache.ts';

// Cases: matCxR_vecC
const mat_vec_cases = ([2, 3, 4] as const)
  .flatMap(cols =>
    ([2, 3, 4] as const).map(rows => ({
      [`mat${cols}x${rows}_vec${cols}`]: () => {
        return selectNCases(
          'binary/af_matrix_vector_multiplication_mat_vec',
          50,
          FP.abstract.generateMatrixVectorToVectorCases(
            sparseMatrixF64Range(cols, rows),
            sparseVectorF64Range(cols),
            'finite',
            // Matrix-vector multiplication has an inherited accuracy, so abstract is only expected to be as accurate as f32
            FP.f32.multiplicationMatrixVectorInterval
          )
        );
      },
    }))
  )
  .reduce((a, b) => ({ ...a, ...b }), {});

// Cases: vecR_matCxR
const vec_mat_cases = ([2, 3, 4] as const)
  .flatMap(rows =>
    ([2, 3, 4] as const).map(cols => ({
      [`vec${rows}_mat${cols}x${rows}`]: () => {
        return selectNCases(
          'binary/af_matrix_vector_multiplication_vec_mat',
          50,
          FP.abstract.generateVectorMatrixToVectorCases(
            sparseVectorF64Range(rows),
            sparseMatrixF64Range(cols, rows),
            'finite',
            // Vector-matrix multiplication has an inherited accuracy, so abstract is only expected to be as accurate as f32
            FP.f32.multiplicationVectorMatrixInterval
          )
        );
      },
    }))
  )
  .reduce((a, b) => ({ ...a, ...b }), {});

export const d = makeCaseCache('binary/af_matrix_vector_multiplication', {
  ...mat_vec_cases,
  ...vec_mat_cases,
});
