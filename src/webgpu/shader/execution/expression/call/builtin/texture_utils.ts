import { keysOf } from '../../../../../../common/util/data_tables.js';
import { assert, range, unreachable } from '../../../../../../common/util/util.js';
import { Float16Array } from '../../../../../../external/petamoriken/float16/float16.js';
import {
  ColorTextureFormat,
  EncodableTextureFormat,
  getBlockInfoForColorTextureFormat,
  getBlockInfoForTextureFormat,
  getTextureFormatType,
  is32Float,
  isColorTextureFormat,
  isCompressedFloatTextureFormat,
  isCompressedTextureFormat,
  isDepthOrStencilTextureFormat,
  isDepthTextureFormat,
  isEncodableTextureFormat,
  isSintOrUintFormat,
  isStencilTextureFormat,
  kEncodableTextureFormats,
} from '../../../../../format_info.js';
import { GPUTest } from '../../../../../gpu_test.js';
import {
  align,
  clamp,
  dotProduct,
  hashU32,
  lcm,
  lerp,
  quantizeToF32,
} from '../../../../../util/math.js';
import {
  effectiveViewDimensionForDimension,
  physicalMipSize,
  physicalMipSizeFromTexture,
  reifyTextureDescriptor,
  SampleCoord,
  virtualMipSize,
} from '../../../../../util/texture/base.js';
import {
  kTexelRepresentationInfo,
  NumericRange,
  PerComponentNumericRange,
  PerTexelComponent,
  TexelComponent,
  TexelRepresentationInfo,
} from '../../../../../util/texture/texel_data.js';
import { PerPixelAtLevel, TexelView } from '../../../../../util/texture/texel_view.js';
import { createTextureFromTexelViews } from '../../../../../util/texture.js';
import { reifyExtent3D } from '../../../../../util/unions.js';
import { ShaderStage } from '../../../../validation/decl/util.js';

// These are needed because the list of parameters was too long when converted to a filename.
export const kShortShaderStageToShaderStage = {
  c: 'compute' as ShaderStage,
  f: 'fragment' as ShaderStage,
  v: 'vertex' as ShaderStage,
} as const;
export const kShortShaderStages = keysOf(kShortShaderStageToShaderStage);
export type ShortShaderStage = (typeof kShortShaderStages)[number];

// These are needed because the list of parameters was too long when converted to a filename.
export const kShortAddressModeToAddressMode: Record<string, GPUAddressMode> = {
  c: 'clamp-to-edge',
  r: 'repeat',
  m: 'mirror-repeat',
};

export const kShortAddressModes = keysOf(kShortAddressModeToAddressMode);

export const kSampleTypeInfo = {
  f32: {
    format: 'rgba8unorm',
  },
  i32: {
    format: 'rgba8sint',
  },
  u32: {
    format: 'rgba8uint',
  },
} as const;

/**
 * Return the texture type for a given view dimension
 */
export function getTextureTypeForTextureViewDimension(viewDimension: GPUTextureViewDimension) {
  switch (viewDimension) {
    case '1d':
      return 'texture_1d<f32>';
    case '2d':
      return 'texture_2d<f32>';
    case '2d-array':
      return 'texture_2d_array<f32>';
    case '3d':
      return 'texture_3d<f32>';
    case 'cube':
      return 'texture_cube<f32>';
    case 'cube-array':
      return 'texture_cube_array<f32>';
    default:
      unreachable();
  }
}

const isUnencodableDepthFormat = (format: GPUTextureFormat) =>
  format === 'depth24plus' ||
  format === 'depth24plus-stencil8' ||
  format === 'depth32float-stencil8';

/**
 * Skips a subcase if the filter === 'linear' and the format is type
 * 'unfilterable-float' and we cannot enable filtering.
 */
export function skipIfTextureFormatNotSupportedOrNeedsFilteringAndIsUnfilterable(
  t: GPUTest,
  filter: GPUFilterMode,
  format: GPUTextureFormat
) {
  t.skipIfTextureFormatNotSupported(format);
  if (filter === 'linear') {
    t.skipIf(isDepthTextureFormat(format), 'depth texture are unfilterable');

    const type = getTextureFormatType(format);
    if (type === 'unfilterable-float') {
      assert(is32Float(format));
      t.skipIfDeviceDoesNotHaveFeature('float32-filterable');
    }
  }
}

/**
 * Returns if a texture format can be filled with random data.
 */
export function isFillable(format: GPUTextureFormat) {
  // We can't easily put random bytes into compressed textures if they are float formats
  // since we want the range to be +/- 1000 and not +/- infinity or NaN.
  return !isCompressedTextureFormat(format) || !format.endsWith('float');
}

/**
 * Returns if a texture format can potentially be filtered and can be filled with random data.
 */
export function isPotentiallyFilterableAndFillable(format: GPUTextureFormat) {
  const type = getTextureFormatType(format);
  const canPotentiallyFilter =
    type === 'float' || type === 'unfilterable-float' || type === 'depth';
  const result = canPotentiallyFilter && isFillable(format);
  return result;
}

const builtinNeedsMipLevelWeights = (builtin: TextureBuiltin) =>
  builtin !== 'textureLoad' &&
  builtin !== 'textureGather' &&
  builtin !== 'textureGatherCompare' &&
  builtin !== 'textureSampleBaseClampToEdge';

/**
 * Splits in array into multiple arrays where every Nth value goes to a different array
 */
function unzip<T>(array: T[], num: number, srcStride?: number) {
  srcStride = srcStride === undefined ? num : srcStride;
  const arrays: T[][] = range(num, () => []);
  const numEntries = Math.ceil(array.length / srcStride);
  for (let i = 0; i < numEntries; ++i) {
    for (let j = 0; j < num; ++j) {
      arrays[j].push(array[i * srcStride + j]);
    }
  }
  return arrays;
}

type MipWeights = {
  sampleLevelWeights?: number[];
  softwareMixToGPUMixGradWeights?: number[];
};
type MipWeightType = keyof MipWeights;

function makeGraph(width: number, height: number) {
  const data = new Uint8Array(width * height);

  return {
    plot(norm: number, x: number, c: number) {
      const y = clamp(Math.floor(norm * height), { min: 0, max: height - 1 });
      const offset = (height - y - 1) * width + x;
      data[offset] = c;
    },
    plotValues(values: Iterable<number>, c: number) {
      let i = 0;
      for (const v of values) {
        this.plot(v, i, c);
        ++i;
      }
    },
    toString(conversion = ['.', 'e', 'A']) {
      const lines = [];
      for (let y = 0; y < height; ++y) {
        const offset = y * width;
        lines.push([...data.subarray(offset, offset + width)].map(v => conversion[v]).join(''));
      }
      return lines.join('\n');
    },
  };
}

function* linear0to1OverN(n: number) {
  for (let i = 0; i <= n; ++i) {
    yield i / n;
  }
}

/**
 * Generates an ascii graph of weights
 */
export function graphWeights(height: number, weights: number[]) {
  const graph = makeGraph(weights.length, height);
  graph.plotValues(linear0to1OverN(weights.length - 1), 1);
  graph.plotValues(weights, 2);
  return graph.toString();
}

/**
 * Validates the weights go from 0 to 1 in increasing order.
 */
function validateWeights(t: GPUTest, stage: string, weights: number[]) {
  const showWeights = t.rec.debugging
    ? () => `
${weights.map((v, i) => `${i.toString().padStart(2)}: ${v}`).join('\n')}

e = expected
A = actual
${graphWeights(32, weights)}
`
    : () => ``;

  // Validate the weights
  assert(
    weights[0] === 0,
    `stage: ${stage}, weight 0 expected 0 but was ${weights[0]}\n${showWeights()}`
  );
  assert(
    weights[kMipLevelWeightSteps] === 1,
    `stage: ${stage}, top weight expected 1 but was ${
      weights[kMipLevelWeightSteps]
    }\n${showWeights()}`
  );

  // Test that we don't have a mostly flat set of weights.
  // This is also some small guarantee that we actually read something.
  // Note: Ideally every value is unique but 25% is about how many an Intel Mac
  // returns in a compute stage.
  const kMinPercentUniqueWeights = 25;
  assert(
    new Set(weights).size >= ((weights.length * kMinPercentUniqueWeights * 0.01) | 0),
    `stage: ${stage}, expected at least ~${kMinPercentUniqueWeights}% unique weights\n${showWeights()}`
  );
}

/**
 * In an attempt to pass on more devices without lowering the tolerances
 * so low they are meaningless, we ask the hardware to tell us, for a given
 * gradient, level, what mix weights are being used.
 *
 * This is done by drawing instanced quads and using instance_index to
 * write out results into an array. We sample a 2x2 pixel texture with
 * 2 mip levels and set the 2nd mip level to white. This means the value
 * we get back represents the weight used to mix the 2 mip levels.
 *
 * Just as a record of some differences across GPUs
 *
 * level weights: mapping from the mip level
 * parameter of `textureSampleLevel` to
 * the mix weight used by the GPU
 *
 * +--------+--------+--------+--------+
 * |        |        | intel  | amd    |
 * |        |  m1    | gen-9  | rna-1  |
 * | level  |  mac   | mac    | mac    |
 * +--------+--------+--------+--------+
 * | 0.0000 | 0.0000 | 0.0000 | 0.0000 |
 * | 0.0313 | 0.0314 | 0.0313 | 0.0000 |
 * | 0.0625 | 0.0625 | 0.0625 | 0.0000 |
 * | 0.0938 | 0.0939 | 0.0938 | 0.0000 |
 * | 0.1250 | 0.1250 | 0.1250 | 0.0313 |
 * | 0.1563 | 0.1564 | 0.1563 | 0.0703 |
 * | 0.1875 | 0.1875 | 0.1875 | 0.1094 |
 * | 0.2188 | 0.2189 | 0.2188 | 0.1484 |
 * | 0.2500 | 0.2500 | 0.2500 | 0.1875 |
 * | 0.2813 | 0.2814 | 0.2813 | 0.2266 |
 * | 0.3125 | 0.3125 | 0.3125 | 0.2656 |
 * | 0.3438 | 0.3439 | 0.3438 | 0.3047 |
 * | 0.3750 | 0.3750 | 0.3750 | 0.3438 |
 * | 0.4063 | 0.4064 | 0.4063 | 0.3828 |
 * | 0.4375 | 0.4375 | 0.4375 | 0.4219 |
 * | 0.4688 | 0.4689 | 0.4688 | 0.4609 |
 * | 0.5000 | 0.5000 | 0.5000 | 0.5000 |
 * | 0.5313 | 0.5314 | 0.5313 | 0.5391 |
 * | 0.5625 | 0.5625 | 0.5625 | 0.5781 |
 * | 0.5938 | 0.5939 | 0.5938 | 0.6172 |
 * | 0.6250 | 0.6250 | 0.6250 | 0.6563 |
 * | 0.6563 | 0.6564 | 0.6563 | 0.6953 |
 * | 0.6875 | 0.6875 | 0.6875 | 0.7344 |
 * | 0.7188 | 0.7189 | 0.7188 | 0.7734 |
 * | 0.7500 | 0.7500 | 0.7500 | 0.8125 |
 * | 0.7813 | 0.7814 | 0.7813 | 0.8516 |
 * | 0.8125 | 0.8125 | 0.8125 | 0.8906 |
 * | 0.8438 | 0.8439 | 0.8438 | 0.9297 |
 * | 0.8750 | 0.8750 | 0.8750 | 0.9688 |
 * | 0.9063 | 0.9064 | 0.9063 | 1.0000 |
 * | 0.9375 | 0.9375 | 0.9375 | 1.0000 |
 * | 0.9688 | 0.9689 | 0.9688 | 1.0000 |
 * | 1.0000 | 1.0000 | 1.0000 | 1.0000 |
 * +--------+--------+--------+--------+
 *
 * grad weights: mapping from ddx value
 * passed into `textureSampleGrad` to
 * the mix weight used by the GPU
 *
 * +--------+--------+--------+--------+
 * |        |        | intel  | amd    |
 * |        |  m1    | gen-9  | rna-1  |
 * |  ddx   |  mac   | mac    | mac    |
 * +--------+--------+--------+--------+
 * | 0.5000 | 0.0000 | 0.0000 | 0.0000 |
 * | 0.5109 | 0.0390 | 0.0430 | 0.0000 |
 * | 0.5221 | 0.0821 | 0.0859 | 0.0000 |
 * | 0.5336 | 0.1211 | 0.1289 | 0.0352 |
 * | 0.5453 | 0.1600 | 0.1719 | 0.0898 |
 * | 0.5572 | 0.2032 | 0.2109 | 0.1328 |
 * | 0.5694 | 0.2422 | 0.2461 | 0.1797 |
 * | 0.5819 | 0.2814 | 0.2852 | 0.2305 |
 * | 0.5946 | 0.3203 | 0.3203 | 0.2773 |
 * | 0.6076 | 0.3554 | 0.3594 | 0.3164 |
 * | 0.6209 | 0.3868 | 0.3906 | 0.3633 |
 * | 0.6345 | 0.4218 | 0.4258 | 0.4063 |
 * | 0.6484 | 0.4532 | 0.4609 | 0.4492 |
 * | 0.6626 | 0.4882 | 0.4922 | 0.4883 |
 * | 0.6771 | 0.5196 | 0.5234 | 0.5273 |
 * | 0.6920 | 0.5507 | 0.5547 | 0.5664 |
 * | 0.7071 | 0.5860 | 0.5859 | 0.6055 |
 * | 0.7226 | 0.6132 | 0.6133 | 0.6406 |
 * | 0.7384 | 0.6407 | 0.6445 | 0.6797 |
 * | 0.7546 | 0.6679 | 0.6719 | 0.7148 |
 * | 0.7711 | 0.6953 | 0.6992 | 0.7461 |
 * | 0.7880 | 0.7225 | 0.7266 | 0.7813 |
 * | 0.8052 | 0.7500 | 0.7539 | 0.8164 |
 * | 0.8229 | 0.7814 | 0.7813 | 0.8516 |
 * | 0.8409 | 0.8086 | 0.8086 | 0.8828 |
 * | 0.8593 | 0.8321 | 0.8320 | 0.9141 |
 * | 0.8781 | 0.8554 | 0.8594 | 0.9492 |
 * | 0.8974 | 0.8789 | 0.8828 | 0.9766 |
 * | 0.9170 | 0.9025 | 0.9063 | 1.0000 |
 * | 0.9371 | 0.9297 | 0.9297 | 1.0000 |
 * | 0.9576 | 0.9532 | 0.9531 | 1.0000 |
 * | 0.9786 | 0.9765 | 0.9766 | 1.0000 |
 * | 1.0000 | 1.0000 | 1.0000 | 1.0000 |
 * +--------+--------+--------+--------+
 */

export async function queryMipLevelMixWeightsForDevice(t: GPUTest, stage: ShaderStage) {
  const { device } = t;
  const kNumWeightTypes = 2;
  assert(kNumWeightTypes <= 4);
  const module = device.createShaderModule({
    code: `
      @group(0) @binding(0) var tex: texture_2d<f32>;
      @group(0) @binding(1) var smp: sampler;
      @group(0) @binding(2) var<storage, read_write> result: array<vec4f>;

      struct VSOutput {
        @builtin(position) pos: vec4f,
        @location(0) @interpolate(flat, either) ndx: u32,
        @location(1) @interpolate(flat, either) result: vec4f,
      };

      fn getMixLevels(wNdx: u32) -> vec4f {
        let mipLevel = f32(wNdx) / ${kMipLevelWeightSteps};
        let size = textureDimensions(tex);
        let g = mix(1.0, 2.0, mipLevel) / f32(size.x);
        let ddx = vec2f(g, 0);
        return vec4f(
          textureSampleLevel(tex, smp, vec2f(0.5), mipLevel).r,
          textureSampleGrad(tex, smp, vec2f(0.5), ddx, vec2f(0)).r,
          0,
          0);
      }

      fn getPosition(vNdx: u32) -> vec4f {
        let pos = array(
          vec2f(-1,  3),
          vec2f( 3, -1),
          vec2f(-1, -1),
        );
        let p = pos[vNdx];
        return vec4f(p, 0, 1);
      }

      // -- for getting fragment stage weights --

      @vertex fn vs(@builtin(vertex_index) vNdx: u32, @builtin(instance_index) iNdx: u32) -> VSOutput {
        return VSOutput(getPosition(vNdx), iNdx, vec4f(0));
      }

      @fragment fn fsRecord(v: VSOutput) -> @location(0) vec4u {
        return bitcast<vec4u>(getMixLevels(v.ndx));
      }

      // -- for getting compute stage weights --

      @compute @workgroup_size(1) fn csRecord(@builtin(global_invocation_id) id: vec3u) {
        result[id.x] = getMixLevels(id.x);
      }

      // -- for getting vertex stage weights --

      @vertex fn vsRecord(@builtin(vertex_index) vNdx: u32, @builtin(instance_index) iNdx: u32) -> VSOutput {
        return VSOutput(getPosition(vNdx), iNdx, getMixLevels(iNdx));
      }

      @fragment fn fsSaveVs(v: VSOutput) -> @location(0) vec4u {
        return bitcast<vec4u>(v.result);
      }
    `,
  });

  const texture = t.createTextureTracked({
    size: [2, 2, 1],
    format: 'r8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    mipLevelCount: 2,
  });

  device.queue.writeTexture(
    { texture, mipLevel: 1 },
    new Uint8Array([255]),
    { bytesPerRow: 1 },
    [1, 1]
  );

  const sampler = device.createSampler({
    minFilter: 'linear',
    magFilter: 'linear',
    mipmapFilter: 'linear',
  });

  const target = t.createTextureTracked({
    size: [kMipLevelWeightSteps + 1, 1],
    format: 'rgba32uint',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });

  const storageBuffer = t.createBufferTracked({
    label: 'queryMipLevelMixWeightsForDevice:storageBuffer',
    size: 4 * 4 * (kMipLevelWeightSteps + 1),
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });

  const resultBuffer = t.createBufferTracked({
    label: 'queryMipLevelMixWeightsForDevice:resultBuffer',
    size: align(storageBuffer.size, 256), // padded for copyTextureToBuffer
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });

  const createBindGroup = (pipeline: GPUComputePipeline | GPURenderPipeline) =>
    device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: texture.createView() },
        { binding: 1, resource: sampler },
        ...(stage === 'compute' ? [{ binding: 2, resource: { buffer: storageBuffer } }] : []),
      ],
    });

  const encoder = device.createCommandEncoder({ label: 'queryMipLevelMixWeightsForDevice' });
  switch (stage) {
    case 'compute': {
      const pipeline = device.createComputePipeline({
        layout: 'auto',
        compute: { module },
      });
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, createBindGroup(pipeline));
      pass.dispatchWorkgroups(kMipLevelWeightSteps + 1);
      pass.end();
      encoder.copyBufferToBuffer(storageBuffer, 0, resultBuffer, 0, storageBuffer.size);
      break;
    }
    case 'fragment': {
      const pipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fsRecord', targets: [{ format: 'rgba32uint' }] },
      });
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: target.createView(),
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, createBindGroup(pipeline));
      for (let x = 0; x <= kMipLevelWeightSteps; ++x) {
        pass.setViewport(x, 0, 1, 1, 0, 1);
        pass.draw(3, 1, 0, x);
      }
      pass.end();
      encoder.copyTextureToBuffer({ texture: target }, { buffer: resultBuffer }, [target.width]);
      break;
    }
    case 'vertex': {
      const pipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vsRecord' },
        fragment: { module, entryPoint: 'fsSaveVs', targets: [{ format: 'rgba32uint' }] },
      });
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: target.createView(),
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, createBindGroup(pipeline));
      for (let x = 0; x <= kMipLevelWeightSteps; ++x) {
        pass.setViewport(x, 0, 1, 1, 0, 1);
        pass.draw(3, 1, 0, x);
      }
      pass.end();
      encoder.copyTextureToBuffer({ texture: target }, { buffer: resultBuffer }, [target.width]);
      break;
    }
  }
  device.queue.submit([encoder.finish()]);

  await resultBuffer.mapAsync(GPUMapMode.READ);
  // need to map a sub-portion since we may have padded the buffer.
  const result = Array.from(
    new Float32Array(resultBuffer.getMappedRange(0, (kMipLevelWeightSteps + 1) * 16))
  );
  resultBuffer.unmap();
  resultBuffer.destroy();

  const [sampleLevelWeights, gradWeights] = unzip(result, kNumWeightTypes, 4);

  validateWeights(t, stage, sampleLevelWeights);
  validateWeights(t, stage, gradWeights);

  texture.destroy();
  storageBuffer.destroy();

  return {
    sampleLevelWeights,
    softwareMixToGPUMixGradWeights: generateSoftwareMixToGPUMixGradWeights(gradWeights, texture),
  };
}

// Given an array of ascending values and a value v, finds
// which indices in the array v is between. Returns the lower
// index and the mix weight between the 2 indices for v.
//
// In other words, if values = [10, 20, 30, 40, 50]
//
//    getIndexAndWeight(values, 38)  -> [2, 0.8]
//
// Example:
//
//    values = [10, 20, 30, 40, 50]
//    v = 38
//    [ndx, weight] = getIndexAndWeight(values, v);
//    v2 = lerp(values[ndx], values[ndx + 1], weight);
//    assert(v === v2)
function getIndexAndWeight(values: readonly number[], v: number) {
  assert(v >= values[0] && v <= values[values.length - 1]);
  let lo = 0;
  let hi = values.length - 1;
  for (;;) {
    const i = (lo + (hi - lo) / 2) | 0;
    const w0 = values[i];
    const w1 = values[i + 1];
    if (lo === hi || (v >= w0 && v <= w1)) {
      const weight = (v - w0) / (w1 - w0);
      return [i, weight];
    }
    if (v < w0) {
      hi = i;
    } else {
      lo = i + 1;
    }
  }
}

/**
 * Given a fractional number between 0 and values.length returns the value between
 * 2 values. Effectively lerp(values[ndx], values[ndx + 1], weight)
 */
function bilinearFilter(values: readonly number[], ndx: number, weight: number) {
  const v0 = values[ndx];
  const v1 = values[ndx + 1] ?? 0;
  assert(ndx < values.length - 1 || (ndx === values.length - 1 && weight === 0));
  return lerp(v0, v1, weight);
}

/**
 * Generates an array of values that maps between the software renderer's gradient computed
 * mip level and the GPUs gradient computed mip level for mip level 0 to 1.
 */
function generateSoftwareMixToGPUMixGradWeights(gpuWeights: number[], texture: GPUTexture) {
  const numSteps = gpuWeights.length - 1;
  const size = [texture.width, texture.height, texture.depthOrArrayLayers];
  const softwareWeights = range(numSteps + 1, i => {
    // u goes from 0 to 1
    const u = i / numSteps;
    const g = lerp(1, 2, u) / texture.width;
    const mipLevel = computeMipLevelFromGradients([g], [0], size);
    assert(mipLevel >= 0 && mipLevel <= 1);
    return mipLevel;
  });
  const softwareMixToGPUMixMap = range(numSteps + 1, i => {
    const mix = i / numSteps;
    const [ndx, weight] = getIndexAndWeight(softwareWeights, mix);
    return bilinearFilter(gpuWeights, ndx, weight);
  });
  return softwareMixToGPUMixMap;
}

function mapSoftwareMipLevelToGPUMipLevel(t: GPUTest, stage: ShaderStage, mipLevel: number) {
  const baseLevel = Math.floor(mipLevel);
  const softwareMix = mipLevel - baseLevel;
  const gpuMix = getMixWeightByTypeForMipLevel(
    t,
    stage,
    'softwareMixToGPUMixGradWeights',
    softwareMix
  );
  return baseLevel + gpuMix;
}

const euclideanModulo = (n: number, m: number) => ((n % m) + m) % m;

/**
 * Gets the mip gradient values for the current device.
 * The issue is, different GPUs have different ways of mixing between mip levels.
 * For most GPUs it's linear but for AMD GPUs on Mac in particular, it's something
 * else (which AFAICT is against all the specs).
 *
 * We seemingly have 3 options:
 *
 * 1. Increase the tolerances of tests so they pass on AMD.
 * 2. Mark AMD as failing
 * 3. Try to figure out how the GPU converts mip levels into weights
 *
 * We're doing 3.
 *
 * There's an assumption that the gradient will be the same for all formats
 * and usages.
 *
 * Note: The code below has 2 maps. One device->Promise, the other device->weights
 * device->weights is meant to be used synchronously by other code so we don't
 * want to leave initMipGradientValuesForDevice until the weights have been read.
 * But, multiple subcases will run because this function is async. So, subcase 1
 * runs, hits this init code, this code waits for the weights. Then, subcase 2
 * runs and hits this init code. The weights will not be in the device->weights map
 * yet which is why we have the device->Promise map. This is so subcase 2 waits
 * for subcase 1's "query the weights" step. Otherwise, all subcases would do the
 * "get the weights" step separately.
 */
const kMipLevelWeightSteps = 64;
const s_deviceToMipLevelWeightsPromise = new WeakMap<
  GPUDevice,
  Record<ShaderStage, Promise<MipWeights>>
>();
const s_deviceToMipLevelWeights = new WeakMap<GPUDevice, Record<ShaderStage, MipWeights>>();

async function initMipLevelWeightsForDevice(t: GPUTest, stage: ShaderStage) {
  const { device } = t;
  // Get the per stage promises (or make them)
  const stageWeightsP =
    s_deviceToMipLevelWeightsPromise.get(device) ??
    ({} as Record<ShaderStage, Promise<MipWeights>>);
  s_deviceToMipLevelWeightsPromise.set(device, stageWeightsP);

  let weightsP = stageWeightsP[stage];
  if (!weightsP) {
    // There was no promise for this weight so request it
    // and add a then clause so the first thing that will happen
    // when the promise resolves is that we'll record the weights for
    // that stage.
    weightsP = queryMipLevelMixWeightsForDevice(t, stage);
    weightsP
      .then(weights => {
        const stageWeights =
          s_deviceToMipLevelWeights.get(device) ?? ({} as Record<ShaderStage, MipWeights>);
        s_deviceToMipLevelWeights.set(device, stageWeights);
        stageWeights[stage] = weights;
      })
      .catch(e => {
        throw e;
      });
    stageWeightsP[stage] = weightsP;
  }
  return await weightsP;
}

function getMixWeightByTypeForMipLevel(
  t: GPUTest,
  stage: ShaderStage,
  weightType: MipWeightType | 'identity',
  mipLevel: number
) {
  if (weightType === 'identity') {
    return euclideanModulo(mipLevel, 1);
  }
  // linear interpolate between weights
  const weights = s_deviceToMipLevelWeights.get(t.device)![stage][weightType];
  assert(
    !!weights,
    'you must use WGSLTextureSampleTest or call initializeDeviceMipWeights before calling this function'
  );
  const steps = weights.length - 1;
  const w = euclideanModulo(mipLevel, 1) * steps;
  const lowerNdx = Math.floor(w);
  const upperNdx = Math.ceil(w);
  const mix = w % 1;
  return lerp(weights[lowerNdx], weights[upperNdx], mix);
}

function getWeightForMipLevel(
  t: GPUTest,
  stage: ShaderStage,
  weightType: MipWeightType | 'identity',
  mipLevelCount: number,
  mipLevel: number
) {
  if (mipLevel < 0 || mipLevel >= mipLevelCount) {
    return 1;
  }
  return getMixWeightByTypeForMipLevel(t, stage, weightType, mipLevel);
}

/**
 * Skip a test if the specific stage doesn't support storage textures.
 */
export function skipIfNoStorageTexturesInStage(t: GPUTest, stage: ShaderStage) {
  if (t.isCompatibility) {
    t.skipIf(
      stage === 'fragment' && !(t.device.limits.maxStorageTexturesInFragmentStage! > 0),
      'device does not support storage textures in fragment shaders'
    );
    t.skipIf(
      stage === 'vertex' && !(t.device.limits.maxStorageTexturesInVertexStage! > 0),
      'device does not support storage textures in vertex shaders'
    );
  }
}

/**
 * Runs a texture query like textureDimensions, textureNumLevels and expects
 * a particular result.
 */
export function executeTextureQueryAndExpectResult(
  t: GPUTest,
  stage: ShaderStage,
  code: string,
  texture: GPUTexture | GPUExternalTexture,
  viewDescriptor: GPUTextureViewDescriptor | undefined,
  expected: number[]
) {
  const { device } = t;

  const returnType = `vec4<u32>`;
  const castWGSL = `${returnType}(getValue()${range(4 - expected.length, () => ', 0').join('')})`;
  const stageWGSL =
    stage === 'vertex'
      ? `
// --------------------------- vertex stage shaders --------------------------------
@vertex fn vsVertex(
    @builtin(vertex_index) vertex_index : u32,
    @builtin(instance_index) instance_index : u32) -> VOut {
  let positions = array(vec2f(-1, 3), vec2f(3, -1), vec2f(-1, -1));
  return VOut(vec4f(positions[vertex_index], 0, 1),
              instance_index,
              ${castWGSL});
}

@fragment fn fsVertex(v: VOut) -> @location(0) vec4u {
  return bitcast<vec4u>(v.result);
}
`
      : stage === 'fragment'
      ? `
// --------------------------- fragment stage shaders --------------------------------
@vertex fn vsFragment(
    @builtin(vertex_index) vertex_index : u32,
    @builtin(instance_index) instance_index : u32) -> VOut {
  let positions = array(vec2f(-1, 3), vec2f(3, -1), vec2f(-1, -1));
  return VOut(vec4f(positions[vertex_index], 0, 1), instance_index, ${returnType}(0));
}

@fragment fn fsFragment(v: VOut) -> @location(0) vec4u {
  return bitcast<vec4u>(${castWGSL});
}
`
      : `
// --------------------------- compute stage shaders --------------------------------
@group(1) @binding(0) var<storage, read_write> results: array<${returnType}>;

@compute @workgroup_size(1) fn csCompute(@builtin(global_invocation_id) id: vec3u) {
  results[id.x] = ${castWGSL};
}
`;
  const wgsl = `
    ${code}

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) @interpolate(flat, either) ndx: u32,
  @location(1) @interpolate(flat, either) result: ${returnType},
};

    ${stageWGSL}
  `;
  const module = device.createShaderModule({ code: wgsl });

  const visibility =
    stage === 'compute'
      ? GPUShaderStage.COMPUTE
      : stage === 'fragment'
      ? GPUShaderStage.FRAGMENT
      : GPUShaderStage.VERTEX;

  const entries: GPUBindGroupLayoutEntry[] = [];
  if (code.includes('texture_external')) {
    entries.push({
      binding: 0,
      visibility,
      externalTexture: {},
    });
  } else if (code.includes('texture_storage')) {
    assert(texture instanceof GPUTexture);
    entries.push({
      binding: 0,
      visibility,
      storageTexture: {
        access: code.includes(', read>')
          ? 'read-only'
          : code.includes(', write>')
          ? 'write-only'
          : 'read-write',
        viewDimension: viewDescriptor?.dimension ?? '2d',
        format: texture.format,
      },
    });
  } else {
    assert(texture instanceof GPUTexture);
    const sampleType =
      viewDescriptor?.aspect === 'stencil-only'
        ? 'uint'
        : code.includes('texture_depth')
        ? 'depth'
        : isDepthTextureFormat(texture.format)
        ? 'unfilterable-float'
        : isStencilTextureFormat(texture.format)
        ? 'uint'
        : texture.sampleCount > 1 && getTextureFormatType(texture.format) === 'float'
        ? 'unfilterable-float'
        : getTextureFormatType(texture.format) ?? 'unfilterable-float';
    entries.push({
      binding: 0,
      visibility,
      texture: {
        sampleType,
        viewDimension: viewDescriptor?.dimension ?? '2d',
        multisampled: texture.sampleCount > 1,
      },
    });
  }

  const bindGroupLayouts: GPUBindGroupLayout[] = [device.createBindGroupLayout({ entries })];

  if (stage === 'compute') {
    bindGroupLayouts.push(
      device.createBindGroupLayout({
        entries: [
          {
            binding: 0,
            visibility: GPUShaderStage.COMPUTE,
            buffer: {
              type: 'storage',
              hasDynamicOffset: false,
              minBindingSize: 16,
            },
          },
        ],
      })
    );
  }

  const layout = device.createPipelineLayout({
    bindGroupLayouts,
  });

  let pipeline: GPUComputePipeline | GPURenderPipeline;

  switch (stage) {
    case 'compute':
      pipeline = device.createComputePipeline({
        layout,
        compute: { module },
      });
      break;
    case 'fragment':
    case 'vertex':
      pipeline = device.createRenderPipeline({
        layout,
        vertex: { module },
        fragment: {
          module,
          targets: [{ format: 'rgba32uint' }],
        },
      });
      break;
  }

  const bindGroup0 = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      {
        binding: 0,
        resource:
          texture instanceof GPUExternalTexture ? texture : texture.createView(viewDescriptor),
      },
    ],
  });

  const renderTarget = t.createTextureTracked({
    format: 'rgba32uint',
    size: [expected.length, 1],
    usage: GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT,
  });

  const resultBuffer = t.createBufferTracked({
    label: 'executeAndExpectResult:resultBuffer',
    size: align(expected.length * 4, 256),
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
  });

  let storageBuffer: GPUBuffer | undefined;
  const encoder = device.createCommandEncoder({ label: 'executeAndExpectResult' });

  if (stage === 'compute') {
    storageBuffer = t.createBufferTracked({
      label: 'executeAndExpectResult:storageBuffer',
      size: resultBuffer.size,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });

    const bindGroup1 = device.createBindGroup({
      layout: pipeline!.getBindGroupLayout(1),
      entries: [{ binding: 0, resource: { buffer: storageBuffer } }],
    });

    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline! as GPUComputePipeline);
    pass.setBindGroup(0, bindGroup0);
    pass.setBindGroup(1, bindGroup1);
    pass.dispatchWorkgroups(expected.length);
    pass.end();
    encoder.copyBufferToBuffer(storageBuffer, 0, resultBuffer, 0, storageBuffer.size);
  } else {
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: renderTarget.createView(),
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });

    pass.setPipeline(pipeline! as GPURenderPipeline);
    pass.setBindGroup(0, bindGroup0);
    for (let i = 0; i < expected.length; ++i) {
      pass.setViewport(i, 0, 1, 1, 0, 1);
      pass.draw(3, 1, 0, i);
    }
    pass.end();
    encoder.copyTextureToBuffer(
      { texture: renderTarget },
      {
        buffer: resultBuffer,
        bytesPerRow: resultBuffer.size,
      },
      [renderTarget.width, 1]
    );
  }
  t.device.queue.submit([encoder.finish()]);

  const e = new Uint32Array(4);
  e.set(expected);
  t.expectGPUBufferValuesEqual(resultBuffer, e);
}

/**
 * Used to specify a range from [0, num)
 * The type is used to determine if values should be integers and if they can be negative.
 */
export type RangeDef = {
  num: number;
  type: 'f32' | 'i32' | 'u32';
};

function getLimitValue(v: number) {
  switch (v) {
    case Number.POSITIVE_INFINITY:
      return 1000;
    case Number.NEGATIVE_INFINITY:
      return -1000;
    default:
      return v;
  }
}

function getMinAndMaxTexelValueForComponent(
  rep: TexelRepresentationInfo,
  component: TexelComponent
) {
  assert(!!rep.numericRange);
  const perComponentRanges = rep.numericRange as PerComponentNumericRange;
  const perComponentRange = perComponentRanges[component];
  const range = rep.numericRange as NumericRange;
  const { min, max } = perComponentRange ? perComponentRange : range;
  return { min: getLimitValue(min), max: getLimitValue(max) };
}

/**
 * We need the software rendering to do the same interpolation as the hardware
 * rendered so for -srgb formats we set the TexelView to an -srgb format as
 * TexelView handles this case. Note: It might be nice to add rgba32float-srgb
 * or something similar to TexelView.
 */
export function getTexelViewFormatForTextureFormat(format: GPUTextureFormat) {
  if (format.endsWith('sint')) {
    return 'rgba32sint';
  } else if (format.endsWith('uint')) {
    return 'rgba32uint';
  }
  return format.endsWith('-srgb') ? 'rgba8unorm-srgb' : 'rgba32float';
}

const kTextureTypeInfo = {
  depth: {
    componentType: 'f32',
    resultType: 'vec4f',
    resultFormat: 'rgba32float',
  },
  float: {
    componentType: 'f32',
    resultType: 'vec4f',
    resultFormat: 'rgba32float',
  },
  'unfilterable-float': {
    componentType: 'f32',
    resultType: 'vec4f',
    resultFormat: 'rgba32float',
  },
  sint: {
    componentType: 'i32',
    resultType: 'vec4i',
    resultFormat: 'rgba32sint',
  },
  uint: {
    componentType: 'u32',
    resultType: 'vec4u',
    resultFormat: 'rgba32uint',
  },
} as const;

export function getTextureFormatTypeInfo(format: GPUTextureFormat) {
  const type = getTextureFormatType(format);
  assert(!!type);
  return kTextureTypeInfo[type];
}

/**
 * given a texture type 'base', returns the base with the correct component for the given texture format.
 * eg: `getTextureType('texture_2d', someUnsignedIntTextureFormat)` -> `texture_2d<u32>`
 */
export function appendComponentTypeForFormatToTextureType(base: string, format: GPUTextureFormat) {
  return base.includes('depth')
    ? base
    : `${base}<${getTextureFormatTypeInfo(format).componentType}>`;
}

type RandomTextureOptions = {
  generator: PerPixelAtLevel<PerTexelComponent<number>>;
};

/**
 * Gets the baseMipLevel, mipLevelCount, size of the baseMipLevel,
 * baseArrayLayer, and arrayLayerCount
 * taking into account the texture descriptor and the view descriptor.
 */
function getBaseMipLevelInfo(textureInfo: SoftwareTexture) {
  const baseMipLevel = textureInfo.viewDescriptor.baseMipLevel ?? 0;
  const mipLevelCount =
    textureInfo.viewDescriptor.mipLevelCount ??
    (textureInfo.descriptor.mipLevelCount ?? 1) - baseMipLevel;
  const baseMipLevelSize = virtualMipSize(
    textureInfo.descriptor.dimension ?? '2d',
    textureInfo.descriptor.size,
    baseMipLevel
  );
  const baseArrayLayer = textureInfo.viewDescriptor.baseArrayLayer ?? 0;
  const arrayLayerCount =
    textureInfo.viewDescriptor.arrayLayerCount ?? baseMipLevelSize[2] - baseArrayLayer;
  baseMipLevelSize[2] = arrayLayerCount;
  return { baseMipLevel, baseMipLevelSize, mipLevelCount, baseArrayLayer, arrayLayerCount };
}

/**
 * Make a generator for texels for depth comparison tests.
 */
export function makeRandomDepthComparisonTexelGenerator(
  info: {
    format: GPUTextureFormat;
    size: GPUExtent3D;
  },
  comparison: GPUCompareFunction
) {
  const format = isUnencodableDepthFormat(info.format) ? 'depth32float' : info.format;
  const rep = kTexelRepresentationInfo[format as EncodableTextureFormat];
  const size = reifyExtent3D(info.size);

  const comparisonIsEqualOrNotEqual = comparison === 'equal' || comparison === 'not-equal';

  // for equal and not-equal we just want to test 0, 0.6, and 1
  // for everything else we want 0 to 1
  // Note: 0.6 is chosen because we'll never choose 0.6 as our depth reference
  // value. (see generateTextureBuiltinInputsImpl and generateSamplePointsCube)
  // The problem with comparing equal is other than 0.0 and 1.0, no other
  // values are guaranteed to be equal.
  const fixedValues = [0, 0.6, 1, 1];
  const encode = comparisonIsEqualOrNotEqual
    ? (norm: number) => fixedValues[(norm * (fixedValues.length - 1)) | 0]
    : (norm: number) => norm;

  return (coords: SampleCoord): Readonly<PerTexelComponent<number>> => {
    const texel: PerTexelComponent<number> = {};
    for (const component of rep.componentOrder) {
      const rnd = hashU32(
        coords.x,
        coords.y,
        coords.z,
        coords.sampleIndex ?? 0,
        component.charCodeAt(0),
        size.width,
        size.height,
        size.depthOrArrayLayers
      );
      const normalized = clamp(rnd / 0xffffffff, { min: 0, max: 1 });
      texel[component] = encode(normalized);
    }
    return quantize(texel, rep);
  };
}

function createRandomTexelViewViaColors(
  info: {
    format: GPUTextureFormat;
    size: GPUExtent3D;
    mipLevel: number;
  },
  options?: RandomTextureOptions | undefined
): TexelView {
  const rep = kTexelRepresentationInfo[info.format as EncodableTextureFormat];
  const size = reifyExtent3D(info.size);
  const minMax = Object.fromEntries(
    rep.componentOrder.map(component => [
      component,
      getMinAndMaxTexelValueForComponent(rep, component),
    ])
  );
  const generator = (coords: SampleCoord): Readonly<PerTexelComponent<number>> => {
    const texel: PerTexelComponent<number> = {};
    for (const component of rep.componentOrder) {
      const rnd = hashU32(
        coords.x,
        coords.y,
        coords.z,
        coords.sampleIndex ?? 0,
        component.charCodeAt(0),
        info.mipLevel,
        size.width,
        size.height,
        size.depthOrArrayLayers
      );
      const normalized = clamp(rnd / 0xffffffff, { min: 0, max: 1 });
      const { min, max } = minMax[component];
      texel[component] = lerp(min, max, normalized);
    }
    return quantize(texel, rep);
  };
  return TexelView.fromTexelsAsColors(
    info.format as EncodableTextureFormat,
    options?.generator ?? generator
  );
}

function createRandomTexelViewViaBytes(info: {
  format: GPUTextureFormat;
  size: GPUExtent3D;
  mipLevel: number;
  sampleCount: number;
}): TexelView {
  const { format } = info;
  const formatInfo = getBlockInfoForTextureFormat(format);
  const rep = kTexelRepresentationInfo[info.format as EncodableTextureFormat];
  assert(!!rep);
  const { bytesPerBlock } = formatInfo;
  assert(bytesPerBlock !== undefined && bytesPerBlock > 0);
  const size = physicalMipSize(reifyExtent3D(info.size), info.format, '2d', 0);
  const blocksAcross = Math.ceil(size.width / formatInfo.blockWidth);
  const blocksDown = Math.ceil(size.height / formatInfo.blockHeight);
  const bytesPerRow = blocksAcross * bytesPerBlock * info.sampleCount;
  const bytesNeeded = bytesPerRow * blocksDown * size.depthOrArrayLayers;
  const data = new Uint8Array(bytesNeeded);

  const hashBase =
    sumOfCharCodesOfString(info.format) +
    size.width +
    size.height +
    size.depthOrArrayLayers +
    info.mipLevel +
    info.sampleCount;

  if (info.format.includes('32float') || info.format.includes('16float')) {
    const { min, max } = getMinAndMaxTexelValueForComponent(rep, TexelComponent.R);
    const asFloat = info.format.includes('32float')
      ? new Float32Array(data.buffer)
      : new Float16Array(data.buffer);
    for (let i = 0; i < asFloat.length; ++i) {
      asFloat[i] = lerp(min, max, hashU32(hashBase + i) / 0xffff_ffff);
    }
  } else if (bytesNeeded % 4 === 0) {
    const asU32 = new Uint32Array(data.buffer);
    for (let i = 0; i < asU32.length; ++i) {
      asU32[i] = hashU32(hashBase + i);
    }
  } else {
    for (let i = 0; i < bytesNeeded; ++i) {
      data[i] = hashU32(hashBase + i);
    }
  }

  return TexelView.fromTextureDataByReference(info.format as EncodableTextureFormat, data, {
    bytesPerRow,
    rowsPerImage: size.height,
    subrectOrigin: [0, 0, 0],
    subrectSize: size,
  });
}

/**
 * Creates a TexelView filled with random values.
 */
function createRandomTexelView(
  info: {
    format: GPUTextureFormat;
    size: GPUExtent3D;
    mipLevel: number;
    sampleCount: number;
  },
  options?: RandomTextureOptions | undefined
): TexelView {
  const { format } = info;
  assert(!isCompressedTextureFormat(format));
  const type = getTextureFormatType(format);
  const canFillWithRandomTypedData =
    !options &&
    isEncodableTextureFormat(format) &&
    ((format.includes('norm') && type !== 'depth') ||
      format.includes('16float') ||
      (format.includes('32float') && type !== 'depth') ||
      type === 'sint' ||
      type === 'uint');

  return canFillWithRandomTypedData
    ? createRandomTexelViewViaBytes(info)
    : createRandomTexelViewViaColors(info, options);
}

/**
 * Creates a mip chain of TexelViews filled with random values
 */
function createRandomTexelViewMipmap(
  info: {
    format: GPUTextureFormat;
    size: GPUExtent3D;
    mipLevelCount?: number;
    dimension?: GPUTextureDimension;
    sampleCount?: number;
  },
  options?: RandomTextureOptions | undefined
): TexelView[] {
  const mipLevelCount = info.mipLevelCount ?? 1;
  const dimension = info.dimension ?? '2d';
  return range(mipLevelCount, i =>
    createRandomTexelView(
      {
        format: info.format,
        size: virtualMipSize(dimension, info.size, i),
        mipLevel: i,
        sampleCount: info.sampleCount ?? 1,
      },
      options
    )
  );
}

export type vec1 = [number]; // Because it's easy to deal with if these types are all array of number
export type vec2 = [number, number];
export type vec3 = [number, number, number];
export type vec4 = [number, number, number, number];
export type Dimensionality = vec1 | vec2 | vec3;

type TextureCallArgKeys = keyof TextureCallArgs<vec1>;
const kTextureCallArgNames: readonly TextureCallArgKeys[] = [
  'component',
  'coords',
  'derivativeMult', // NOTE: derivativeMult not an argument but is used with coords for implicit derivatives.
  'arrayIndex',
  'bias',
  'sampleIndex',
  'mipLevel',
  'ddx',
  'ddy',
  'depthRef',
  'offset',
] as const;

export interface TextureCallArgs<T extends Dimensionality> {
  component?: number; // Used by textureGather
  coords?: T; // The coord passed
  derivativeMult?: T;
  mipLevel?: number;
  arrayIndex?: number;
  bias?: number;
  sampleIndex?: number;
  depthRef?: number;
  ddx?: T;
  ddy?: T;
  offset?: T;
}

export type TextureBuiltin =
  | 'textureGather'
  | 'textureGatherCompare'
  | 'textureLoad'
  | 'textureSample'
  | 'textureSampleBaseClampToEdge'
  | 'textureSampleBias'
  | 'textureSampleCompare'
  | 'textureSampleCompareLevel'
  | 'textureSampleGrad'
  | 'textureSampleLevel';

export interface TextureCall<T extends Dimensionality> extends TextureCallArgs<T> {
  builtin: TextureBuiltin;
  coordType: 'f' | 'i' | 'u';
  levelType?: 'i' | 'u' | 'f';
  arrayIndexType?: 'i' | 'u';
  sampleIndexType?: 'i' | 'u';
  componentType?: 'i' | 'u';
}

const isBuiltinComparison = (builtin: TextureBuiltin) =>
  builtin === 'textureGatherCompare' ||
  builtin === 'textureSampleCompare' ||
  builtin === 'textureSampleCompareLevel';
const isBuiltinGather = (builtin: TextureBuiltin | undefined) =>
  builtin === 'textureGather' || builtin === 'textureGatherCompare';
const builtinNeedsSampler = (builtin: TextureBuiltin) =>
  builtin.startsWith('textureSample') || builtin.startsWith('textureGather');
const builtinNeedsDerivatives = (builtin: TextureBuiltin) =>
  builtin === 'textureSample' ||
  builtin === 'textureSampleBias' ||
  builtin === 'textureSampleCompare';

const isCubeViewDimension = (viewDescriptor?: GPUTextureViewDescriptor) =>
  viewDescriptor?.dimension === 'cube' || viewDescriptor?.dimension === 'cube-array';

const isViewDimensionCubeOrCubeArray = (viewDimension: GPUTextureViewDimension) =>
  viewDimension === 'cube' || viewDimension === 'cube-array';

const s_u32 = new Uint32Array(1);
const s_f32 = new Float32Array(s_u32.buffer);
const s_i32 = new Int32Array(s_u32.buffer);

const kBitCastFunctions = {
  f: (v: number) => {
    s_f32[0] = v;
    return s_u32[0];
  },
  i: (v: number) => {
    s_i32[0] = v;
    assert(s_i32[0] === v, 'check we are not casting non-int or out-of-range value');
    return s_u32[0];
  },
  u: (v: number) => {
    s_u32[0] = v;
    assert(s_u32[0] === v, 'check we are not casting non-uint or out-of-range value');
    return s_u32[0];
  },
};

function getCallArgType<T extends Dimensionality>(
  call: TextureCall<T>,
  argName: (typeof kTextureCallArgNames)[number]
) {
  switch (argName) {
    case 'coords':
    case 'derivativeMult':
      return call.coordType;
    case 'component':
      assert(call.componentType !== undefined);
      return call.componentType;
    case 'mipLevel':
      assert(call.levelType !== undefined);
      return call.levelType;
    case 'arrayIndex':
      assert(call.arrayIndexType !== undefined);
      return call.arrayIndexType;
    case 'sampleIndex':
      assert(call.sampleIndexType !== undefined);
      return call.sampleIndexType;
    case 'bias':
    case 'depthRef':
    case 'ddx':
    case 'ddy':
      return 'f';
    default:
      unreachable();
  }
}

function toArray(coords: Dimensionality): number[] {
  if (coords instanceof Array) {
    return coords;
  }
  return [coords];
}

function quantize(texel: PerTexelComponent<number>, repl: TexelRepresentationInfo) {
  return repl.bitsToNumber(repl.unpackBits(new Uint8Array(repl.pack(repl.encode(texel)))));
}

function apply(a: number[], b: number[], op: (x: number, y: number) => number) {
  assert(a.length === b.length, `apply(${a}, ${b}): arrays must have same length`);
  return a.map((v, i) => op(v, b[i]));
}

/**
 * At the corner of a cubemap we need to sample just 3 texels, not 4.
 * The texels are in
 *
 *   0:  (u,v)
 *   1:  (u + 1, v)
 *   2:  (u, v + 1)
 *   3:  (u + 1, v + 1)
 *
 * We pass in the original 2d (converted from cubemap) texture coordinate.
 * If it's within half a pixel of the edge in both directions then it's
 * a corner so we return the index of the one texel that's not needed.
 * Otherwise we return -1.
 */
function getUnusedCubeCornerSampleIndex(textureSize: number, coords: vec3) {
  const u = coords[0] * textureSize;
  const v = coords[1] * textureSize;
  if (v < 0.5) {
    if (u < 0.5) {
      return 0;
    } else if (u >= textureSize - 0.5) {
      return 1;
    }
  } else if (v >= textureSize - 0.5) {
    if (u < 0.5) {
      return 2;
    } else if (u >= textureSize - 0.5) {
      return 3;
    }
  }
  return -1;
}

const add = (a: number[], b: number[]) => apply(a, b, (x, y) => x + y);

/**
 * The data needed by the software rendered to simulate a texture.
 * In particular, it needs texels (the data), it needs a descriptor
 * for the size, format, and dimension, and it needs a view descriptor
 * for the viewDimension, baseMipLevel, mipLevelCount, baseArrayLayer,
 * and arrayLayerCount.
 */
export interface SoftwareTexture {
  texels: TexelView[];
  descriptor: GPUTextureDescriptor;
  viewDescriptor: GPUTextureViewDescriptor;
}

/**
 * Converts the src texel representation to an RGBA representation.
 */
export function convertPerTexelComponentToResultFormat(
  src: PerTexelComponent<number>,
  format: EncodableTextureFormat
): PerTexelComponent<number> {
  const rep = kTexelRepresentationInfo[format];
  const out: PerTexelComponent<number> = { R: 0, G: 0, B: 0, A: 1 };
  for (const component of rep.componentOrder) {
    switch (component) {
      case 'Stencil':
      case 'Depth':
        out.R = src[component];
        break;
      default:
        assert(out[component] !== undefined); // checks that component = R, G, B or A
        out[component] = src[component];
    }
  }
  return out;
}

/**
 * Convert RGBA result format to texel view format.
 * Example, converts
 *   { R: 0.1, G: 0, B: 0, A: 1 } to { Depth: 0.1 }
 *   { R: 0.1 } to { R: 0.1, G: 0, B: 0, A: 1 }
 */
function convertToTexelViewFormat(src: PerTexelComponent<number>, format: GPUTextureFormat) {
  const componentOrder = isDepthTextureFormat(format)
    ? [TexelComponent.Depth]
    : isStencilTextureFormat(format)
    ? [TexelComponent.Stencil]
    : [TexelComponent.R, TexelComponent.G, TexelComponent.B, TexelComponent.A];
  const out: PerTexelComponent<number> = {};
  for (const component of componentOrder) {
    let v = src[component];
    if (v === undefined) {
      if (component === 'Depth' || component === 'Stencil') {
        v = src.R;
      } else if (component === 'G' || component === 'B') {
        v = 0;
      } else {
        v = 1;
      }
    }
    out[component] = v;
  }
  return out;
}

/**
 * Convert RGBA result format to texel view format of src texture.
 * Effectively this converts something like { R: 0.1, G: 0, B: 0, A: 1 }
 * to { Depth: 0.1 }
 */
function convertResultFormatToTexelViewFormat(
  src: PerTexelComponent<number>,
  format: EncodableTextureFormat
): PerTexelComponent<number> {
  const rep = kTexelRepresentationInfo[format];
  const out: PerTexelComponent<number> = {};
  for (const component of rep.componentOrder) {
    out[component] = src[component] ?? src.R;
  }
  return out;
}

function zeroValuePerTexelComponent(components: TexelComponent[]) {
  const out: PerTexelComponent<number> = {};
  for (const component of components) {
    out[component] = 0;
  }
  return out;
}

const kSamplerFns: Record<GPUCompareFunction, (ref: number, v: number) => boolean> = {
  never: (ref: number, v: number) => false,
  less: (ref: number, v: number) => ref < v,
  equal: (ref: number, v: number) => ref === v,
  'less-equal': (ref: number, v: number) => ref <= v,
  greater: (ref: number, v: number) => ref > v,
  'not-equal': (ref: number, v: number) => ref !== v,
  'greater-equal': (ref: number, v: number) => ref >= v,
  always: (ref: number, v: number) => true,
} as const;

function applyCompare<T extends Dimensionality>(
  call: TextureCall<T>,
  sampler: GPUSamplerDescriptor | undefined,
  components: TexelComponent[],
  src: PerTexelComponent<number>
): PerTexelComponent<number> {
  if (isBuiltinComparison(call.builtin)) {
    assert(sampler !== undefined);
    assert(call.depthRef !== undefined);
    const out: PerTexelComponent<number> = {};
    const compareFn = kSamplerFns[sampler.compare!];
    for (const component of components) {
      out[component] = compareFn(call.depthRef, src[component]!) ? 1 : 0;
    }
    return out;
  } else {
    return src;
  }
}

function getEffectiveLodClamp(
  builtin: TextureBuiltin,
  sampler: GPUSamplerDescriptor | undefined,
  softwareTexture: SoftwareTexture
) {
  const { mipLevelCount } = getBaseMipLevelInfo(softwareTexture);

  const lodMinClamp =
    isBuiltinGather(builtin) || sampler?.lodMinClamp === undefined ? 0 : sampler.lodMinClamp;
  const lodMaxClamp =
    isBuiltinGather(builtin) || sampler?.lodMaxClamp === undefined
      ? mipLevelCount - 1
      : sampler.lodMaxClamp;
  assert(lodMinClamp >= 0 && lodMinClamp < mipLevelCount, 'lodMinClamp in range');
  assert(lodMaxClamp >= 0 && lodMaxClamp < mipLevelCount, 'lodMaxClamp in range');
  assert(lodMinClamp <= lodMinClamp, 'lodMinClamp <= lodMaxClamp');

  return { min: lodMinClamp, max: lodMaxClamp };
}

/**
 * Returns the expect value for a WGSL builtin texture function for a single
 * mip level
 */
function softwareTextureReadMipLevel<T extends Dimensionality>(
  call: TextureCall<T>,
  softwareTexture: SoftwareTexture,
  sampler: GPUSamplerDescriptor | undefined,
  mipLevel: number
): PerTexelComponent<number> {
  assert(mipLevel % 1 === 0);
  const { format } = softwareTexture.texels[0];
  const rep = kTexelRepresentationInfo[format];
  const { baseMipLevel, baseMipLevelSize, baseArrayLayer, arrayLayerCount } =
    getBaseMipLevelInfo(softwareTexture);
  const mipLevelSize = virtualMipSize(
    softwareTexture.descriptor.dimension || '2d',
    baseMipLevelSize,
    mipLevel
  );

  const addressMode: GPUAddressMode[] =
    call.builtin === 'textureSampleBaseClampToEdge'
      ? ['clamp-to-edge', 'clamp-to-edge', 'clamp-to-edge']
      : [
          sampler?.addressModeU ?? 'clamp-to-edge',
          sampler?.addressModeV ?? 'clamp-to-edge',
          sampler?.addressModeW ?? 'clamp-to-edge',
        ];

  const isCube = isCubeViewDimension(softwareTexture.viewDescriptor);
  const arrayIndexMult = isCube ? 6 : 1;
  const numLayers = arrayLayerCount / arrayIndexMult;
  assert(numLayers % 1 === 0);
  const textureSizeForCube = [mipLevelSize[0], mipLevelSize[1], 6];

  const load = (at: number[]) => {
    const zFromArrayIndex =
      call.arrayIndex !== undefined
        ? clamp(call.arrayIndex, { min: 0, max: numLayers - 1 }) * arrayIndexMult
        : 0;
    return softwareTexture.texels[mipLevel + baseMipLevel].color({
      x: Math.floor(at[0]),
      y: Math.floor(at[1] ?? 0),
      z: Math.floor(at[2] ?? 0) + zFromArrayIndex + baseArrayLayer,
      sampleIndex: call.sampleIndex,
    });
  };

  switch (call.builtin) {
    case 'textureGather':
    case 'textureGatherCompare':
    case 'textureSample':
    case 'textureSampleBias':
    case 'textureSampleBaseClampToEdge':
    case 'textureSampleCompare':
    case 'textureSampleCompareLevel':
    case 'textureSampleGrad':
    case 'textureSampleLevel': {
      let coords = toArray(call.coords!);

      if (isCube) {
        coords = convertCubeCoordToNormalized3DTextureCoord(coords as vec3);
      }

      // convert normalized to absolute texel coordinate
      // ┌───┬───┬───┬───┐
      // │ a │   │   │   │  norm: a = 1/8, b = 7/8
      // ├───┼───┼───┼───┤   abs: a = 0,   b = 3
      // │   │   │   │   │
      // ├───┼───┼───┼───┤
      // │   │   │   │   │
      // ├───┼───┼───┼───┤
      // │   │   │   │ b │
      // └───┴───┴───┴───┘
      let at = coords.map((v, i) => v * (isCube ? textureSizeForCube : mipLevelSize)[i] - 0.5);

      // Apply offset in whole texel units
      // This means the offset is added at each mip level in texels. There's no
      // scaling for each level.
      if (call.offset !== undefined) {
        at = add(at, toArray(call.offset));
      }

      const samples: { at: number[]; weight: number }[] = [];

      const filter = isBuiltinGather(call.builtin) ? 'linear' : sampler?.minFilter ?? 'nearest';
      switch (filter) {
        case 'linear': {
          // 'p0' is the lower texel for 'at'
          const p0 = at.map(v => Math.floor(v));
          // 'p1' is the higher texel for 'at'
          // If it's cube then don't advance Z.
          const p1 = p0.map((v, i) => v + (isCube ? (i === 2 ? 0 : 1) : 1));

          // interpolation weights for p0 and p1
          const p1W = at.map((v, i) => v - p0[i]);
          const p0W = p1W.map(v => 1 - v);

          switch (coords.length) {
            case 1:
              samples.push({ at: p0, weight: p0W[0] });
              samples.push({ at: p1, weight: p1W[0] });
              break;
            case 2: {
              // Note: These are ordered to match textureGather
              samples.push({ at: [p0[0], p1[1]], weight: p0W[0] * p1W[1] });
              samples.push({ at: p1, weight: p1W[0] * p1W[1] });
              samples.push({ at: [p1[0], p0[1]], weight: p1W[0] * p0W[1] });
              samples.push({ at: p0, weight: p0W[0] * p0W[1] });
              break;
            }
            case 3: {
              // cube sampling, here in the software renderer, is the same
              // as 2d sampling. We'll sample at most 4 texels. The weights are
              // the same as if it was just one plane. If the points fall outside
              // the slice they'll be wrapped by wrapFaceCoordToCubeFaceAtEdgeBoundaries
              // below.
              if (isCube) {
                // Note: These are ordered to match textureGather
                samples.push({ at: [p0[0], p1[1], p0[2]], weight: p0W[0] * p1W[1] });
                samples.push({ at: p1, weight: p1W[0] * p1W[1] });
                samples.push({ at: [p1[0], p0[1], p0[2]], weight: p1W[0] * p0W[1] });
                samples.push({ at: p0, weight: p0W[0] * p0W[1] });
                const ndx = getUnusedCubeCornerSampleIndex(mipLevelSize[0], coords as vec3);
                if (ndx >= 0) {
                  // # Issues with corners of cubemaps
                  //
                  // note: I tried multiple things here
                  //
                  // 1. distribute 1/3 of the weight of the removed sample to each of the remaining samples
                  // 2. distribute 1/2 of the weight of the removed sample to the 2 samples that are not the "main" sample.
                  // 3. normalize the weights of the remaining 3 samples.
                  //
                  // none of them matched the M1 in all cases. Checking the dEQP I found this comment
                  //
                  // > If any of samples is out of both edges, implementations can do pretty much anything according to spec.
                  // https://github.com/KhronosGroup/VK-GL-CTS/blob/d2d6aa65607383bb29c8398fe6562c6b08b4de57/framework/common/tcuTexCompareVerifier.cpp#L882
                  //
                  // If I understand this correctly it matches the OpenGL ES 3.1 spec it says
                  // it's implementation defined.
                  //
                  // > OpenGL ES 3.1 section 8.12.1 Seamless Cubemap Filtering
                  // >
                  // > -  If a texture sample location would lie in the texture
                  // >    border in both u and v (in one of the corners of the
                  // >    cube), there is no unique neighboring face from which to
                  // >    extract one texel. The recommended method to generate this
                  // >    texel is to average the values of the three available
                  // >    samples. However, implementations are free to construct
                  // >    this fourth texel in another way, so long as, when the
                  // >    three available samples have the same value, this texel
                  // >    also has that value.
                  //
                  // I'm not sure what "average the values of the three available samples"
                  // means. To me that would be (a+b+c)/3 or in other words, set all the
                  // weights to 0.33333 but that's not what the M1 is doing.
                  //
                  // We could check that, given the 3 texels at the corner, if all 3 texels
                  // are the same value then the result must be the same value. Otherwise,
                  // the result must be between the 3 values. For now, the code that
                  // chooses test coordinates avoids corners. This has the restriction
                  // that the smallest mip level be at least 4x4 so there are some non
                  // corners to choose from.
                  unreachable(
                    `corners of cubemaps are not testable:\n   ${describeTextureCall(call)}`
                  );
                }
              } else {
                const p = [p0, p1];
                const w = [p0W, p1W];
                for (let z = 0; z < 2; ++z) {
                  for (let y = 0; y < 2; ++y) {
                    for (let x = 0; x < 2; ++x) {
                      samples.push({
                        at: [p[x][0], p[y][1], p[z][2]],
                        weight: w[x][0] * w[y][1] * w[z][2],
                      });
                    }
                  }
                }
              }
              break;
            }
          }
          break;
        }
        case 'nearest': {
          const p = at.map(v => Math.round(quantizeToF32(v)));
          samples.push({ at: p, weight: 1 });
          break;
        }
        default:
          unreachable();
      }

      if (isBuiltinGather(call.builtin)) {
        const componentNdx = call.component ?? 0;
        assert(componentNdx >= 0 && componentNdx < 4);
        assert(samples.length === 4);
        const component = kRGBAComponents[componentNdx];
        const out: PerTexelComponent<number> = {};
        samples.forEach((sample, i) => {
          const c = isCube
            ? wrapFaceCoordToCubeFaceAtEdgeBoundaries(mipLevelSize[0], sample.at as vec3)
            : applyAddressModesToCoords(addressMode, mipLevelSize, sample.at);
          const v = load(c);
          const postV = applyCompare(call, sampler, rep.componentOrder, v);
          const rgba = convertPerTexelComponentToResultFormat(postV, format);
          out[kRGBAComponents[i]] = rgba[component];
        });
        return out;
      }

      const out: PerTexelComponent<number> = {};
      for (const sample of samples) {
        const c = isCube
          ? wrapFaceCoordToCubeFaceAtEdgeBoundaries(mipLevelSize[0], sample.at as vec3)
          : applyAddressModesToCoords(addressMode, mipLevelSize, sample.at);
        const v = load(c);
        const postV = applyCompare(call, sampler, rep.componentOrder, v);
        for (const component of rep.componentOrder) {
          out[component] = (out[component] ?? 0) + postV[component]! * sample.weight;
        }
      }

      return convertPerTexelComponentToResultFormat(out, format);
    }
    case 'textureLoad': {
      const out: PerTexelComponent<number> = isOutOfBoundsCall(softwareTexture, call)
        ? zeroValuePerTexelComponent(rep.componentOrder)
        : load(call.coords!);
      return convertPerTexelComponentToResultFormat(out, format);
    }
    default:
      unreachable();
  }
}

/**
 * Reads a texture, optionally sampling between 2 mipLevels
 */
function softwareTextureReadLevel<T extends Dimensionality>(
  t: GPUTest,
  stage: ShaderStage,
  call: TextureCall<T>,
  softwareTexture: SoftwareTexture,
  sampler: GPUSamplerDescriptor | undefined,
  mipLevel: number
): PerTexelComponent<number> {
  if (!sampler) {
    return softwareTextureReadMipLevel<T>(call, softwareTexture, sampler, mipLevel);
  }

  const { mipLevelCount } = getBaseMipLevelInfo(softwareTexture);
  const lodClampMinMax = getEffectiveLodClamp(call.builtin, sampler, softwareTexture);
  const effectiveMipmapFilter = isBuiltinGather(call.builtin) ? 'nearest' : sampler.mipmapFilter;
  switch (effectiveMipmapFilter) {
    case 'linear': {
      const clampedMipLevel = clamp(mipLevel, lodClampMinMax);
      const rootMipLevel = Math.floor(clampedMipLevel);
      const nextMipLevel = Math.ceil(clampedMipLevel);
      const t0 = softwareTextureReadMipLevel<T>(call, softwareTexture, sampler, rootMipLevel);
      const t1 = softwareTextureReadMipLevel<T>(call, softwareTexture, sampler, nextMipLevel);
      const weightType = call.builtin === 'textureSampleLevel' ? 'sampleLevelWeights' : 'identity';
      const mix = getWeightForMipLevel(t, stage, weightType, mipLevelCount, clampedMipLevel);
      assert(mix >= 0 && mix <= 1);
      const values = [
        { v: t0, weight: 1 - mix },
        { v: t1, weight: mix },
      ];
      const out: PerTexelComponent<number> = {};
      for (const { v, weight } of values) {
        for (const component of kRGBAComponents) {
          out[component] = (out[component] ?? 0) + v[component]! * weight;
        }
      }
      return out;
    }
    default: {
      const baseMipLevel = Math.floor(clamp(mipLevel, lodClampMinMax) + 0.5);
      return softwareTextureReadMipLevel<T>(call, softwareTexture, sampler, baseMipLevel);
    }
  }
}

function computeMipLevelFromGradients(
  ddx: readonly number[],
  ddy: readonly number[],
  baseMipLevelSize: GPUExtent3D
) {
  const texSize = reifyExtent3D(baseMipLevelSize);
  const textureSize = [texSize.width, texSize.height, texSize.depthOrArrayLayers];

  // Compute the mip level the same way textureSampleGrad does according to the spec.
  const scaledDdx = ddx.map((v, i) => v * textureSize[i]);
  const scaledDdy = ddy.map((v, i) => v * textureSize[i]);
  const dotDDX = dotProduct(scaledDdx, scaledDdx);
  const dotDDY = dotProduct(scaledDdy, scaledDdy);
  const deltaMax = Math.max(dotDDX, dotDDY);
  const mipLevel = 0.5 * Math.log2(deltaMax);
  return mipLevel;
}

function computeMipLevelFromGradientsForCall<T extends Dimensionality>(
  call: TextureCall<T>,
  baseMipLevelSize: GPUExtent3D
) {
  assert(!!call.ddx);
  assert(!!call.ddy);
  // ddx and ddy are the values that would be passed to textureSampleGrad
  // If we're emulating textureSample then they're the computed derivatives
  // such that if we passed them to textureSampleGrad they'd produce the
  // same result.
  const ddx: readonly number[] = typeof call.ddx === 'number' ? [call.ddx] : call.ddx;
  const ddy: readonly number[] = typeof call.ddy === 'number' ? [call.ddy] : call.ddy;

  return computeMipLevelFromGradients(ddx, ddy, baseMipLevelSize);
}

/**
 * The software version of textureSampleGrad except with optional level.
 */
function softwareTextureReadGrad<T extends Dimensionality>(
  t: GPUTest,
  stage: ShaderStage,
  call: TextureCall<T>,
  softwareTexture: SoftwareTexture,
  sampler?: GPUSamplerDescriptor
): PerTexelComponent<number> {
  const bias = call.bias === undefined ? 0 : clamp(call.bias, { min: -16.0, max: 15.99 });
  if (call.ddx) {
    const { mipLevelCount, baseMipLevelSize } = getBaseMipLevelInfo(softwareTexture);
    const mipLevel = computeMipLevelFromGradientsForCall(call, baseMipLevelSize);
    const clampedMipLevel = clamp(mipLevel + bias, { min: 0, max: mipLevelCount - 1 });
    const weightMipLevel = mapSoftwareMipLevelToGPUMipLevel(t, stage, clampedMipLevel);
    return softwareTextureReadLevel(t, stage, call, softwareTexture, sampler, weightMipLevel);
  } else {
    return softwareTextureReadLevel(
      t,
      stage,
      call,
      softwareTexture,
      sampler,
      (call.mipLevel ?? 0) + bias
    );
  }
}

/**
 * This must match the code in doTextureCalls for derivativeBase
 *
 * Note: normal implicit derivatives are computed like this
 *
 * fn textureSample(T, S, coord) -> vec4f {
 *    return textureSampleGrad(T, S, dpdx(coord), dpdy(coord));
 * }
 *
 * dpdx and dpdy are effectively computed by,
 * getting the values of coord for 2x2 adjacent texels.
 *
 *   p0 = coord value at x, y
 *   p1 = coord value at x + 1, y
 *   p2 = coord value at x, y + 1
 *   p3 = coord value at x + 1, y + 1
 *
 * dpdx is the average delta in x and dpdy is the average delta in y
 *
 *   dpdx = (p1 - p0 + p3 - p2) / 2   // average of horizontal change
 *   dpdy = (p2 - p0 + p3 - p1) / 2   // average of vertical change
 *
 * derivativeBase is
 *
 *       '1d'    '2d'     '3d'
 *   p0 = [0]   [0, 0]  [0, 0, 0]
 *   p1 = [1]   [1, 0]  [1, 0, 0]
 *   p2 = [0]   [0, 1]  [0, 1, 0]
 *   p3 = [1]   [1, 1]  [1, 1, 0]
 *
 * But, these values are normalized texels coords so if the src texture
 * is 8x8 these would be * 0.125
 *
 * Note: to test other derivatives we add in a multiplier but,
 * this base gives us something to add that starts at 0,0 at the call
 * but who's derivatives we can easily set. We need the default
 * derivativeBase to be 1 otherwise it's 0 which makes the computed mip level
 * be -Infinity which means bias in `textureSampleBias` has no meaning.
 */
function derivativeBaseForCall<T extends Dimensionality>(
  softwareTexture: SoftwareTexture,
  isDDX: boolean
) {
  const { baseMipLevelSize } = getBaseMipLevelInfo(softwareTexture);
  if (isCubeViewDimension(softwareTexture.viewDescriptor)) {
    return (isDDX ? [1 / baseMipLevelSize[0], 0, 1] : [0, 1 / baseMipLevelSize[1], 1]) as T;
  } else if (softwareTexture.descriptor.dimension === '3d') {
    return (isDDX ? [1 / baseMipLevelSize[0], 0, 0] : [0, 1 / baseMipLevelSize[1], 0]) as T;
  } else if (softwareTexture.descriptor.dimension === '1d') {
    return [1 / baseMipLevelSize[0]] as T;
  } else {
    return (isDDX ? [1 / baseMipLevelSize[0], 0] : [0, 1 / baseMipLevelSize[1]]) as T;
  }
}

/**
 * Multiplies derivativeBase by derivativeMult or 1
 */
function derivativeForCall<T extends Dimensionality>(
  softwareTexture: SoftwareTexture,
  call: TextureCall<T>,
  isDDX: boolean
) {
  const dd = derivativeBaseForCall(softwareTexture, isDDX);
  return dd.map((v, i) => v * (call.derivativeMult?.[i] ?? 1)) as T;
}

function softwareTextureRead<T extends Dimensionality>(
  t: GPUTest,
  stage: ShaderStage,
  call: TextureCall<T>,
  softwareTexture: SoftwareTexture,
  sampler?: GPUSamplerDescriptor
): PerTexelComponent<number> {
  // add the implicit derivatives that we use from WGSL in doTextureCalls
  if (builtinNeedsDerivatives(call.builtin) && !call.ddx) {
    const newCall: TextureCall<T> = {
      ...call,
      ddx: call.ddx ?? derivativeForCall<T>(softwareTexture, call, true),
      ddy: call.ddy ?? derivativeForCall<T>(softwareTexture, call, false),
    };
    call = newCall;
  }
  return softwareTextureReadGrad(t, stage, call, softwareTexture, sampler);
}

export type TextureTestOptions<T extends Dimensionality> = {
  ddx?: number; // the derivative we want at sample time
  ddy?: number;
  uvwStart?: Readonly<T>; // the starting uv value (these are used make the coordinates negative as it uncovered issues on some hardware)
  offset?: Readonly<T>; // a constant offset
  depthTexture?: boolean;
  arrayIndexType?: 'i' | 'u';
};

/**
 * out of bounds is defined as any of the following being true
 *
 * * coords is outside the range [0, textureDimensions(t, level))
 * * array_index is outside the range [0, textureNumLayers(t))
 * * level is outside the range [0, textureNumLevels(t))
 * * sample_index is outside the range [0, textureNumSamples(s))
 */
function isOutOfBoundsCall<T extends Dimensionality>(
  softwareTexture: SoftwareTexture,
  call: TextureCall<T>
) {
  assert(call.coords !== undefined);

  const desc = reifyTextureDescriptor(softwareTexture.descriptor);
  const { coords, mipLevel: callMipLevel, arrayIndex, sampleIndex } = call;
  const { baseMipLevelSize, mipLevelCount, arrayLayerCount } = getBaseMipLevelInfo(softwareTexture);

  if (callMipLevel !== undefined && (callMipLevel < 0 || callMipLevel >= mipLevelCount)) {
    return true;
  }

  const size = virtualMipSize(
    softwareTexture.descriptor.dimension || '2d',
    baseMipLevelSize,
    callMipLevel ?? 0
  );

  for (let i = 0; i < coords.length; ++i) {
    const v = coords[i];
    if (v < 0 || v >= size[i]) {
      return true;
    }
  }

  if (arrayIndex !== undefined) {
    if (arrayIndex < 0 || arrayIndex >= arrayLayerCount) {
      return true;
    }
  }

  if (sampleIndex !== undefined) {
    if (sampleIndex < 0 || sampleIndex >= desc.sampleCount) {
      return true;
    }
  }

  return false;
}

function isValidOutOfBoundsValue(
  softwareTexture: SoftwareTexture,
  gotRGBA: PerTexelComponent<number>,
  maxFractionalDiff: number
) {
  // For a texture builtin with no sampler (eg textureLoad),
  // any out of bounds access is allowed to return one of:
  //
  // * the value of any texel in the texture
  // * 0,0,0,0 or 0,0,0,1 if not a depth texture
  // * 0 if a depth texture
  if (softwareTexture.descriptor.format.includes('depth')) {
    if (gotRGBA.R === 0) {
      return true;
    }
  } else {
    if (
      gotRGBA.R === 0 &&
      gotRGBA.B === 0 &&
      gotRGBA.G === 0 &&
      (gotRGBA.A === 0 || gotRGBA.A === 1)
    ) {
      return true;
    }
  }

  // Can be any texel value
  for (let mipLevel = 0; mipLevel < softwareTexture.texels.length; ++mipLevel) {
    const mipTexels = softwareTexture.texels[mipLevel];
    const size = virtualMipSize(
      softwareTexture.descriptor.dimension || '2d',
      softwareTexture.descriptor.size,
      mipLevel
    );
    const sampleCount = softwareTexture.descriptor.sampleCount ?? 1;
    for (let z = 0; z < size[2]; ++z) {
      for (let y = 0; y < size[1]; ++y) {
        for (let x = 0; x < size[0]; ++x) {
          for (let sampleIndex = 0; sampleIndex < sampleCount; ++sampleIndex) {
            const texel = mipTexels.color({ x, y, z, sampleIndex });
            const rgba = convertPerTexelComponentToResultFormat(texel, mipTexels.format);
            if (
              texelsApproximatelyEqual(
                gotRGBA,
                softwareTexture.descriptor.format,
                rgba,
                mipTexels.format,
                maxFractionalDiff
              )
            ) {
              return true;
            }
          }
        }
      }
    }
  }

  return false;
}

/**
 * For a texture builtin with no sampler (eg textureLoad),
 * any out of bounds access is allowed to return one of:
 *
 * * the value of any texel in the texture
 * * 0,0,0,0 or 0,0,0,1 if not a depth texture
 * * 0 if a depth texture
 */
function okBecauseOutOfBounds<T extends Dimensionality>(
  softwareTexture: SoftwareTexture,
  call: TextureCall<T>,
  gotRGBA: PerTexelComponent<number>,
  maxFractionalDiff: number
) {
  if (!isOutOfBoundsCall(softwareTexture, call)) {
    return false;
  }

  return isValidOutOfBoundsValue(softwareTexture, gotRGBA, maxFractionalDiff);
}

const kRGBAComponents = [
  TexelComponent.R,
  TexelComponent.G,
  TexelComponent.B,
  TexelComponent.A,
] as const;

const kRComponent = [TexelComponent.R] as const;

/**
 * Compares two Texels
 */
export function texelsApproximatelyEqual(
  gotRGBA: PerTexelComponent<number>,
  gotFormat: GPUTextureFormat,
  expectRGBA: PerTexelComponent<number>,
  expectedFormat: EncodableTextureFormat,
  maxFractionalDiff: number
) {
  const rep = kTexelRepresentationInfo[expectedFormat];
  const got = convertResultFormatToTexelViewFormat(gotRGBA, expectedFormat);
  const expect = convertResultFormatToTexelViewFormat(expectRGBA, expectedFormat);
  const gULP = convertPerTexelComponentToResultFormat(
    rep.bitsToULPFromZero(rep.numberToBits(got)),
    expectedFormat
  );
  const eULP = convertPerTexelComponentToResultFormat(
    rep.bitsToULPFromZero(rep.numberToBits(expect)),
    expectedFormat
  );

  const rgbaComponentsToCheck = isDepthOrStencilTextureFormat(gotFormat)
    ? kRComponent
    : kRGBAComponents;

  for (const component of rgbaComponentsToCheck) {
    const g = gotRGBA[component]!;
    const e = expectRGBA[component]!;
    assert(!isNaN(g), () => `got component is NaN: ${g}`);
    assert(!isNaN(e), () => `expected component is NaN: ${e}`);
    const absDiff = Math.abs(g - e);
    const ulpDiff = Math.abs(gULP[component]! - eULP[component]!);
    if (ulpDiff > 3 && absDiff > maxFractionalDiff) {
      return false;
    }
  }
  return true;
}

// If it's `textureGather` then we need to convert all values to one component.
// In other words, imagine the format is rg11b10ufloat. If it was
// `textureSample` we'd have `r11, g11, b10, a=1` but for `textureGather`
//
// component = 0 => `r11, r11, r11, r11`
// component = 1 => `g11, g11, g11, g11`
// component = 2 => `b10, b10, b10, b10`
//
// etc..., each from a different texel
//
// The Texel utils don't handle this. So if `component = 2` we take each value,
// copy it to the `B` component, run it through the texel utils so it returns
// the correct ULP for a 10bit float (not an 11 bit float). Then copy it back to
// the channel it came from.
function getULPFromZeroForComponents(
  rgba: PerTexelComponent<number>,
  format: EncodableTextureFormat,
  builtin: TextureBuiltin,
  componentNdx?: number
): PerTexelComponent<number> {
  const rep = kTexelRepresentationInfo[format];
  if (isBuiltinGather(builtin)) {
    const out: PerTexelComponent<number> = {};
    const component = kRGBAComponents[componentNdx ?? 0];
    const temp: PerTexelComponent<number> = { R: 0, G: 0, B: 0, A: 1 };
    for (const comp of kRGBAComponents) {
      temp[component] = rgba[comp];
      const texel = convertResultFormatToTexelViewFormat(temp, format);
      const ulp = convertPerTexelComponentToResultFormat(
        rep.bitsToULPFromZero(rep.numberToBits(texel)),
        format
      );
      out[comp] = ulp[component];
    }
    return out;
  } else {
    const texel = convertResultFormatToTexelViewFormat(rgba, format);
    return convertPerTexelComponentToResultFormat(
      rep.bitsToULPFromZero(rep.numberToBits(texel)),
      format
    );
  }
}

function getTextureViewDescription(softwareTexture: SoftwareTexture) {
  const size = reifyExtent3D(softwareTexture.descriptor.size);
  const { baseMipLevel, mipLevelCount, baseArrayLayer, arrayLayerCount, baseMipLevelSize } =
    getBaseMipLevelInfo(softwareTexture);
  const physicalMipLevelCount = softwareTexture.descriptor.mipLevelCount ?? 1;

  return `
   physical size: [${size.width}, ${size.height}, ${size.depthOrArrayLayers}]
    baseMipLevel: ${baseMipLevel}
   mipLevelCount: ${mipLevelCount}
baseMipLevelSize: [${baseMipLevelSize.join(', ')}]
  baseArrayLayer: ${baseArrayLayer}
 arrayLayerCount: ${arrayLayerCount}
physicalMipCount: ${physicalMipLevelCount}
  `;
}
/**
 * Checks the result of each call matches the expected result.
 */
export async function checkCallResults<T extends Dimensionality>(
  t: GPUTest,
  softwareTexture: SoftwareTexture,
  textureType: string,
  sampler: GPUSamplerDescriptor | undefined,
  calls: TextureCall<T>[],
  results: Awaited<ReturnType<typeof doTextureCalls<T>>>,
  shortShaderStage: ShortShaderStage,
  gpuTexture?: GPUTexture
) {
  const stage = kShortShaderStageToShaderStage[shortShaderStage];
  if (builtinNeedsMipLevelWeights(calls[0].builtin)) {
    await initMipLevelWeightsForDevice(t, stage);
  }

  let haveComparisonCheckInfo = false;
  let checkInfo = {
    runner: results.runner,
    calls,
    sampler,
  };
  // These are only read if the tests fail. They are used to get the values from the
  // GPU texture for displaying in diagnostics.
  let gpuTexels: TexelView[] | undefined;
  const errs: string[] = [];
  const format = softwareTexture.texels[0].format;
  const size = reifyExtent3D(softwareTexture.descriptor.size);
  const maxFractionalDiff =
    sampler?.minFilter === 'linear' ||
    sampler?.magFilter === 'linear' ||
    sampler?.mipmapFilter === 'linear'
      ? getMaxFractionalDiffForTextureFormat(softwareTexture.descriptor.format)
      : 0;

  t.debug(() => getTextureViewDescription(softwareTexture));

  for (let callIdx = 0; callIdx < calls.length; callIdx++) {
    const call = calls[callIdx];
    t.debug(`#${callIdx}: ${describeTextureCall(call)}`);
    const gotRGBA = results.results[callIdx];
    const expectRGBA = softwareTextureRead(t, stage, call, softwareTexture, sampler);
    // Issues with textureSampleBias
    //
    // textureSampleBias tests start to get unexpected results when bias >= ~12
    // where the mip level selected by the GPU is off by +/- 0.41.
    //
    // The issue is probably an internal precision issue. In order to test a bias of 12
    // we choose a target mip level between 0 and mipLevelCount - 1. For example 0.4.
    // We then compute what mip level we need the derivatives to select such that when
    // we add in the bias it will result in a mip level of 0.4.  For a bias of 12
    // that's means we need the derivatives to select mip level -11.4. That means
    // the derivatives are `pow(2, -11.4) / textureSize` so for a texture that's 16
    // pixels wide that's `0.00002312799936691891`. I'm just guessing some of that
    // gets rounded off leading. For example, if we round it ourselves.
    //
    // | derivative             | mip level |
    // +------------------------+-----------+
    // | 0.00002312799936691891 | -11.4     |
    // | 0.000022               | -11.47    |
    // | 0.000023               | -11.408   |
    // | 0.000024               | -11.34    |
    // +------------------------+-----------+
    //
    // Note: As an example of a bad case: set `callSpecificMaxFractionalDiff = maxFractionalDiff` below
    // then run `webgpu:shader,execution,expression,call,builtin,textureSampleBias:sampled_2d_coords:format="astc-6x6-unorm";filt="linear";modeU="m";modeV="m";offset=false`
    // on an M1 Mac.
    //
    // ```
    // EXPECTATION FAILED: subcase: samplePoints="spiral"
    // result was not as expected:
    //       size: [18, 18, 1]
    //   mipCount: 3
    //       call: textureSampleBias(texture: T, sampler: S, coords: vec2f(0.1527777777777778, 1.4166666666666667) + derivativeBase * derivativeMult(vec2f(0.00002249990733551491, 0)), bias: f32(15.739721414633095))  // #32
    //           : as texel coord @ mip level[0]: (2.750, 25.500)
    //           : as texel coord @ mip level[1]: (1.375, 12.750)
    //           : as texel coord @ mip level[2]: (0.611, 5.667)
    // implicit derivative based mip level: -15.439721414633095 (without bias)
    //                        clamped bias: 15.739721414633095
    //                 mip level with bias: 0.3000000000000007
    //        got: 0.555311381816864, 0.7921856045722961, 0.8004884123802185, 0.38046398758888245
    //   expected: 0.6069580801937625, 0.7999182825318225, 0.8152446179041957, 0.335314491045024
    //   max diff: 0.027450980392156862
    //  abs diffs: 0.0516466983768985, 0.007732677959526368, 0.014756205523977162, 0.04514949654385847
    //  rel diffs: 8.51%, 0.97%, 1.81%, 11.87%
    //  ulp diffs: 866488, 129733, 247568, 1514966
    //
    //   sample points:
    // expected:                                                                   | got:
    // ...
    // a: mip(0) at: [ 2, 10,  0], weight: 0.52740                                 | a: mip(0) at: [ 2, 10,  0], weight: 0.60931
    // b: mip(0) at: [ 3, 10,  0], weight: 0.17580                                 | b: mip(0) at: [ 3, 10,  0], weight: 0.20319
    // a: value: R: 0.46642, G: 0.77875, B: 0.77509, A: 0.45788                    | a: value: R: 0.46642, G: 0.77875, B: 0.77509, A: 0.45788
    // b: value: R: 0.46642, G: 0.77875, B: 0.77509, A: 0.45788                    | b: value: R: 0.46642, G: 0.77875, B: 0.77509, A: 0.45788
    // mip level (0) weight: 0.70320                                               | mip level (0) weight: 0.81250
    // ```
    //
    // Notice above the "expected" level weight (0.7) matches the "mip level with bias (0.3)" which is
    // the mip level we expected the GPU to select. Selecting mip level 0.3 will do `mix(level0, level1, 0.3)`
    // which is 0.7 of level 0 and 0.3 of level 1. Notice the "got" level weight is 0.81 which is pretty far off.
    //
    // Just looking at the failures, the largest formula below makes most of the tests pass
    //
    // MAINTENANCE_TODO: Consider different solutions for this issue
    //
    // 1. Try to figure out what the exact rounding issue is the take it into account
    //
    // 2. The code currently samples the texture once via the GPU and once via softwareTextureRead. These values are
    //    "got:" and "expected:" above. The test only fails if they are too different. We could rather get the bilinear
    //    sample from every mip level and then check the "got" value is between 2 of the levels (or equal if nearest).
    //    In other words.
    //
    //        if (bias >= 12)
    //          colorForEachMipLevel = range(mipLevelCount, mipLevel => softwareTextureReadLevel(..., mipLevel))
    //          if nearest
    //            pass = got === one of colorForEachMipLevel
    //          else // linear
    //            pass = false;
    //            for (i = 0; !pass && i < mipLevelCount - 1; i)
    //              pass = got is between colorForEachMipLevel[i] and colorForEachMipLevel[i + 1]
    //
    //    This would check "something" but effectively it would no longer be checking "bias" for values > 12. Only that
    //    textureSampleBias returns some possible answer vs some completely wrong answer.
    //
    // 3. It's possible this check is just not possible given the precision required. We could just check bias -16 to 12
    //    and ignore values > 12. We won't be able to test clamping but maybe that's irrelevant.
    //
    const callSpecificMaxFractionalDiff =
      call.bias! >= 12 ? maxFractionalDiff * (2 + call.bias! - 12) : maxFractionalDiff;

    // The spec says depth and stencil have implementation defined values for G, B, and A
    // so if this is `textureGather` and component > 0 then there's nothing to check.
    if (
      isDepthOrStencilTextureFormat(format) &&
      isBuiltinGather(call.builtin) &&
      call.component! > 0
    ) {
      continue;
    }

    if (
      texelsApproximatelyEqual(
        gotRGBA,
        softwareTexture.descriptor.format,
        expectRGBA,
        format,
        callSpecificMaxFractionalDiff
      )
    ) {
      continue;
    }

    if (
      !sampler &&
      okBecauseOutOfBounds(softwareTexture, call, gotRGBA, callSpecificMaxFractionalDiff)
    ) {
      continue;
    }

    const gULP = getULPFromZeroForComponents(gotRGBA, format, call.builtin, call.component);
    const eULP = getULPFromZeroForComponents(expectRGBA, format, call.builtin, call.component);

    // from the spec: https://gpuweb.github.io/gpuweb/#reading-depth-stencil
    // depth and stencil values are D, ?, ?, ?
    const rgbaComponentsToCheck =
      isBuiltinGather(call.builtin) || !isDepthOrStencilTextureFormat(format)
        ? kRGBAComponents
        : kRComponent;

    let bad = false;
    const diffs = rgbaComponentsToCheck.map(component => {
      const g = gotRGBA[component]!;
      const e = expectRGBA[component]!;
      const absDiff = Math.abs(g - e);
      const ulpDiff = Math.abs(gULP[component]! - eULP[component]!);
      assert(!Number.isNaN(ulpDiff));
      const maxAbs = Math.max(Math.abs(g), Math.abs(e));
      const relDiff = maxAbs > 0 ? absDiff / maxAbs : 0;
      if (ulpDiff > 3 && absDiff > callSpecificMaxFractionalDiff) {
        bad = true;
      }
      return { absDiff, relDiff, ulpDiff };
    });

    const isFloatType = (format: GPUTextureFormat) => {
      const type = getTextureFormatType(format);
      return type === 'float' || type === 'depth';
    };
    const fix5 = (n: number) => (isFloatType(format) ? n.toFixed(5) : n.toString());
    const fix5v = (arr: number[]) => arr.map(v => fix5(v)).join(', ');
    const rgbaToArray = (p: PerTexelComponent<number>): number[] =>
      rgbaComponentsToCheck.map(component => p[component]!);

    if (bad) {
      const { baseMipLevelSize } = getBaseMipLevelInfo(softwareTexture);
      const physicalMipLevelCount = softwareTexture.descriptor.mipLevelCount ?? 1;
      const lodClamp = getEffectiveLodClamp(call.builtin, sampler, softwareTexture);

      const desc = describeTextureCall(call);
      errs.push(`result was not as expected:${getTextureViewDescription(softwareTexture)}
     lodMinClamp: ${lodClamp.min} (effective)
     lodMaxClamp: ${lodClamp.max} (effective)
            call: ${desc}  // #${callIdx}`);
      if (isCubeViewDimension(softwareTexture.viewDescriptor)) {
        const coord = convertCubeCoordToNormalized3DTextureCoord(call.coords as vec3);
        const faceNdx = Math.floor(coord[2] * 6);
        errs.push(`          : as 3D texture coord: (${coord[0]}, ${coord[1]}, ${coord[2]})`);
        for (let mipLevel = 0; mipLevel < physicalMipLevelCount; ++mipLevel) {
          const mipSize = virtualMipSize(
            softwareTexture.descriptor.dimension ?? '2d',
            softwareTexture.descriptor.size,
            mipLevel
          );
          const t = coord.slice(0, 2).map((v, i) => (v * mipSize[i]).toFixed(3));
          errs.push(
            `          : as texel coord mip level[${mipLevel}]: (${t[0]}, ${t[1]}), face: ${faceNdx}(${kFaceNames[faceNdx]})`
          );
        }
      } else if (call.coordType === 'f') {
        for (let mipLevel = 0; mipLevel < physicalMipLevelCount; ++mipLevel) {
          const mipSize = virtualMipSize(
            softwareTexture.descriptor.dimension ?? '2d',
            softwareTexture.descriptor.size,
            mipLevel
          );
          const t = call.coords!.map((v, i) => (v * mipSize[i]).toFixed(3));
          errs.push(`          : as texel coord @ mip level[${mipLevel}]: (${t.join(', ')})`);
        }
      }
      if (builtinNeedsDerivatives(call.builtin)) {
        const ddx = derivativeForCall<T>(softwareTexture, call, true);
        const ddy = derivativeForCall<T>(softwareTexture, call, false);
        const mipLevel = computeMipLevelFromGradients(ddx, ddy, baseMipLevelSize);
        const biasStr = call.bias === undefined ? '' : ' (without bias)';
        errs.push(`implicit derivative based mip level: ${fix5(mipLevel)}${biasStr}`);
        if (call.bias) {
          const clampedBias = clamp(call.bias ?? 0, { min: -16.0, max: 15.99 });
          errs.push(`\
                       clamped bias: ${fix5(clampedBias)}
                mip level with bias: ${fix5(mipLevel + clampedBias)}`);
        }
      } else if (call.ddx) {
        const mipLevel = computeMipLevelFromGradientsForCall(call, size);
        errs.push(`gradient based mip level: ${mipLevel}`);
      }
      errs.push(`\
       got: ${fix5v(rgbaToArray(gotRGBA))}
  expected: ${fix5v(rgbaToArray(expectRGBA))}
  max diff: ${callSpecificMaxFractionalDiff}
 abs diffs: ${fix5v(diffs.map(({ absDiff }) => absDiff))}
 rel diffs: ${diffs.map(({ relDiff }) => `${(relDiff * 100).toFixed(2)}%`).join(', ')}
 ulp diffs: ${diffs.map(({ ulpDiff }) => ulpDiff).join(', ')}
`);

      if (sampler) {
        if (t.rec.debugging) {
          // For compares, we can't use the builtin (textureXXXCompareXXX) because it only
          // returns 0 or 1 or the average of 0 and 1 for multiple samples. And, for example,
          // if the comparison is `always` then every sample returns 1. So we need to use the
          // corresponding sample function to get the actual values from the textures
          //
          // textureSampleCompare -> textureSample
          // textureSampleCompareLevel -> textureSampleLevel
          // textureGatherCompare -> textureGather
          if (isBuiltinComparison(call.builtin)) {
            if (!haveComparisonCheckInfo) {
              // Convert the comparison calls to their corresponding non-comparison call
              const debugCalls = calls.map(call => {
                const debugCall = { ...call };
                debugCall.depthRef = undefined;
                switch (call.builtin) {
                  case 'textureGatherCompare':
                    debugCall.builtin = 'textureGather';
                    break;
                  case 'textureSampleCompare':
                    debugCall.builtin = 'textureSample';
                    break;
                  case 'textureSampleCompareLevel':
                    debugCall.builtin = 'textureSampleLevel';
                    debugCall.levelType = 'u';
                    debugCall.mipLevel = 0;
                    break;
                  default:
                    unreachable();
                }
                return debugCall;
              });

              // Convert the comparison sampler to a non-comparison sampler
              const debugSampler = { ...sampler };
              delete debugSampler.compare;

              // Make a runner for these changed calls.
              const debugRunner = createTextureCallsRunner(
                t,
                {
                  format,
                  dimension: softwareTexture.descriptor.dimension ?? '2d',
                  sampleCount: softwareTexture.descriptor.sampleCount ?? 1,
                  depthOrArrayLayers: size.depthOrArrayLayers,
                },
                softwareTexture.viewDescriptor,
                textureType,
                debugSampler,
                debugCalls,
                stage
              );
              checkInfo = {
                runner: debugRunner,
                sampler: debugSampler,
                calls: debugCalls,
              };
              haveComparisonCheckInfo = true;
            }
          }

          if (!gpuTexels && gpuTexture) {
            // Read the texture back if we haven't yet. We'll use this
            // to get values for each sample point.
            gpuTexels = await readTextureToTexelViews(
              t,
              gpuTexture,
              softwareTexture.descriptor,
              getTexelViewFormatForTextureFormat(gpuTexture.format)
            );
          }

          const callForSamplePoints = checkInfo.calls[callIdx];

          // We're going to create textures with black and white texels
          // but if it's a compressed texture we use an encodable texture.
          // It's not perfect but we already know it failed. We're just hoping
          // to get sample points.
          const useTexelFormatForGPUTexture = isCompressedTextureFormat(
            softwareTexture.descriptor.format
          );

          if (useTexelFormatForGPUTexture) {
            errs.push(`
### WARNING: sample points are derived from un-compressed textures and may not match the
actual GPU results of sampling a compressed texture. The test itself failed at this point
(see expected: and got: above). We're only trying to determine what the GPU sampled, but
we can not do that easily with compressed textures. ###
`);
          }

          const expectedSamplePoints = [
            'expected:',
            ...(await identifySamplePoints(
              softwareTexture,
              sampler,
              callForSamplePoints,
              call,
              softwareTexture.texels,
              (texels: TexelView[]) => {
                return Promise.resolve(
                  softwareTextureRead(
                    t,
                    stage,
                    callForSamplePoints,
                    {
                      texels,
                      descriptor: softwareTexture.descriptor,
                      viewDescriptor: softwareTexture.viewDescriptor,
                    },
                    checkInfo.sampler
                  )
                );
              }
            )),
          ];
          const gotSamplePoints = [
            'got:',
            ...(await identifySamplePoints(
              softwareTexture,
              sampler,
              callForSamplePoints,
              call,
              gpuTexels,
              async (texels: TexelView[]) => {
                const descriptor = { ...softwareTexture.descriptor };
                if (useTexelFormatForGPUTexture) {
                  descriptor.format = texels[0].format;
                }
                const gpuTexture = createTextureFromTexelViewsLocal(t, texels, descriptor);
                const result = (await checkInfo.runner.run(gpuTexture))[callIdx];
                gpuTexture.destroy();
                return result;
              }
            )),
          ];
          errs.push('  sample points:');
          errs.push(layoutTwoColumns(expectedSamplePoints, gotSamplePoints).join('\n'));
          errs.push('', '');
        }

        // this is not an else because it's common to comment out the previous `if` for running on a CQ.
        if (!t.rec.debugging) {
          errs.push('### turn on debugging to see sample points ###');
        }
      } // if (sampler)

      // Don't report the other errors. There 50 sample points per subcase and
      // 50-100 subcases so the log would get enormous if all 50 fail. One
      // report per subcase is enough.
      break;
    } // if (bad)
  } // for cellNdx

  results.runner.destroy();
  checkInfo.runner.destroy();

  return errs.length > 0 ? new Error(errs.join('\n')) : undefined;
}

function getMaxFractionalDiffForTextureFormat(format: GPUTextureFormat) {
  // Note: I'm not sure what we should do here. My assumption is, given texels
  // have random values, the difference between 2 texels can be very large. In
  // the current version, for a float texture they can be +/- 1000 difference.
  // Sampling is very GPU dependent. So if one pixel gets a random value of
  // -1000 and the neighboring pixel gets +1000 then any slight variation in how
  // sampling is applied will generate a large difference when interpolating
  // between -1000 and +1000.
  //
  // We could make some entry for every format but for now I just put the
  // tolerances here based on format texture suffix.
  //
  // It's possible the math in the software rasterizer is just bad but the
  // results certainly seem close.
  //
  // These tolerances started from the OpenGL ES dEQP tests.
  // Those tests always render to an rgba8unorm texture. The shaders do effectively
  //
  //   result = textureSample(...) * scale + bias
  //
  // to get the results in a 0.0 to 1.0 range. After reading the values back they
  // expand them to their original ranges with
  //
  //   value = (result - bias) / scale;
  //
  // Tolerances from dEQP
  // --------------------
  // 8unorm: 3.9 / 255
  // 8snorm: 7.9 / 128
  // 2unorm: 7.9 / 512
  // ufloat: 156.249
  //  float: 31.2498
  //
  // The numbers below have been set empirically to get the tests to pass on all
  // devices. The devices with the most divergence from the calculated expected
  // values are MacOS Intel and AMD.
  //
  // MAINTENANCE_TODO: Double check the software rendering math and lower these
  // tolerances if possible.

  if (format.includes('depth')) {
    return 3 / 100;
  } else if (format.includes('8unorm')) {
    return 7 / 255;
  } else if (format.includes('2unorm')) {
    return 13 / 512;
  } else if (format.includes('unorm')) {
    return 7 / 255;
  } else if (format.includes('8snorm')) {
    return 7.9 / 128;
  } else if (format.includes('snorm')) {
    return 7.9 / 128;
  } else if (format.endsWith('ufloat')) {
    return 156.249;
  } else if (format.endsWith('float')) {
    return 44;
  } else {
    // It's likely an integer format. In any case, zero tolerance is passable.
    return 0;
  }
}

const sumOfCharCodesOfString = (s: unknown) =>
  String(s)
    .split('')
    .reduce((sum, c) => sum + c.charCodeAt(0), 0);

/**
 * Makes a function that fills a block portion of a Uint8Array with random valid data
 * for an astc block.
 *
 * The astc format is fairly complicated. For now we do the simplest thing.
 * which is to set the block as a "void-extent" block (a solid color).
 * This makes our test have far less precision.
 *
 * MAINTENANCE_TODO: generate other types of astc blocks. One option would
 * be to randomly select from set of pre-made blocks.
 *
 * See Spec:
 * https://registry.khronos.org/OpenGL/extensions/KHR/KHR_texture_compression_astc_hdr.txt
 */
function makeAstcBlockFiller(format: ColorTextureFormat) {
  const { bytesPerBlock } = getBlockInfoForColorTextureFormat(format);
  return (data: Uint8Array, offset: number, hashBase: number) => {
    // set the block to be a void-extent block
    data.set(
      [
        0b1111_1100, // 0
        0b1111_1101, // 1
        0b1111_1111, // 2
        0b1111_1111, // 3
        0b1111_1111, // 4
        0b1111_1111, // 5
        0b1111_1111, // 6
        0b1111_1111, // 7
      ],
      offset
    );
    // fill the rest of the block with random data
    const end = offset + bytesPerBlock;
    for (let i = offset + 8; i < end; ++i) {
      data[i] = hashU32(hashBase, i);
    }
  };
}

/**
 * Makes a function that fills a block portion of a Uint8Array with random bytes.
 */
function makeRandomBytesBlockFiller(format: ColorTextureFormat) {
  const { bytesPerBlock } = getBlockInfoForColorTextureFormat(format);
  return (data: Uint8Array, offset: number, hashBase: number) => {
    const end = offset + bytesPerBlock;
    for (let i = offset; i < end; ++i) {
      data[i] = hashU32(hashBase, i);
    }
  };
}

function getBlockFiller(format: ColorTextureFormat) {
  if (format.startsWith('astc')) {
    return makeAstcBlockFiller(format);
  } else {
    return makeRandomBytesBlockFiller(format);
  }
}

/**
 * Fills a texture with random data.
 */
function fillTextureWithRandomData(device: GPUDevice, texture: GPUTexture) {
  assert(isColorTextureFormat(texture.format));
  assert(!isCompressedFloatTextureFormat(texture.format));
  const info = getBlockInfoForColorTextureFormat(texture.format as ColorTextureFormat);
  const hashBase =
    sumOfCharCodesOfString(texture.format) +
    sumOfCharCodesOfString(texture.dimension) +
    texture.width +
    texture.height +
    texture.depthOrArrayLayers +
    texture.mipLevelCount;
  const bytesPerBlock = info.bytesPerBlock;
  const fillBlock = getBlockFiller(texture.format as ColorTextureFormat);
  for (let mipLevel = 0; mipLevel < texture.mipLevelCount; ++mipLevel) {
    const size = physicalMipSizeFromTexture(texture, mipLevel);
    const blocksAcross = Math.ceil(size[0] / info.blockWidth);
    const blocksDown = Math.ceil(size[1] / info.blockHeight);
    const bytesPerRow = blocksAcross * bytesPerBlock;
    const bytesNeeded = bytesPerRow * blocksDown * size[2];
    const data = new Uint8Array(bytesNeeded);
    for (let offset = 0; offset < bytesNeeded; offset += bytesPerBlock) {
      fillBlock(data, offset, hashBase);
    }
    device.queue.writeTexture(
      { texture, mipLevel },
      data,
      { bytesPerRow, rowsPerImage: blocksDown },
      size
    );
  }
}

const s_readTextureToRGBA32DeviceToPipeline = new WeakMap<
  GPUDevice,
  Map<string, GPUComputePipeline>
>();

// MAINTENANCE_TODO: remove cast once textureBindingViewDimension is added to IDL
function getEffectiveViewDimension(
  t: GPUTest,
  descriptor: Omit<GPUTextureDescriptor, 'format' | 'usage'>
): GPUTextureViewDimension {
  const size = reifyExtent3D(descriptor.size);
  return effectiveViewDimensionForDimension(
    descriptor.textureBindingViewDimension,
    descriptor.dimension,
    size.depthOrArrayLayers
  );
}

/**
 * Reads a texture to an array of TexelViews, one per mip level.
 * format is the format of the TexelView you want. Often this is
 * same as the texture.format but if the texture.format is not
 * "Encodable" then you need to choose a different format.
 * Example: depth24plus -> r32float, bc1-rgba-unorm to rgba32float
 */
export async function readTextureToTexelViews(
  t: GPUTest,
  texture: GPUTexture,
  descriptor: Omit<GPUTextureDescriptor, 'format' | 'usage'>,
  format: EncodableTextureFormat
) {
  const device = t.device;
  const viewDimensionToPipelineMap =
    s_readTextureToRGBA32DeviceToPipeline.get(device) ??
    new Map<GPUTextureViewDimension, GPUComputePipeline>();
  s_readTextureToRGBA32DeviceToPipeline.set(device, viewDimensionToPipelineMap);

  const { componentType, resultType } = getTextureFormatTypeInfo(texture.format);
  const viewDimension = getEffectiveViewDimension(t, descriptor);
  const id = `${texture.format}:${viewDimension}:${texture.sampleCount}`;
  let pipeline = viewDimensionToPipelineMap.get(id);
  if (!pipeline) {
    let textureWGSL;
    let loadWGSL;
    let dimensionWGSL = 'textureDimensions(tex, 0)';
    switch (viewDimension) {
      case '2d':
        if (texture.sampleCount > 1) {
          textureWGSL = `texture_multisampled_2d<${componentType}>`;
          loadWGSL = 'textureLoad(tex, coord.xy, sampleIndex)';
          dimensionWGSL = 'textureDimensions(tex)';
        } else {
          textureWGSL = `texture_2d<${componentType}>`;
          loadWGSL = 'textureLoad(tex, coord.xy, 0)';
        }
        break;
      case 'cube-array': // cube-array doesn't exist in compat so we can just use 2d_array for this
      case '2d-array':
        textureWGSL = `texture_2d_array<${componentType}>`;
        loadWGSL = `
          textureLoad(
              tex,
              coord.xy,
              coord.z,
              0)`;
        break;
      case '3d':
        textureWGSL = `texture_3d<${componentType}>`;
        loadWGSL = 'textureLoad(tex, coord.xyz, 0)';
        break;
      case 'cube':
        textureWGSL = `texture_cube<${componentType}>`;
        loadWGSL = `
          textureLoadCubeAs2DArray(tex, coord.xy, coord.z);
        `;
        break;
      case '1d':
        textureWGSL = `texture_1d<${componentType}>`;
        loadWGSL = `textureLoad(tex, coord.x, 0)`;
        dimensionWGSL = `vec2u(textureDimensions(tex), 1)`;
        break;
      default:
        unreachable(`unsupported view: ${viewDimension}`);
    }

    const textureLoadCubeWGSL = `
      const faceMat = array(
        mat3x3f( 0,  0,  -2,  0, -2,   0,  1,  1,   1),   // pos-x
        mat3x3f( 0,  0,   2,  0, -2,   0, -1,  1,  -1),   // neg-x
        mat3x3f( 2,  0,   0,  0,  0,   2, -1,  1,  -1),   // pos-y
        mat3x3f( 2,  0,   0,  0,  0,  -2, -1, -1,   1),   // neg-y
        mat3x3f( 2,  0,   0,  0, -2,   0, -1,  1,   1),   // pos-z
        mat3x3f(-2,  0,   0,  0, -2,   0,  1,  1,  -1));  // neg-z

      // needed for compat mode.
      fn textureLoadCubeAs2DArray(tex: texture_cube<${componentType}>, coord: vec2u, layer: u32) -> ${resultType} {
        // convert texel coord normalized coord
        let size = textureDimensions(tex, 0);

        // Offset by 0.75 instead of the more common 0.5 for converting from texel to normalized texture coordinate
        // because we're using textureGather. 0.5 would indicate the center of a texel but based on precision issues
        // the "gather" could go in any direction from that center. Off center it should go in an expected direction.
        let uv = (vec2f(coord) + 0.75) / vec2f(size.xy);

        // convert uv + layer into cube coord
        let cubeCoord = faceMat[layer] * vec3f(uv, 1.0);

        // We have to use textureGather as it's the only texture builtin that works on cubemaps
        // with integer texture formats.
        let r = textureGather(0, tex, smp, cubeCoord);
        let g = textureGather(1, tex, smp, cubeCoord);
        let b = textureGather(2, tex, smp, cubeCoord);
        let a = textureGather(3, tex, smp, cubeCoord);

        // element 3 is the texel corresponding to cubeCoord
        return ${resultType}(r[3], g[3], b[3], a[3]);
      }
    `;

    const module = device.createShaderModule({
      code: `
        ${isViewDimensionCubeOrCubeArray(viewDimension) ? textureLoadCubeWGSL : ''}
        struct Uniforms {
          sampleCount: u32,
        };

        @group(0) @binding(0) var<uniform> uni: Uniforms;
        @group(0) @binding(1) var tex: ${textureWGSL};
        @group(0) @binding(2) var smp: sampler;
        @group(0) @binding(3) var<storage, read_write> data: array<${resultType}>;

        @compute @workgroup_size(1) fn cs(
          @builtin(global_invocation_id) global_invocation_id : vec3<u32>) {
          _ = smp;
          let size = ${dimensionWGSL};
          let ndx = global_invocation_id.z * size.x * size.y * uni.sampleCount +
                    global_invocation_id.y * size.x * uni.sampleCount +
                    global_invocation_id.x;
          let coord = vec3u(global_invocation_id.x / uni.sampleCount, global_invocation_id.yz);
          let sampleIndex = global_invocation_id.x % uni.sampleCount;
          data[ndx] = ${loadWGSL};
        }
      `,
    });
    const type = getTextureFormatType(texture.format);
    const sampleType = isDepthTextureFormat(texture.format)
      ? 'unfilterable-float' // depth only supports unfilterable-float if not a comparison.
      : isStencilTextureFormat(texture.format)
      ? 'uint'
      : type === 'float'
      ? 'unfilterable-float'
      : type;
    const bindGroupLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          buffer: {
            type: 'uniform',
          },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          texture: {
            sampleType,
            viewDimension,
            multisampled: texture.sampleCount > 1,
          },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.COMPUTE,
          sampler: {
            type: 'non-filtering',
          },
        },
        {
          binding: 3,
          visibility: GPUShaderStage.COMPUTE,
          buffer: {
            type: 'storage',
          },
        },
      ],
    });
    const layout = device.createPipelineLayout({
      bindGroupLayouts: [bindGroupLayout],
    });
    pipeline = device.createComputePipeline({ layout, compute: { module } });
    viewDimensionToPipelineMap.set(id, pipeline);
  }

  const encoder = device.createCommandEncoder({ label: 'readTextureToTexelViews' });

  const readBuffers = [];
  for (let mipLevel = 0; mipLevel < texture.mipLevelCount; ++mipLevel) {
    const size = virtualMipSize(texture.dimension, texture, mipLevel);

    const uniformValues = new Uint32Array([texture.sampleCount, 0, 0, 0]); // min size is 16 bytes
    const uniformBuffer = t.createBufferTracked({
      label: 'readTextureToTexelViews:uniformBuffer',
      size: uniformValues.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(uniformBuffer, 0, uniformValues);

    const storageBuffer = t.createBufferTracked({
      label: 'readTextureToTexelViews:storageBuffer',
      size: size[0] * size[1] * size[2] * 4 * 4 * texture.sampleCount, // rgba32float
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });

    const readBuffer = t.createBufferTracked({
      label: 'readTextureToTexelViews:readBuffer',
      size: storageBuffer.size,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    readBuffers.push({ size, readBuffer });

    const sampler = device.createSampler();

    const aspect = getAspectForTexture(texture);
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniformBuffer } },
        {
          binding: 1,
          resource: texture.createView({
            dimension: viewDimension,
            aspect,
            baseMipLevel: mipLevel,
            mipLevelCount: 1,
          }),
        },
        { binding: 2, resource: sampler },
        { binding: 3, resource: { buffer: storageBuffer } },
      ],
    });

    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(size[0] * texture.sampleCount, size[1], size[2]);
    pass.end();
    encoder.copyBufferToBuffer(storageBuffer, 0, readBuffer, 0, readBuffer.size);
  }

  device.queue.submit([encoder.finish()]);

  const texelViews: TexelView[] = [];

  for (const { readBuffer, size } of readBuffers) {
    await readBuffer.mapAsync(GPUMapMode.READ);

    // need a copy of the data since unmapping will nullify the typedarray view.
    const Ctor =
      componentType === 'i32' ? Int32Array : componentType === 'u32' ? Uint32Array : Float32Array;
    const data = new Ctor(readBuffer.getMappedRange()).slice();
    readBuffer.unmap();

    const { sampleCount } = texture;
    texelViews.push(
      TexelView.fromTexelsAsColors(format, coord => {
        const offset =
          ((coord.z * size[0] * size[1] + coord.y * size[0] + coord.x) * sampleCount +
            (coord.sampleIndex ?? 0)) *
          4;
        return convertResultFormatToTexelViewFormat(
          {
            R: data[offset + 0],
            G: data[offset + 1],
            B: data[offset + 2],
            A: data[offset + 3],
          },
          format
        );
      })
    );
  }

  return texelViews;
}

function createTextureFromTexelViewsLocal(
  t: GPUTest,
  texelViews: TexelView[],
  desc: GPUTextureDescriptor
): GPUTexture {
  const modifiedDescriptor = { ...desc };
  // If it's a depth or stencil texture we need to render to it to fill it with data.
  if (isDepthOrStencilTextureFormat(desc.format) || desc.sampleCount! > 1) {
    modifiedDescriptor.usage = desc.usage | GPUTextureUsage.RENDER_ATTACHMENT;
  }
  return createTextureFromTexelViews(t, texelViews, modifiedDescriptor);
}

/**
 * Fills a texture with random data and returns that data as
 * an array of TexelView.
 *
 * For compressed textures the texture is filled with random bytes
 * and then read back from the GPU by sampling so the GPU decompressed
 * the texture.
 *
 * For uncompressed textures the TexelViews are generated and then
 * copied to the texture.
 */
export async function createTextureWithRandomDataAndGetTexels(
  t: GPUTest,
  descriptor: GPUTextureDescriptor,
  options?: RandomTextureOptions
) {
  if (isCompressedTextureFormat(descriptor.format)) {
    assert(!options, 'options not supported for compressed textures');
    const texture = t.createTextureTracked(descriptor);

    fillTextureWithRandomData(t.device, texture);
    const texels = await readTextureToTexelViews(
      t,
      texture,
      descriptor,
      getTexelViewFormatForTextureFormat(texture.format)
    );
    return { texture, texels };
  } else if (isUnencodableDepthFormat(descriptor.format)) {
    // This is round about. We can't directly write to depth24plus, depth24plus-stencil8, depth32float-stencil8
    // and they are not encodable. So: (1) we make random data using `depth32float`. We create a texture with
    // that data (createTextureFromTexelViewsLocal will render the data into the texture rather than copy).
    // We then need to read it back out but as rgba32float since that is encodable but, since it round tripped
    // through the GPU it's now been quantized.
    const d32Descriptor = {
      ...descriptor,
      format: 'depth32float' as GPUTextureFormat,
    };
    const tempTexels = createRandomTexelViewMipmap(d32Descriptor, options);
    const texture = createTextureFromTexelViewsLocal(t, tempTexels, descriptor);
    const texels = await readTextureToTexelViews(
      t,
      texture,
      descriptor,
      getTexelViewFormatForTextureFormat(texture.format)
    );
    return { texture, texels };
  } else {
    const texels = createRandomTexelViewMipmap(descriptor, options);
    const texture = createTextureFromTexelViewsLocal(t, texels, descriptor);
    return { texture, texels };
  }
}

function valueIfAllComponentsAreEqual(
  c: PerTexelComponent<number>,
  componentOrder: readonly TexelComponent[]
) {
  const s = new Set(componentOrder.map(component => c[component]!));
  return s.size === 1 ? s.values().next().value : undefined;
}

/**
 * Creates a Canvas with random data and a TexelView with the same data.
 */
export function createCanvasWithRandomDataAndGetTexels(textureSize: GPUExtent3D) {
  const size = reifyExtent3D(textureSize);
  assert(size.depthOrArrayLayers === 1);

  // Fill ImageData with random values.
  const imageData = new ImageData(size.width, size.height);
  const data = imageData.data;
  const asU32 = new Uint32Array(data.buffer);
  for (let i = 0; i < asU32.length; ++i) {
    asU32[i] = hashU32(i);
  }

  // Put the ImageData into a canvas and make a VideoFrame
  const canvas = new OffscreenCanvas(size.width, size.height);
  const ctx = canvas.getContext('2d')!;
  ctx.putImageData(imageData, 0, 0);

  // Premultiply the ImageData
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3] / 255;
    data[i + 0] = data[i + 0] * alpha;
    data[i + 1] = data[i + 1] * alpha;
    data[i + 2] = data[i + 2] * alpha;
  }

  // Create a TexelView from the premultiplied ImageData
  const texels = [
    TexelView.fromTextureDataByReference('rgba8unorm', data, {
      bytesPerRow: size.width * 4,
      rowsPerImage: size.height,
      subrectOrigin: [0, 0, 0],
      subrectSize: size,
    }),
  ];

  return { canvas, texels };
}

const kFaceNames = ['+x', '-x', '+y', '-y', '+z', '-z'] as const;

/**
 * Generates a text art grid showing which texels were sampled
 * followed by a list of the samples and the weights used for each
 * component.
 *
 * It works by making a set of indices for every texel in the texture.
 * It splits the set into 2. It picks one set and generates texture data
 * using TexelView.fromTexelsAsColor with [1, 1, 1, 1] texels for members
 * of the current set.
 *
 * In then calls 'run' which renders a single `call`. `run` uses either
 * the software renderer or WebGPU. It then checks the results. If the
 * result is zero, all texels in the current had no influence when sampling
 * and can be discarded.
 *
 * If the result is > 0 then, if the set has more than one member, the
 * set is split and added to the list to sets to test. If the set only
 * had one member then the result is the weight used when sampling that texel.
 *
 * This lets you see if the weights from the software renderer match the
 * weights from WebGPU.
 *
 * Example:
 *
 *     0   1   2   3   4   5   6   7
 *   +---+---+---+---+---+---+---+---+
 * 0 |   |   |   |   |   |   |   |   |
 *   +---+---+---+---+---+---+---+---+
 * 1 |   |   |   |   |   |   |   | a |
 *   +---+---+---+---+---+---+---+---+
 * 2 |   |   |   |   |   |   |   | b |
 *   +---+---+---+---+---+---+---+---+
 * 3 |   |   |   |   |   |   |   |   |
 *   +---+---+---+---+---+---+---+---+
 * 4 |   |   |   |   |   |   |   |   |
 *   +---+---+---+---+---+---+---+---+
 * 5 |   |   |   |   |   |   |   |   |
 *   +---+---+---+---+---+---+---+---+
 * 6 |   |   |   |   |   |   |   |   |
 *   +---+---+---+---+---+---+---+---+
 * 7 |   |   |   |   |   |   |   |   |
 *   +---+---+---+---+---+---+---+---+
 * a: at: [7, 1], weights: [R: 0.75000]
 * b: at: [7, 2], weights: [R: 0.25000]
 */
async function identifySamplePoints<T extends Dimensionality>(
  softwareTexture: SoftwareTexture,
  sampler: GPUSamplerDescriptor,
  callForSamples: TextureCall<T>,
  originalCall: TextureCall<T>,
  texels: TexelView[] | undefined,
  run: (texels: TexelView[]) => Promise<PerTexelComponent<number>>
) {
  const info = softwareTexture.descriptor;
  const isCube = isCubeViewDimension(softwareTexture.viewDescriptor);
  const mipLevelCount = softwareTexture.descriptor.mipLevelCount ?? 1;
  const mipLevelSizes = range(mipLevelCount, mipLevel =>
    virtualMipSize(
      softwareTexture.descriptor.dimension ?? '2d',
      softwareTexture.descriptor.size,
      mipLevel
    )
  );
  const numTexelsPerLevel = mipLevelSizes.map(size => size.reduce((s, v) => s * v));
  const numTexelsOfPrecedingLevels = (() => {
    let total = 0;
    return numTexelsPerLevel.map(v => {
      const num = total;
      total += v;
      return num;
    });
  })();
  const numTexels = numTexelsPerLevel.reduce((sum, v) => sum + v);

  const getMipLevelFromTexelId = (texelId: number) => {
    for (let mipLevel = mipLevelCount - 1; mipLevel > 0; --mipLevel) {
      if (texelId - numTexelsOfPrecedingLevels[mipLevel] >= 0) {
        return mipLevel;
      }
    }
    return 0;
  };

  const getTexelCoordFromTexelId = (texelId: number) => {
    const mipLevel = getMipLevelFromTexelId(texelId);
    const size = mipLevelSizes[mipLevel];
    const texelsPerSlice = size[0] * size[1];
    const id = texelId - numTexelsOfPrecedingLevels[mipLevel];
    const layer = Math.floor(id / texelsPerSlice);
    const xyId = id - layer * texelsPerSlice;
    const y = (xyId / size[0]) | 0;
    const x = xyId % size[0];
    return { x, y, z: layer, mipLevel, xyId };
  };

  // This isn't perfect. We already know there was an error. We're just
  // generating info so it seems okay it's not perfect. This format will
  // be used to generate weights by drawing with a texture of this format
  // with a specific pixel set to [1, 1, 1, 1]. As such, if the result
  // is > 0 then that pixel was sampled and the results are the weights.
  //
  // Ideally, this texture with a single pixel set to [1, 1, 1, 1] would
  // be the same format we were originally testing, the one we already
  // detected an error for. This way, whatever subtle issues there are
  // from that format will affect the weight values we're computing. But,
  // if that format is not encodable, for example if it's a compressed
  // texture format, then we have no way to build a texture so we use
  // rgba8unorm instead.
  const format = (
    kEncodableTextureFormats.includes(info.format as EncodableTextureFormat)
      ? info.format
      : isDepthTextureFormat(info.format)
      ? 'depth16unorm'
      : 'rgba8unorm'
  ) as EncodableTextureFormat;
  const rep = kTexelRepresentationInfo[format];

  const components = isBuiltinGather(callForSamples.builtin) ? kRGBAComponents : rep.componentOrder;
  const convertResultAsAppropriate = isBuiltinGather(callForSamples.builtin)
    ? <T>(v: T) => v
    : convertResultFormatToTexelViewFormat;

  // Identify all the texels that are sampled, and their weights.
  const sampledTexelWeights = new Map<number, PerTexelComponent<number>>();
  const unclassifiedStack = [new Set<number>(range(numTexels, v => v))];
  while (unclassifiedStack.length > 0) {
    // Pop the an unclassified texels stack
    const unclassified = unclassifiedStack.pop()!;

    // Split unclassified texels evenly into two new sets
    const setA = new Set<number>();
    const setB = new Set<number>();
    [...unclassified.keys()].forEach((t, i) => ((i & 1) === 0 ? setA : setB).add(t));

    // Push setB to the unclassified texels stack
    if (setB.size > 0) {
      unclassifiedStack.push(setB);
    }

    // See if any of the texels in setA were sampled.0
    const results = convertResultAsAppropriate(
      await run(
        range(mipLevelCount, mipLevel =>
          TexelView.fromTexelsAsColors(
            format,
            (coords: Required<GPUOrigin3DDict>): Readonly<PerTexelComponent<number>> => {
              const size = mipLevelSizes[mipLevel];
              const texelsPerSlice = size[0] * size[1];
              const texelsPerRow = size[0];
              const texelId =
                numTexelsOfPrecedingLevels[mipLevel] +
                coords.x +
                coords.y * texelsPerRow +
                coords.z * texelsPerSlice;
              const isCandidate = setA.has(texelId);
              const texel: PerTexelComponent<number> = {};
              for (const component of rep.componentOrder) {
                texel[component] = isCandidate ? 1 : 0;
              }
              return texel;
            }
          )
        )
      ),
      format
    );
    if (components.some(c => results[c] !== 0)) {
      // One or more texels of setA were sampled.
      if (setA.size === 1) {
        // We identified a specific texel was sampled.
        // As there was only one texel in the set, results holds the sampling weights.
        setA.forEach(texel => sampledTexelWeights.set(texel, results));
      } else {
        // More than one texel in the set. Needs splitting.
        unclassifiedStack.push(setA);
      }
    }
  }

  // separate the sampledTexelWeights by mipLevel, then by layer, within a layer the texelId only includes x and y
  const levels: Map<number, PerTexelComponent<number>>[][] = [];
  for (const [texelId, weight] of sampledTexelWeights.entries()) {
    const { xyId, z, mipLevel } = getTexelCoordFromTexelId(texelId);
    const level = levels[mipLevel] ?? [];
    levels[mipLevel] = level;
    const layerEntries = level[z] ?? new Map();
    level[z] = layerEntries;
    layerEntries.set(xyId, weight);
  }

  // example when blockWidth = 2, blockHeight = 2
  //
  //     0   1   2   3
  //   ╔═══╤═══╦═══╤═══╗
  // 0 ║ a │   ║   │   ║
  //   ╟───┼───╫───┼───╢
  // 1 ║   │   ║   │   ║
  //   ╠═══╪═══╬═══╪═══╣
  // 2 ║   │   ║   │   ║
  //   ╟───┼───╫───┼───╢
  // 3 ║   │   ║   │ b ║
  //   ╚═══╧═══╩═══╧═══╝

  /* prettier-ignore */
  const blockParts = {
    top:      { left: '╔', fill: '═══', right: '╗', block: '╦', texel: '╤' },
    mid:      { left: '╠', fill: '═══', right: '╣', block: '╬', texel: '╪' },
    bot:      { left: '╚', fill: '═══', right: '╝', block: '╩', texel: '╧' },
    texelMid: { left: '╟', fill: '───', right: '╢', block: '╫', texel: '┼' },
    value:    { left: '║', fill: '   ', right: '║', block: '║', texel: '│' },
  } as const;
  /* prettier-ignore */
  const nonBlockParts = {
    top:      { left: '┌', fill: '───', right: '┐', block: '┬', texel: '┬' },
    mid:      { left: '├', fill: '───', right: '┤', block: '┼', texel: '┼' },
    bot:      { left: '└', fill: '───', right: '┘', block: '┴', texel: '┴' },
    texelMid: { left: '├', fill: '───', right: '┤', block: '┼', texel: '┼' },
    value:    { left: '│', fill: '   ', right: '│', block: '│', texel: '│' },
  } as const;

  const lines: string[] = [];
  const letter = (idx: number) => String.fromCodePoint(idx < 30 ? 97 + idx : idx + 9600 - 30); // 97: 'a'
  let idCount = 0;

  const { blockWidth, blockHeight } = getBlockInfoForTextureFormat(
    softwareTexture.descriptor.format
  );
  // range + concatenate results.
  const rangeCat = <T>(num: number, fn: (i: number) => T) => range(num, fn).join('');
  const joinFn = (arr: string[], fn: (i: number) => string) => {
    const joins = range(arr.length - 1, fn);
    return arr.map((s, i) => `${s}${joins[i] ?? ''}`).join('');
  };
  const parts = Math.max(blockWidth, blockHeight) > 1 ? blockParts : nonBlockParts;
  /**
   * Makes a row that's [left, fill, texel, fill, block, fill, texel, fill, right]
   * except if `contents` is supplied then it would be
   * [left, contents[0], texel, contents[1], block, contents[2], texel, contents[3], right]
   */
  const makeRow = (
    blockPaddedWidth: number,
    width: number,
    {
      left,
      fill,
      right,
      block,
      texel,
    }: {
      left: string;
      fill: string;
      right: string;
      block: string;
      texel: string;
    },
    contents?: string[]
  ) => {
    return `${left}${joinFn(contents ?? range(blockPaddedWidth, x => fill), x => {
      return (x + 1) % blockWidth === 0 ? block : texel;
    })}${right}`;
  };

  for (let mipLevel = 0; mipLevel < mipLevelCount; ++mipLevel) {
    const level = levels[mipLevel];
    if (!level) {
      continue;
    }

    const [width, height, depthOrArrayLayers] = mipLevelSizes[mipLevel];
    const texelsPerRow = width;

    for (let layer = 0; layer < depthOrArrayLayers; ++layer) {
      const layerEntries = level[layer];

      const orderedTexelIndices: number[] = [];
      lines.push('');
      const unSampled = layerEntries ? '' : 'un-sampled';
      if (isCube) {
        const face = kFaceNames[layer % 6];
        lines.push(
          `layer: ${layer} mip(${mipLevel}), cube-layer: ${(layer / 6) | 0} (${face}) ${unSampled}`
        );
      } else {
        lines.push(`layer: ${layer} mip(${mipLevel}) ${unSampled}`);
      }

      if (!layerEntries) {
        continue;
      }

      const blockPaddedHeight = align(height, blockHeight);
      const blockPaddedWidth = align(width, blockWidth);
      lines.push(`   ${rangeCat(width, x => `  ${x.toString().padEnd(2)}`)}`);
      lines.push(`   ${makeRow(blockPaddedWidth, width, parts.top)}`);
      for (let y = 0; y < blockPaddedHeight; y++) {
        lines.push(
          `${y.toString().padStart(2)} ${makeRow(
            blockPaddedWidth,
            width,
            parts.value,
            range(blockPaddedWidth, x => {
              const texelIdx = x + y * texelsPerRow;
              const weight = layerEntries.get(texelIdx);
              const outside = y >= height || x >= width;
              if (outside || weight === undefined) {
                return outside ? '░░░' : '   ';
              } else {
                const id = letter(idCount + orderedTexelIndices.length);
                orderedTexelIndices.push(texelIdx);
                return ` ${id} `;
              }
            })
          )}`
        );
        // It's either a block row, a texel row, or the last row.
        const end = y < blockPaddedHeight - 1;
        const lineParts = end
          ? (y + 1) % blockHeight === 0
            ? parts.mid
            : parts.texelMid
          : parts.bot;
        lines.push(`   ${makeRow(blockPaddedWidth, width, lineParts)}`);
      }

      const pad2 = (n: number) => n.toString().padStart(2);
      const pad3 = (n: number) => n.toString().padStart(3);
      const fix5 = (n: number) => {
        const s = n.toFixed(5);
        return s === '0.00000' && n !== 0 ? n.toString() : s;
      };
      const formatValue = isSintOrUintFormat(format) ? pad3 : fix5;
      const formatTexel = (texel: PerTexelComponent<number> | undefined) =>
        texel
          ? Object.entries(texel)
              .map(([k, v]) => `${k}: ${formatValue(v)}`)
              .join(', ')
          : '*texel values unavailable*';

      const colorLines: string[] = [];
      const compareLines: string[] = [];
      let levelWeight = 0;
      orderedTexelIndices.forEach((texelIdx, i) => {
        const weights = layerEntries.get(texelIdx)!;
        const y = Math.floor(texelIdx / texelsPerRow);
        const x = texelIdx % texelsPerRow;
        const singleWeight = valueIfAllComponentsAreEqual(weights, components)!;
        levelWeight += singleWeight;
        const w =
          singleWeight !== undefined
            ? `weight: ${fix5(singleWeight)}`
            : `weights: [${components.map(c => `${c}: ${fix5(weights[c]!)}`).join(', ')}]`;
        const coord = `${pad2(x)}, ${pad2(y)}, ${pad2(layer)}`;
        const texel =
          texels &&
          convertToTexelViewFormat(
            texels[mipLevel].color({ x, y, z: layer }),
            softwareTexture.descriptor.format
          );

        const texelStr = formatTexel(texel);
        const id = letter(idCount + i);
        lines.push(`${id}: mip(${mipLevel}) at: [${coord}], ${w}`);
        colorLines.push(`${id}: value: ${texelStr}`);
        if (isBuiltinComparison(originalCall.builtin)) {
          assert(!!texel);
          const compareTexel = applyCompare(originalCall, sampler, [TexelComponent.Depth], texel);
          compareLines.push(
            `${id}: compare(${sampler.compare}) result with depthRef(${fix5(
              originalCall.depthRef!
            )}): ${fix5(compareTexel.Depth!)}`
          );
        }
      });
      lines.push(...colorLines);
      lines.push(...compareLines);
      if (!isNaN(levelWeight)) {
        lines.push(`mip level (${mipLevel}) weight: ${fix5(levelWeight)}`);
      }
      idCount += orderedTexelIndices.length;
    }
  }

  return lines;
}

function layoutTwoColumns(columnA: string[], columnB: string[]) {
  const widthA = Math.max(...columnA.map(l => l.length));
  const lines = Math.max(columnA.length, columnB.length);
  const out: string[] = new Array<string>(lines);
  for (let line = 0; line < lines; line++) {
    const a = columnA[line] ?? '';
    const b = columnB[line] ?? '';
    out[line] = `${a}${' '.repeat(widthA - a.length)} | ${b}`;
  }
  return out;
}

/**
 * Returns the number of layers ot test for a given view dimension
 */
export function getDepthOrArrayLayersForViewDimension(viewDimension?: GPUTextureViewDimension) {
  switch (viewDimension) {
    case '1d':
      return 1;
    case undefined:
    case '2d':
      return 1;
    case '2d-array':
      return 4;
    case '3d':
      return 8;
    case 'cube':
      return 6;
    default:
      unreachable();
  }
}

/**
 * Choose a texture size based on the given parameters.
 * The size will be in a multiple of blocks. If it's a cube
 * map the size will so be square.
 */
export function chooseTextureSize({
  minSize,
  minBlocks,
  format,
  viewDimension,
}: {
  minSize: number;
  minBlocks: number;
  format: GPUTextureFormat;
  viewDimension?: GPUTextureViewDimension;
}) {
  const { blockWidth, blockHeight } = getBlockInfoForTextureFormat(format);
  const width = align(Math.max(minSize, blockWidth * minBlocks), blockWidth);
  const height =
    viewDimension === '1d' ? 1 : align(Math.max(minSize, blockHeight * minBlocks), blockHeight);
  if (viewDimension === 'cube' || viewDimension === 'cube-array') {
    const blockLCM = lcm(blockWidth, blockHeight);
    const largest = Math.max(width, height);
    const size = align(largest, blockLCM);
    return [size, size, viewDimension === 'cube-array' ? 24 : 6];
  }
  const depthOrArrayLayers = getDepthOrArrayLayersForViewDimension(viewDimension);
  return [width, height, depthOrArrayLayers];
}

export const kSamplePointMethods = ['texel-centre', 'spiral'] as const;
export type SamplePointMethods = (typeof kSamplePointMethods)[number];

export const kCubeSamplePointMethods = ['cube-edges', 'texel-centre', 'spiral'] as const;
export type CubeSamplePointMethods = (typeof kSamplePointMethods)[number];

type TextureBuiltinInputArgs = {
  textureBuiltin?: TextureBuiltin;
  descriptor?: GPUTextureDescriptor;
  softwareTexture?: SoftwareTexture;
  sampler?: GPUSamplerDescriptor;
  derivatives?: boolean;
  mipLevel?: RangeDef;
  sampleIndex?: RangeDef;
  arrayIndex?: RangeDef;
  grad?: boolean;
  bias?: boolean;
  component?: boolean;
  depthRef?: boolean;
  offset?: boolean;
  hashInputs: (number | string | boolean)[];
};

/**
 * Generates an array of coordinates at which to sample a texture.
 */
function generateTextureBuiltinInputsImpl<T extends Dimensionality>(
  makeValue: (x: number, y: number, z: number) => T,
  n: number,
  args:
    | (TextureBuiltinInputArgs & {
        method: 'texel-centre';
      })
    | (TextureBuiltinInputArgs & {
        method: 'spiral';
        radius?: number;
        loops?: number;
      })
): {
  coords: T;
  derivativeMult?: T;
  ddx?: T;
  ddy?: T;
  mipLevel: number;
  sampleIndex?: number;
  arrayIndex?: number;
  bias?: number;
  offset?: T;
  component?: number;
  depthRef?: number;
}[] {
  const { method, descriptor, softwareTexture: info } = args;
  // MAINTENANCE_TODO: remove descriptor from all builtin tests. use softwareTexture instead
  assert(!!descriptor !== !!info, 'must pass descriptor or textureInfo');
  const textureInfo: SoftwareTexture = info ?? {
    descriptor: descriptor!,
    texels: [],
    viewDescriptor: {},
  };

  const { mipLevelCount, baseMipLevelSize } = getBaseMipLevelInfo(textureInfo);
  const dimension = textureInfo.descriptor.dimension ?? '2d';
  const coords: T[] = [];
  switch (method) {
    case 'texel-centre': {
      for (let i = 0; i < n; i++) {
        const r = hashU32(i);
        const x = Math.floor(lerp(0, baseMipLevelSize[0] - 1, (r & 0xff) / 0xff)) + 0.5;
        const y = Math.floor(lerp(0, baseMipLevelSize[1] - 1, ((r >> 8) & 0xff) / 0xff)) + 0.5;
        const z = Math.floor(lerp(0, baseMipLevelSize[2] - 1, ((r >> 16) & 0xff) / 0xff)) + 0.5;
        coords.push(
          makeValue(x / baseMipLevelSize[0], y / baseMipLevelSize[1], z / baseMipLevelSize[2])
        );
      }
      break;
    }
    case 'spiral': {
      const { radius = 1.5, loops = 2 } = args;
      for (let i = 0; i < n; i++) {
        const f = i / (Math.max(n, 2) - 1);
        const r = radius * f;
        const a = loops * 2 * Math.PI * f;
        coords.push(makeValue(0.5 + r * Math.cos(a), 0.5 + r * Math.sin(a), 0));
      }
      break;
    }
  }

  const _hashInputs = args.hashInputs.map(v =>
    typeof v === 'string' ? sumOfCharCodesOfString(v) : typeof v === 'boolean' ? (v ? 1 : 0) : v
  );

  // returns a number between [0 and N)
  const makeRandValue = ({ num, type }: RangeDef, ...hashInputs: number[]) => {
    const range = num;
    const number = (hashU32(..._hashInputs, ...hashInputs) / 0x1_0000_0000) * range;
    return type === 'f32' ? number : Math.floor(number);
  };

  // for signed and float values returns [-1 to num]
  // for unsigned values returns [0 to num]
  const makeRangeValue = ({ num, type }: RangeDef, ...hashInputs: number[]) => {
    const range = num + (type === 'u32' ? 1 : 2);
    const number =
      (hashU32(..._hashInputs, ...hashInputs) / 0x1_0000_0000) * range - (type === 'u32' ? 0 : 1);
    return type === 'f32' ? number : Math.floor(number);
  };

  // Generates the same values per coord instead of using all the extra `_hashInputs`.
  const makeIntHashValueRepeatable = (min: number, max: number, ...hashInputs: number[]) => {
    const range = max - min;
    return min + Math.floor((hashU32(...hashInputs) / 0x1_0000_0000) * range);
  };

  // Samplers across devices use different methods to interpolate.
  // Quantizing the texture coordinates seems to hit coords that produce
  // comparable results to our computed results.
  // Note: This value works with 8x8 textures. Other sizes have not been tested.
  // Values that worked for reference:
  // Win 11, NVidia 2070 Super: 16
  // Linux, AMD Radeon Pro WX 3200: 256
  // MacOS, M1 Mac: 256
  const kSubdivisionsPerTexel = 4;

  // When filtering is nearest then we want to avoid edges of texels
  //
  //             U
  //             |
  //     +---+---+---+---+---+---+---+---+
  //     |   | A | B |   |   |   |   |   |
  //     +---+---+---+---+---+---+---+---+
  //
  // Above, coordinate U could sample either A or B
  //
  //               U
  //               |
  //     +---+---+---+---+---+---+---+---+
  //     |   | A | B | C |   |   |   |   |
  //     +---+---+---+---+---+---+---+---+
  //
  // For textureGather we want to avoid texel centers
  // as for coordinate U could either gather A,B or B,C.

  const avoidEdgeCase =
    !args.sampler || args.sampler.minFilter === 'nearest' || isBuiltinGather(args.textureBuiltin);
  const edgeRemainder = isBuiltinGather(args.textureBuiltin) ? kSubdivisionsPerTexel / 2 : 0;

  // textureGather issues for 2d/3d textures
  //
  // If addressModeU is repeat, then on an 8x1 texture, u = 0.01 or u = 0.99
  // would gather these texels
  //
  //     +---+---+---+---+---+---+---+---+
  //     | * |   |   |   |   |   |   | * |
  //     +---+---+---+---+---+---+---+---+
  //
  // If addressModeU is clamp-to-edge or mirror-repeat,
  // then on an 8x1 texture, u = 0.01 would gather this texel
  //
  //     +---+---+---+---+---+---+---+---+
  //     | * |   |   |   |   |   |   |   |
  //     +---+---+---+---+---+---+---+---+
  //
  // and 0.99 would gather this texel
  //
  //     +---+---+---+---+---+---+---+---+
  //     |   |   |   |   |   |   |   | * |
  //     +---+---+---+---+---+---+---+---+
  //
  // This means we have to if addressMode is not `repeat`, we
  // need to avoid the edge of the texture.
  //
  // Note: we don't have these specific issues with cube maps
  // as they ignore addressMode
  const euclideanModulo = (n: number, m: number) => ((n % m) + m) % m;
  const addressMode: GPUAddressMode[] =
    args.textureBuiltin === 'textureSampleBaseClampToEdge'
      ? ['clamp-to-edge', 'clamp-to-edge', 'clamp-to-edge']
      : [
          args.sampler?.addressModeU ?? 'clamp-to-edge',
          args.sampler?.addressModeV ?? 'clamp-to-edge',
          args.sampler?.addressModeW ?? 'clamp-to-edge',
        ];
  const avoidTextureEdge = (axis: number, textureDimensionUnits: number, v: number) => {
    assert(isBuiltinGather(args.textureBuiltin));
    if (addressMode[axis] === 'repeat') {
      return v;
    }
    const inside = euclideanModulo(v, textureDimensionUnits);
    const outside = v - inside;
    return outside + clamp(inside, { min: 1, max: textureDimensionUnits - 1 });
  };

  const numComponents = isDepthOrStencilTextureFormat(textureInfo.descriptor.format) ? 1 : 4;
  return coords.map((c, i) => {
    const mipLevel = args.mipLevel
      ? quantizeMipLevel(makeRangeValue(args.mipLevel, i), args.sampler?.mipmapFilter ?? 'nearest')
      : 0;
    const clampedMipLevel = clamp(mipLevel, { min: 0, max: mipLevelCount - 1 });
    const mipSize = virtualMipSize(dimension, baseMipLevelSize, clampedMipLevel);
    const q = mipSize.map(v => v * kSubdivisionsPerTexel);

    const coords = c.map((v, i) => {
      // Quantize to kSubdivisionsPerPixel
      const v1 = Math.floor(v * q[i]);
      // If it's nearest or textureGather and we're on the edge of a texel then move us off the edge
      // since the edge could choose one texel or another.
      const isTexelEdgeCase = Math.abs(v1 % kSubdivisionsPerTexel) === edgeRemainder;
      const v2 = isTexelEdgeCase && avoidEdgeCase ? v1 + 1 : v1;
      const v3 = isBuiltinGather(args.textureBuiltin) ? avoidTextureEdge(i, q[i], v2) : v2;
      // Convert back to texture coords
      return v3 / q[i];
    }) as T;

    const makeGradient = <T>(hashInput: number): T => {
      return coords.map((_, i) => {
        // a value between -4 and 4 integer then add +/- 0.25
        // We want to be able to choose levels but we want to avoid the area where the
        // gpu might choose 2 different levels than the software renderer.
        const intPart = makeRangeValue({ num: 8, type: 'u32' }, i, hashInput) - 4;
        const fractPart = makeRangeValue({ num: 0, type: 'f32' }, i, hashInput + 1) * 0.25;
        assert(fractPart >= -0.25 && fractPart <= 0.25);
        return intPart + fractPart;
      }) as T;
    };

    // choose a derivative value that will select a mipLevel.
    const makeDerivativeMult = (coords: T, mipLevel: number): T => {
      // Make an identity vec (all 1s).
      const mult = new Array(coords.length).fill(0);
      // choose one axis to set
      const ndx = makeRangeValue({ num: coords.length - 1, type: 'u32' }, i, 8);
      assert(ndx < coords.length);
      mult[ndx] = Math.pow(2, mipLevel);
      return mult as T;
    };

    // Choose a mip level. If mipmapFilter is 'nearest' then avoid centers of levels
    // else avoid edges.
    const chooseMipLevel = () => {
      const innerLevelR = makeRandValue({ num: 9, type: 'u32' }, i, 11);
      const innerLevel =
        args?.sampler?.mipmapFilter === 'linear'
          ? innerLevelR + 1
          : innerLevelR < 5
          ? innerLevelR
          : innerLevelR + 1;
      const outerLevel = makeRangeValue({ num: mipLevelCount - 1, type: 'i32' }, i, 11);
      return outerLevel + innerLevel / 10;
    };

    // for textureSample, choose a derivative value that will select a mipLevel near
    // the range of mip levels.
    const makeDerivativeMultForTextureSample = (coords: T): T => {
      const mipLevel = chooseMipLevel();
      return makeDerivativeMult(coords, mipLevel);
    };

    // for textureSampleBias we choose a mipLevel we want to sample, then a bias,
    // and then a derivative that, given the chosen bias will arrive at the chosen mipLevel.
    // The GPU is supposed to clamp between -16.0 and 15.99.
    //
    // Testing clamping with textureSampleBias is prone to precision issues. The reason is, to test
    // that the bias is clamped, a natural thing to do is:
    //
    // * Create a texture with N mip levels, Eg 3. (lets do 8x8, 4x4, 2x2)
    // * Choose a target mipLevel. Eg 1.5
    // * Choose a bias that will need to be clamped. Eg 20.0. Clamped this will be 15.99
    // * Choose a derivative that selects mipLevel -14.49
    // * Check if we sampled mip level 1.5 (because -14.49 + bias(15.99) = 1.5)
    //
    // Unfortunately, to select a mipLevel of -14.49 via derivatives requires a small enough value
    // (eg: 0.000005432320387256895) that based on internal precision issues in the GPU, might
    // not calculate -14.49 but instead +/- 0.5 or worse (1 exponent change in the floating point
    // representation worth of difference?)
    //
    // To work around this issue we do the following
    //
    // * to test negative bias is clamped
    //
    //   * choose a target of 4.0 (assuming 3 mips this is past the 3rd mip level and should be clamped to 3)
    //   * choose a bias of like -25 (so should be clamped to -16)
    //   * choose a derivative that computes a mipLevel of 20 because (-16 + 20) = 4 (our target)
    //
    //   If the result was clamped we should sample only mip level 3. If the result was not clamped we'll sample
    //   mip level 0.
    //
    //   Note: we'll choose mipLevelCount + 1 as our target so that we have 1 unit of extra range.
    //   This won't tell is if the bias is clamped to -16 but it will tell us it's clamped to at least -18
    //
    // * to test positive bias is clamped
    //
    //   * same as above just reverse the signs and clamp to 15.99
    //
    // * to test bias works in general
    //
    //   * test small values like +/- 3
    //
    const makeBiasAndDerivativeMult = (coords: T): [number, T] => {
      const testType = makeRandValue({ num: 4, type: 'u32' }, i, 11);
      let mipLevel;
      let bias;
      switch (testType) {
        case 0:
          // test negative bias
          mipLevel = mipLevelCount + 1;
          bias = -25;
          // example:
          //   mipLevel                = 4
          //   bias                    = -25
          //   clampedBias             = -16
          //   derivativeBasedMipLevel = mipLevel - clampedBias = 4 - -16 = 20
          //   expectedMipLevel        = derivativeBasedMipLevel + clampedBias = 20 + -16 = 4
          //   if bias is not clamped. For example it's -18 then:
          //   actualMipLevel =  20 + -18 = 2  // this would be an error.
          break;
        case 1:
          // test positive bias
          mipLevel = -1;
          bias = 25;
          // example:
          //   mipLevel                = -1
          //   bias                    = 25
          //   clampedBias             = 15.99
          //   derivativeBasedMipLevel = mipLevel - clampedBias = -1 - 15.99 = -16.99
          //   expectedMipLevel        = derivativeBasedMipLevel + clampedBias = -16.99 + 15.99 = -1
          //   if bias is not clamped. For example it's 18 then:
          //   actualMipLevel =  -16.99 + 18 = 1.99  // this would be an error.
          break;
        default: // test small-ish middle bias
          mipLevel = chooseMipLevel();
          bias = makeRangeValue({ num: 6, type: 'f32' }, i, 9) - 3;
          break;
      }
      const clampedBias = clamp(bias, { min: -16, max: 15.99 });
      const derivativeBasedMipLevel = mipLevel - clampedBias;
      const derivativeMult = makeDerivativeMult(coords, derivativeBasedMipLevel);
      return [bias, derivativeMult];
    };

    // If bias is set this is textureSampleBias. If bias is not set but derivatives
    // is then this is one of the other functions that needs implicit derivatives.
    const [bias, derivativeMult] = args.bias
      ? makeBiasAndDerivativeMult(coords)
      : args.derivatives
      ? [undefined, makeDerivativeMultForTextureSample(coords)]
      : [];

    return {
      coords,
      derivativeMult,
      mipLevel,
      sampleIndex: args.sampleIndex ? makeRangeValue(args.sampleIndex, i, 1) : undefined,
      arrayIndex: args.arrayIndex ? makeRangeValue(args.arrayIndex, i, 2) : undefined,
      // use 0.0, 0.5, or 1.0 for depthRef. We can't test for equality except for values 0 and 1
      // The texture will be filled with random values unless our comparison is 'equal' or 'not-equal'
      // in which case the texture will be filled with only 0, 0.6, 1. Choosing 0.0, 0.5, 1.0 here
      // means we can test 'equal' and 'not-equal'. For other comparisons, the fact that the texture's
      // contents is random seems enough to test all the comparison modes.
      depthRef: args.depthRef ? makeRandValue({ num: 3, type: 'u32' }, i, 5) / 2 : undefined,
      ddx: args.grad ? makeGradient(7) : undefined,
      ddy: args.grad ? makeGradient(8) : undefined,
      bias,
      offset: args.offset
        ? (coords.map((_, j) => makeIntHashValueRepeatable(-8, 8, i, 3 + j)) as T)
        : undefined,
      component: args.component ? makeIntHashValueRepeatable(0, numComponents, i, 4) : undefined,
    };
  });
}

/**
 * When mipmapFilter === 'nearest' we need to stay away from 0.5
 * because the GPU could decide to choose one mip or the other.
 *
 * Some example transition values, the value at which the GPU chooses
 * mip level 1 over mip level 0:
 *
 * M1 Mac: 0.515381
 * Intel Mac: 0.49999
 * AMD Mac: 0.5
 */
const kMipEpsilon = 0.02;
function quantizeMipLevel(mipLevel: number, mipmapFilter: GPUMipmapFilterMode) {
  if (mipmapFilter === 'linear') {
    return mipLevel;
  }
  const intMip = Math.floor(mipLevel);
  const fractionalMip = mipLevel - intMip;
  if (fractionalMip < 0.5 - kMipEpsilon || fractionalMip > 0.5 + kMipEpsilon) {
    return mipLevel;
  } else {
    return intMip + 0.5 + (fractionalMip < 0.5 ? -kMipEpsilon : +kMipEpsilon);
  }
}

// Removes the first element from an array of types
type FilterFirstElement<T extends unknown[]> = T extends [unknown, ...infer R] ? R : [];

type GenerateTextureBuiltinInputsImplArgs = FilterFirstElement<
  Parameters<typeof generateTextureBuiltinInputsImpl>
>;

export function generateTextureBuiltinInputs1D(...args: GenerateTextureBuiltinInputsImplArgs) {
  return generateTextureBuiltinInputsImpl<vec1>((x: number) => [x], ...args);
}

export function generateTextureBuiltinInputs2D(...args: GenerateTextureBuiltinInputsImplArgs) {
  return generateTextureBuiltinInputsImpl<vec2>((x: number, y: number) => [x, y], ...args);
}

export function generateTextureBuiltinInputs3D(...args: GenerateTextureBuiltinInputsImplArgs) {
  return generateTextureBuiltinInputsImpl<vec3>(
    (x: number, y: number, z: number) => [x, y, z],
    ...args
  );
}

type mat3 =
  /* prettier-ignore */ [
  number, number, number,
  number, number, number,
  number, number, number,
];

const kFaceUVMatrices: mat3[] =
  /* prettier-ignore */ [
  [ 0,  0,  -2,  0, -2,   0,  1,  1,   1],   // pos-x
  [ 0,  0,   2,  0, -2,   0, -1,  1,  -1],   // neg-x
  [ 2,  0,   0,  0,  0,   2, -1,  1,  -1],   // pos-y
  [ 2,  0,   0,  0,  0,  -2, -1, -1,   1],   // neg-y
  [ 2,  0,   0,  0, -2,   0, -1,  1,   1],   // pos-z
  [-2,  0,   0,  0, -2,   0,  1,  1,  -1],   // neg-z
];

/** multiply a vec3 by mat3 */
function transformMat3(v: vec3, m: mat3): vec3 {
  const x = v[0];
  const y = v[1];
  const z = v[2];

  return [
    x * m[0] + y * m[3] + z * m[6],
    x * m[1] + y * m[4] + z * m[7],
    x * m[2] + y * m[5] + z * m[8],
  ];
}

/** normalize a vec3 */
function normalize(v: vec3): vec3 {
  const length = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  assert(length > 0);
  return v.map(v => v / length) as vec3;
}

/**
 * Converts a cube map coordinate to a uv coordinate (0 to 1) and layer (0.5/6.0 to 5.5/6.0).
 */
function convertCubeCoordToNormalized3DTextureCoord(v: vec3): vec3 {
  let uvw;
  let layer;
  // normalize the coord.
  // MAINTENANCE_TODO: handle(0, 0, 0)
  const r = normalize(v);
  const absR = r.map(v => Math.abs(v));
  if (absR[0] > absR[1] && absR[0] > absR[2]) {
    // x major
    const negX = r[0] < 0.0 ? 1 : 0;
    uvw = [negX ? r[2] : -r[2], -r[1], absR[0]];
    layer = negX;
  } else if (absR[1] > absR[2]) {
    // y major
    const negY = r[1] < 0.0 ? 1 : 0;
    uvw = [r[0], negY ? -r[2] : r[2], absR[1]];
    layer = 2 + negY;
  } else {
    // z major
    const negZ = r[2] < 0.0 ? 1 : 0;
    uvw = [negZ ? -r[0] : r[0], -r[1], absR[2]];
    layer = 4 + negZ;
  }
  return [(uvw[0] / uvw[2] + 1) * 0.5, (uvw[1] / uvw[2] + 1) * 0.5, (layer + 0.5) / 6];
}

/**
 * Convert a 3d texcoord into a cube map coordinate.
 */
function convertNormalized3DTexCoordToCubeCoord(uvLayer: vec3) {
  const [u, v, faceLayer] = uvLayer;
  return normalize(transformMat3([u, v, 1], kFaceUVMatrices[Math.min(5, faceLayer * 6) | 0]));
}

/**
 * Wrap a texel based face coord across cube faces
 *
 * We have a face texture in texels coord where U/V choose a texel and W chooses the face.
 * If U/V are outside the size of the texture then, when normalized and converted
 * to a cube map coordinate, they'll end up pointing to a different face.
 *
 * addressMode is effectively ignored for cube
 *
 * By converting from a texel based coord to a normalized coord and then to a cube map coord,
 * if the texel was outside of the face, the cube map coord will end up pointing to a different
 * face. We then convert back cube coord -> normalized face coord -> texel based coord
 */
function wrapFaceCoordToCubeFaceAtEdgeBoundaries(mipLevelSize: number, faceCoord: vec3) {
  // convert texel based face coord to normalized 2d-array coord
  const nc0: vec3 = [
    (faceCoord[0] + 0.5) / mipLevelSize,
    (faceCoord[1] + 0.5) / mipLevelSize,
    (faceCoord[2] + 0.5) / 6,
  ];
  const cc = convertNormalized3DTexCoordToCubeCoord(nc0);
  const nc1 = convertCubeCoordToNormalized3DTextureCoord(cc);
  // convert normalized 2d-array coord back texel based face coord
  const fc = [
    Math.floor(nc1[0] * mipLevelSize),
    Math.floor(nc1[1] * mipLevelSize),
    Math.floor(nc1[2] * 6),
  ];

  return fc;
}

function applyAddressModesToCoords(
  addressMode: GPUAddressMode[],
  mipLevelSize: number[],
  coord: number[]
) {
  return coord.map((v, i) => {
    switch (addressMode[i]) {
      case 'clamp-to-edge':
        return clamp(v, { min: 0, max: mipLevelSize[i] - 1 });
      case 'mirror-repeat': {
        const n = Math.floor(v / mipLevelSize[i]);
        v = v - n * mipLevelSize[i];
        return (n & 1) !== 0 ? mipLevelSize[i] - v - 1 : v;
      }
      case 'repeat':
        return v - Math.floor(v / mipLevelSize[i]) * mipLevelSize[i];
      default:
        unreachable();
    }
  });
}

/**
 * Generates an array of coordinates at which to sample a texture for a cubemap
 */
export function generateSamplePointsCube(
  n: number,
  args:
    | (TextureBuiltinInputArgs & {
        method: 'texel-centre';
      })
    | (TextureBuiltinInputArgs & {
        method: 'spiral';
        radius?: number;
        loops?: number;
      })
    | (TextureBuiltinInputArgs & {
        method: 'cube-edges';
      })
): {
  coords: vec3;
  derivativeMult?: vec3;
  ddx?: vec3;
  ddy?: vec3;
  mipLevel: number;
  arrayIndex?: number;
  bias?: number;
  offset?: undefined;
  component?: number;
  depthRef?: number;
}[] {
  const { method, descriptor, softwareTexture: info } = args;
  // MAINTENANCE_TODO: remove descriptor from all builtin tests. use textureInfo.
  assert(!!descriptor !== !!info, 'must pass descriptor or textureInfo');
  const textureInfo: SoftwareTexture = info ?? {
    descriptor: descriptor!,
    texels: [],
    viewDescriptor: {},
  };

  const { mipLevelCount, baseMipLevelSize } = getBaseMipLevelInfo(textureInfo);
  const textureWidth = baseMipLevelSize[0];
  const coords: vec3[] = [];
  switch (method) {
    case 'texel-centre': {
      for (let i = 0; i < n; i++) {
        const r = hashU32(i);
        const u = (Math.floor(lerp(0, textureWidth - 1, (r & 0xff) / 0xff)) + 0.5) / textureWidth;
        const v =
          (Math.floor(lerp(0, textureWidth - 1, ((r >> 8) & 0xff) / 0xff)) + 0.5) / textureWidth;
        const face = Math.floor(lerp(0, 6, ((r >> 16) & 0xff) / 0x100));
        coords.push(convertNormalized3DTexCoordToCubeCoord([u, v, face]));
      }
      break;
    }
    case 'spiral': {
      const { radius = 1.5, loops = 2 } = args;
      for (let i = 0; i < n; i++) {
        const f = (i + 1) / (Math.max(n, 2) - 1);
        const r = radius * f;
        const theta = loops * 2 * Math.PI * f;
        const phi = loops * 1.3 * Math.PI * f;
        const sinTheta = Math.sin(theta);
        const cosTheta = Math.cos(theta);
        const sinPhi = Math.sin(phi);
        const cosPhi = Math.cos(phi);
        const ux = cosTheta * sinPhi;
        const uy = cosPhi;
        const uz = sinTheta * sinPhi;
        coords.push([ux * r, uy * r, uz * r]);
      }
      break;
    }
    case 'cube-edges': {
      /* prettier-ignore */
      coords.push(
        // between edges
        // +x
        [  1   , -1.01,  0    ],  // wrap -y
        [  1   , +1.01,  0    ],  // wrap +y
        [  1   ,  0   , -1.01 ],  // wrap -z
        [  1   ,  0   , +1.01 ],  // wrap +z
        // -x
        [ -1   , -1.01,  0    ],  // wrap -y
        [ -1   , +1.01,  0    ],  // wrap +y
        [ -1   ,  0   , -1.01 ],  // wrap -z
        [ -1   ,  0   , +1.01 ],  // wrap +z

        // +y
        [ -1.01,  1   ,  0    ],  // wrap -x
        [ +1.01,  1   ,  0    ],  // wrap +x
        [  0   ,  1   , -1.01 ],  // wrap -z
        [  0   ,  1   , +1.01 ],  // wrap +z
        // -y
        [ -1.01, -1   ,  0    ],  // wrap -x
        [ +1.01, -1   ,  0    ],  // wrap +x
        [  0   , -1   , -1.01 ],  // wrap -z
        [  0   , -1   , +1.01 ],  // wrap +z

        // +z
        [ -1.01,  0   ,  1    ],  // wrap -x
        [ +1.01,  0   ,  1    ],  // wrap +x
        [  0   , -1.01,  1    ],  // wrap -y
        [  0   , +1.01,  1    ],  // wrap +y
        // -z
        [ -1.01,  0   , -1    ],  // wrap -x
        [ +1.01,  0   , -1    ],  // wrap +x
        [  0   , -1.01, -1    ],  // wrap -y
        [  0   , +1.01, -1    ],  // wrap +y

        // corners (see comment "Issues with corners of cubemaps")
        // for why these are commented out.
        // [-1.01, -1.02, -1.03],
        // [ 1.01, -1.02, -1.03],
        // [-1.01,  1.02, -1.03],
        // [ 1.01,  1.02, -1.03],
        // [-1.01, -1.02,  1.03],
        // [ 1.01, -1.02,  1.03],
        // [-1.01,  1.02,  1.03],
        // [ 1.01,  1.02,  1.03],
      );
      break;
    }
  }

  const _hashInputs = args.hashInputs.map(v =>
    typeof v === 'string' ? sumOfCharCodesOfString(v) : typeof v === 'boolean' ? (v ? 1 : 0) : v
  );

  // returns a number between [0 and N)
  const makeRandValue = ({ num, type }: RangeDef, ...hashInputs: number[]) => {
    const range = num;
    const number = (hashU32(..._hashInputs, ...hashInputs) / 0x1_0000_0000) * range;
    return type === 'f32' ? number : Math.floor(number);
  };

  // for signed and float values returns [-1 to num]
  // for unsigned values returns [0 to num]
  const makeRangeValue = ({ num, type }: RangeDef, ...hashInputs: number[]) => {
    const range = num + (type === 'u32' ? 1 : 2);
    const number =
      (hashU32(..._hashInputs, ...hashInputs) / 0x1_0000_0000) * range - (type === 'u32' ? 0 : 1);
    return type === 'f32' ? number : Math.floor(number);
  };

  const makeIntHashValue = (min: number, max: number, ...hashInputs: number[]) => {
    const range = max - min;
    return min + Math.floor((hashU32(..._hashInputs, ...hashInputs) / 0x1_0000_0000) * range);
  };

  // Samplers across devices use different methods to interpolate.
  // Quantizing the texture coordinates seems to hit coords that produce
  // comparable results to our computed results.
  // Note: This value works with 8x8 textures. Other sizes have not been tested.
  // Values that worked for reference:
  // Win 11, NVidia 2070 Super: 16
  // Linux, AMD Radeon Pro WX 3200: 256
  // MacOS, M1 Mac: 256
  //
  // Note: When doing `textureGather...` we can't use texel centers
  // because which 4 pixels will be gathered jumps if we're slightly under
  // or slightly over the center
  //
  // Similarly, if we're using 'nearest' filtering then we don't want texel
  // edges for the same reason.
  //
  // Also note that for textureGather. The way it works for cube maps is to
  // first convert from cube map coordinate to a 2D texture coordinate and
  // a face. Then, choose 4 texels just like normal 2D texture coordinates.
  // If one of the 4 texels is outside the current face, wrap it to the correct
  // face.
  //
  // An issue this brings up though. Imagine a 2D texture with addressMode = 'repeat'
  //
  //       2d texture   (same texture repeated to show 'repeat')
  //     ┌───┬───┬───┐     ┌───┬───┬───┐
  //     │   │   │   │     │   │   │   │
  //     ├───┼───┼───┤     ├───┼───┼───┤
  //     │   │   │  a│     │c  │   │   │
  //     ├───┼───┼───┤     ├───┼───┼───┤
  //     │   │   │  b│     │d  │   │   │
  //     └───┴───┴───┘     └───┴───┴───┘
  //
  // Assume the texture coordinate is at the bottom right corner of a.
  // Then textureGather will grab c, d, b, a (no idea why that order).
  // but think of it as top-right, bottom-right, bottom-left, top-left.
  // Similarly, if the texture coordinate is at the top left of d it
  // will select the same 4 texels.
  //
  // But, in the case of a cubemap, each face is in different direction
  // relative to the face next to it.
  //
  //             +-----------+
  //             |0->u       |
  //             |↓          |
  //             |v   +y     |
  //             |    (2)    |
  //             |           |
  // +-----------+-----------+-----------+-----------+
  // |0->u       |0->u       |0->u       |0->u       |
  // |↓          |↓          |↓          |↓          |
  // |v   -x     |v   +z     |v   +x     |v   -z     |
  // |    (1)    |    (4)    |    (0)    |    (5)    |
  // |           |           |           |           |
  // +-----------+-----------+-----------+-----------+
  //             |0->u       |
  //             |↓          |
  //             |v   -y     |
  //             |    (3)    |
  //             |           |
  //             +-----------+
  //
  // As an example, imagine going from the +y to the +x face.
  // See diagram above, the right edge of the +y face wraps
  // to the top edge of the +x face.
  //
  //                             +---+---+
  //                             |  a|c  |
  //     ┌───┬───┬───┐           ┌───┬───┬───┐
  //     │   │   │   │           │  b│d  │   │
  //     ├───┼───┼───┤---+       ├───┼───┼───┤
  //     │   │   │  a│ c |       │   │   │   │
  //     ├───┼───┼───┤---+       ├───┼───┼───┤
  //     │   │   │  b│ d |       │   │   │   │
  //     └───┴───┴───┘---+       └───┴───┴───┘
  //        +y face                 +x face
  //
  // If the texture coordinate is in the bottom right corner of a,
  // the rectangle of texels we read are a,b,c,d and, if we the
  // texture coordinate is in the top left corner of d we also
  // read a,b,c,d according to the 2 diagrams above.
  //
  // But, notice that when reading from the POV of +y vs +x,
  // which actual a,b,c,d texels are different.
  //
  // From the POV of face +x: a,b are in face +x and c,d are in face +y
  // From the POV of face +y: a,c are in face +x and b,d are in face +y
  //
  // This is all the long way of saying that if we're on the edge of a cube
  // face we could get drastically different results because the orientation
  // of the rectangle of the 4 texels we use, rotates. So, we need to avoid
  // any values too close to the edge just in case our math is different than
  // the GPU's.
  //
  const kSubdivisionsPerTexel = 4;
  const avoidEdgeCase =
    !args.sampler || args.sampler.minFilter === 'nearest' || isBuiltinGather(args.textureBuiltin);
  const edgeRemainder = isBuiltinGather(args.textureBuiltin) ? kSubdivisionsPerTexel / 2 : 0;
  return coords.map((c, i) => {
    const mipLevel = args.mipLevel
      ? quantizeMipLevel(makeRangeValue(args.mipLevel, i), args.sampler?.mipmapFilter ?? 'nearest')
      : 0;
    const clampedMipLevel = clamp(mipLevel, { min: 0, max: mipLevelCount - 1 });
    const mipSize = virtualMipSize('2d', baseMipLevelSize, Math.ceil(clampedMipLevel));
    const q = [
      mipSize[0] * kSubdivisionsPerTexel,
      mipSize[0] * kSubdivisionsPerTexel,
      6 * kSubdivisionsPerTexel,
    ];

    const uvw = convertCubeCoordToNormalized3DTextureCoord(c);

    // If this is a corner, move to in so it's not
    // (see comment "Issues with corners of cubemaps")
    const ndx = getUnusedCubeCornerSampleIndex(mipSize[0], uvw);
    if (ndx >= 0) {
      const halfTexel = 0.5 / mipSize[0];
      uvw[0] = clamp(uvw[0], { min: halfTexel, max: 1 - halfTexel });
    }

    const quantizedUVW = uvw.map((v, i) => {
      // Quantize to kSubdivisionsPerPixel
      const v1 = Math.floor(v * q[i]);
      // If it's nearest or textureGather and we're on the edge of a texel then move us off the edge
      // since the edge could choose one texel or another.
      const isEdgeCase = Math.abs(v1 % kSubdivisionsPerTexel) === edgeRemainder;
      const v2 = isEdgeCase && avoidEdgeCase ? v1 + 1 : v1;
      // Convert back to texture coords slightly off
      return (v2 + 1 / 16) / q[i];
    }) as vec3;

    const quantize = (v: number, units: number) => Math.floor(v * units) * units;

    const makeGradient = <T>(hashInput: number): T => {
      return coords.map((_, i) =>
        // a value between -4 and 4, quantized to 1/3rd.
        quantize(makeRangeValue({ num: 8, type: 'f32' }, i, hashInput) - 4, 1 / 3)
      ) as T;
    };

    const coords = convertNormalized3DTexCoordToCubeCoord(quantizedUVW);

    // choose a derivative value that will select a mipLevel.
    const makeDerivativeMult = (coords: vec3, mipLevel: number): vec3 => {
      // Make an identity vec (all 1s).
      const mult = new Array(coords.length).fill(0);
      // choose one axis to set
      const ndx = makeRangeValue({ num: coords.length - 1, type: 'u32' }, i, 8);
      assert(ndx < coords.length);
      mult[ndx] = Math.pow(2, mipLevel);
      return mult as vec3;
    };

    // Choose a mip level. If mipmapFilter is 'nearest' then avoid centers of levels
    // else avoid edges.
    const chooseMipLevel = () => {
      const innerLevelR = makeRandValue({ num: 9, type: 'u32' }, i, 11);
      const innerLevel =
        args?.sampler?.mipmapFilter === 'linear'
          ? innerLevelR + 1
          : innerLevelR < 4
          ? innerLevelR
          : innerLevelR + 1;
      const outerLevel = makeRangeValue({ num: mipLevelCount - 1, type: 'i32' }, i, 11);
      return outerLevel + innerLevel / 10;
    };

    // for textureSample, choose a derivative value that will select a mipLevel near
    // the range of mip levels.
    const makeDerivativeMultForTextureSample = (coords: vec3): vec3 => {
      const mipLevel = chooseMipLevel();
      return makeDerivativeMult(coords, mipLevel);
    };

    // See makeBiasAndDerivativeMult in generateTextureBuiltinInputsImpl
    const makeBiasAndDerivativeMult = (coords: vec3): [number, vec3] => {
      const testType = makeRandValue({ num: 4, type: 'u32' }, i, 11);
      let mipLevel;
      let bias;
      switch (testType) {
        case 0:
          // test negative bias
          mipLevel = mipLevelCount + 1;
          bias = -25;
          break;
        case 1:
          // test positive bias
          mipLevel = -1;
          bias = 25;
          break;
        default: // test small-ish middle bias
          mipLevel = chooseMipLevel();
          bias = makeRangeValue({ num: 6, type: 'f32' }, i, 9) - 3;
          break;
      }
      const clampedBias = clamp(bias, { min: -16, max: 15.99 });
      const derivativeBasedMipLevel = mipLevel - clampedBias;
      const derivativeMult = makeDerivativeMult(coords, derivativeBasedMipLevel);
      return [bias, derivativeMult];
    };

    // If bias is set this is textureSampleBias. If bias is not set but derivatives
    // is then this is one of the other functions that needs implicit derivatives.
    const [bias, derivativeMult] = args.bias
      ? makeBiasAndDerivativeMult(coords)
      : args.derivatives
      ? [undefined, makeDerivativeMultForTextureSample(coords)]
      : [];

    return {
      coords,
      derivativeMult,
      ddx: args.grad ? makeGradient(7) : undefined,
      ddy: args.grad ? makeGradient(8) : undefined,
      mipLevel,
      arrayIndex: args.arrayIndex ? makeRangeValue(args.arrayIndex, i, 2) : undefined,
      bias,
      // use 0.0, 0.5, or 1.0 for depthRef. We can't test for equality except for values 0 and 1
      // The texture will be filled with random values unless our comparison is 'equal' or 'not-equal'
      // in which case the texture will be filled with only 0, 0.6, 1. Choosing 0.0, 0.5, 1.0 here
      // means we can test 'equal' and 'not-equal'. For other comparisons, the fact that the texture's
      // contents is random seems enough to test all the comparison modes.
      depthRef: args.depthRef ? makeRandValue({ num: 3, type: 'u32' }, i, 5) / 2 : undefined,
      component: args.component ? makeIntHashValue(0, 4, i, 4) : undefined,
    };
  });
}

function wgslTypeFor(data: number | Dimensionality, type: 'f' | 'i' | 'u'): string {
  if (Array.isArray(data)) {
    switch (data.length) {
      case 1:
        return `${type}32`;
      case 2:
        return `vec2${type}`;
      case 3:
        return `vec3${type}`;
      default:
        unreachable();
    }
  }
  return `${type}32`;
}

function wgslExpr(
  data: number | Readonly<vec1> | Readonly<vec2> | Readonly<vec3> | Readonly<vec4>
): string {
  if (Array.isArray(data)) {
    switch (data.length) {
      case 1:
        return data[0].toString();
      case 2:
        return `vec2(${data.map(v => v.toString()).join(', ')})`;
      case 3:
        return `vec3(${data.map(v => v.toString()).join(', ')})`;
      default:
        unreachable();
    }
  }
  return data.toString();
}

function wgslExprFor(data: number | vec1 | vec2 | vec3 | vec4, type: 'f' | 'i' | 'u'): string {
  if (Array.isArray(data)) {
    switch (data.length) {
      case 1:
        return `${type}(${data[0].toString()})`;
      case 2:
        return `vec2${type}(${data.map(v => v.toString()).join(', ')})`;
      case 3:
        return `vec3${type}(${data.map(v => v.toString()).join(', ')})`;
      default:
        unreachable();
    }
  }
  return `${type}32(${data.toString()})`;
}

function binKey<T extends Dimensionality>(call: TextureCall<T>): string {
  const keys: string[] = [];
  for (const name of kTextureCallArgNames) {
    const value = call[name];
    if (value !== undefined) {
      if (name === 'offset' || name === 'component') {
        // offset and component must be constant expressions
        keys.push(`${name}: ${wgslExpr(value)}`);
      } else {
        keys.push(`${name}: ${wgslTypeFor(value, call.coordType)}`);
      }
    }
  }
  return `${call.builtin}(${keys.join(', ')})`;
}

function buildBinnedCalls<T extends Dimensionality>(calls: TextureCall<T>[]) {
  const args: string[] = [];
  const fields: string[] = [];
  const data: number[] = [];
  const prototype = calls[0];

  if (isBuiltinGather(prototype.builtin) && prototype['componentType']) {
    args.push(`/* component */ ${wgslExpr(prototype['component']!)}`);
  }

  // All texture builtins take a Texture
  args.push('T');

  if (builtinNeedsSampler(prototype.builtin)) {
    // textureSample*() builtins take a sampler as the second argument
    args.push('S');
  }

  for (const name of kTextureCallArgNames) {
    const value = prototype[name];
    if (value !== undefined) {
      if (name === 'offset') {
        args.push(`/* offset */ ${wgslExpr(value)}`);
      } else if (name === 'component') {
        // was handled above
      } else {
        const type =
          name === 'mipLevel'
            ? prototype.levelType!
            : name === 'arrayIndex'
            ? prototype.arrayIndexType!
            : name === 'sampleIndex'
            ? prototype.sampleIndexType!
            : name === 'bias' || name === 'depthRef' || name === 'ddx' || name === 'ddy'
            ? 'f'
            : prototype.coordType;
        if (name !== 'derivativeMult') {
          args.push(
            `args.${name}${
              name === 'coords' && builtinNeedsDerivatives(prototype.builtin)
                ? ' + derivativeBase * args.derivativeMult'
                : ''
            }`
          );
        }
        fields.push(`@align(16) ${name} : ${wgslTypeFor(value, type)}`);
      }
    }
  }

  for (const call of calls) {
    for (const name of kTextureCallArgNames) {
      const value = call[name];
      assert(
        (prototype[name] === undefined) === (value === undefined),
        'texture calls are not binned correctly'
      );
      if (value !== undefined && name !== 'offset' && name !== 'component') {
        const type = getCallArgType<T>(call, name);
        const bitcastToU32 = kBitCastFunctions[type];
        if (value instanceof Array) {
          for (const c of value) {
            data.push(bitcastToU32(c));
          }
        } else {
          data.push(bitcastToU32(value));
        }
        // All fields are aligned to 16 bytes.
        while ((data.length & 3) !== 0) {
          data.push(0);
        }
      }
    }
  }

  const expr = `${prototype.builtin}(${args.join(', ')})`;

  return { expr, fields, data };
}

function binCalls<T extends Dimensionality>(calls: TextureCall<T>[]): number[][] {
  const map = new Map<string, number>(); // key to bin index
  const bins: number[][] = [];
  calls.forEach((call, callIdx) => {
    const key = binKey(call);
    const binIdx = map.get(key);
    if (binIdx === undefined) {
      map.set(key, bins.length);
      bins.push([callIdx]);
    } else {
      bins[binIdx].push(callIdx);
    }
  });
  return bins;
}

function describeTextureCall<T extends Dimensionality>(call: TextureCall<T>): string {
  const args: string[] = [];
  if (isBuiltinGather(call.builtin) && call.componentType) {
    args.push(`component: ${wgslExprFor(call.component!, call.componentType)}`);
  }
  args.push('texture: T');
  if (builtinNeedsSampler(call.builtin)) {
    args.push('sampler: S');
  }
  for (const name of kTextureCallArgNames) {
    const value = call[name];
    if (value !== undefined && name !== 'component') {
      if (name === 'coords') {
        const derivativeWGSL = builtinNeedsDerivatives(call.builtin)
          ? ` + derivativeBase * derivativeMult(${
              call.derivativeMult ? wgslExprFor(call.derivativeMult, call.coordType) : '1'
            })`
          : '';
        args.push(`${name}: ${wgslExprFor(value, call.coordType)}${derivativeWGSL}`);
      } else if (name === 'derivativeMult') {
        // skip this - it's covered in 'coords'
      } else if (name === 'ddx' || name === 'ddy') {
        args.push(`${name}: ${wgslExprFor(value, call.coordType)}`);
      } else if (name === 'mipLevel') {
        args.push(`${name}: ${wgslExprFor(value, call.levelType!)}`);
      } else if (name === 'arrayIndex') {
        args.push(`${name}: ${wgslExprFor(value, call.arrayIndexType!)}`);
      } else if (name === 'bias') {
        args.push(`${name}: ${wgslExprFor(value, 'f')}`);
      } else if (name === 'sampleIndex') {
        args.push(`${name}: ${wgslExprFor(value, call.sampleIndexType!)}`);
      } else if (name === 'depthRef') {
        args.push(`${name}: ${wgslExprFor(value, 'f')}`);
      } else {
        args.push(`${name}: ${wgslExpr(value)}`);
      }
    }
  }
  return `${call.builtin}(${args.join(', ')})`;
}

const getAspectForTexture = (texture: GPUTexture | GPUExternalTexture): GPUTextureAspect =>
  texture instanceof GPUExternalTexture
    ? 'all'
    : isDepthTextureFormat(texture.format)
    ? 'depth-only'
    : isStencilTextureFormat(texture.format)
    ? 'stencil-only'
    : 'all';

const s_deviceToPipelines = new WeakMap<
  GPUDevice,
  Map<string, GPURenderPipeline | GPUComputePipeline>
>();

/**
 * Given a list of "calls", each one of which has a texture coordinate,
 * generates a fragment shader that uses the instance_index as an index. That
 * index is then used to look up a coordinate from a storage buffer which is
 * used to call the WGSL texture function to read/sample the texture, and then
 * write to a storage buffer. We then read the storage buffer for the per "call"
 * results.
 *
 * We use a 1x1 target and use instance drawing, once instance per call.
 * This allows use to more easily adjust derivatives per call.
 *
 * An issue we ran into before this "one draw call per instance" change;
 * Before we had a single draw call and wrote the result of one call per
 * pixel rendered.
 *
 * Imagine we have code like this:
 *
 * ```
 * @group(0) @binding(0) var T: texture_2d<f32>;
 * @group(0) @binding(1) var S: sampler;
 * @group(0) @binding(2) var<storage> coords: array<vec4f>;
 * @fragment fn fs(@builtin(position) pos: vec4f) -> vec4f {
 *   let ndx = u32(pos.x) * u32(pos.y) * targetWidth;
 *   return textureSample(T, S, coords[ndx].xy);
 * }
 * ```
 *
 * T points to 8x8 pixel texture with 3 mip levels
 * S is 'nearest'
 * coords: is a storage buffer, 16 bytes long [0,0,0,0], one vec4f.
 * our render target is 1x1 pixels
 *
 * Looking above it appears `ndx` will only ever be 0 but that's
 * not what happens. Instead, the GPU will run the fragment shader for
 * a 2x2 area. It does this to compute derivatives by running the code
 * above and looking at what values it gets passed as coords to
 * textureSample. When it does this it ends up with
 *
 * ndx = 0 for invocation 0
 * ndx = 1 for invocation 1
 * ndx = 0 + 1 * targetWidth for invocation 2
 * ndx = 1 + 1 * targetWidth for invocation 3
 *
 * In 3 of those cases `ndx` is out of bounds with respect to `coords`.
 * Out of bounds access is indeterminate. That means the derivatives are
 * indeterminate so what lod it tries to read is indeterminate.
 *
 * By using instance_index for ndx we avoid this issue. ndx is the same
 * on all 4 executions.
 *
 * Calls are "binned" by call parameters. Each bin has its own structure and
 * field in the storage buffer. This allows the calls to be non-homogenous and
 * each have their own data type for coordinates.
 *
 * Note: this function returns:
 *
 * 'results': an array of results, one for each call.
 *
 * 'run': a function that accepts a texture and runs the same class pipeline with
 *        that texture as input, returning an array of results. This can be used by
 *        identifySamplePoints to query the mix-weights used. We do this so we're
 *        using the same shader that generated the original results when querying
 *        the weights.
 *
 * 'destroy': a function that cleans up the buffers used by `run`.
 */
function createTextureCallsRunner<T extends Dimensionality>(
  t: GPUTest,
  {
    format,
    dimension,
    sampleCount,
    depthOrArrayLayers,
  }: {
    format: GPUTextureFormat;
    dimension: GPUTextureDimension;
    sampleCount: number;
    depthOrArrayLayers: number;
  },
  viewDescriptor: GPUTextureViewDescriptor,
  textureType: string,
  sampler: GPUSamplerDescriptor | undefined,
  calls: TextureCall<T>[],
  stage: ShaderStage
) {
  let structs = '';
  let body = '';
  let dataFields = '';
  const data: number[] = [];
  let callCount = 0;
  const binned = binCalls(calls);
  binned.forEach((binCalls, binIdx) => {
    const b = buildBinnedCalls(binCalls.map(callIdx => calls[callIdx]));
    structs += `struct Args${binIdx} {
  ${b.fields.join(',\n  ')}
}
`;
    dataFields += `  args${binIdx} : array<Args${binIdx}, ${binCalls.length}>,
`;
    body += `
  {
    let is_active = (idx >= ${callCount}) & (idx < ${callCount + binCalls.length});
    let args = data.args${binIdx}[idx - ${callCount}];
    let call = ${b.expr};
    result = select(result, call, is_active);
  }
`;
    callCount += binCalls.length;
    data.push(...b.data);
  });

  const dataBuffer = t.createBufferTracked({
    label: 'createTextureCallsRunner:dataBuffer',
    size: data.length * 4,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.UNIFORM,
  });
  t.device.queue.writeBuffer(dataBuffer, 0, new Uint32Array(data));

  const builtin = calls[0].builtin;
  const isCompare = isBuiltinComparison(builtin);

  const { resultType, resultFormat, componentType } = isBuiltinGather(builtin)
    ? getTextureFormatTypeInfo(format)
    : textureType === 'texture_external'
    ? ({ resultType: 'vec4f', resultFormat: 'rgba32float', componentType: 'f32' } as const)
    : textureType.includes('depth')
    ? ({ resultType: 'f32', resultFormat: 'rgba32float', componentType: 'f32' } as const)
    : getTextureFormatTypeInfo(format);
  const returnType = `vec4<${componentType}>`;

  const samplerType = isCompare ? 'sampler_comparison' : 'sampler';

  const renderTarget = t.createTextureTracked({
    format: 'rgba32uint',
    size: [calls.length, 1],
    usage: GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT,
  });

  // derivativeBase is a number that starts at (0, 0, 0) and advances by 1 in x, y
  // for each fragment shader iteration in texel space. It is then converted to normalized
  // texture space by dividing by the textureDimensions.
  // Since it's moving by 1 texel unit we can multiply it to get any specific lod value we want.
  // Because it starts at (0, 0, 0) it will not affect our texture coordinate.
  const derivativeBaseWGSL = `
  let derivativeBase = ${
    isCubeViewDimension(viewDescriptor)
      ? '(v.pos.xyx - 0.5 - vec3f(f32(v.ndx), 0, f32(v.ndx))) / vec3f(vec2f(textureDimensions(T)), 1.0)'
      : dimension === '1d'
      ? 'f32(v.pos.x - 0.5 - f32(v.ndx)) / f32(textureDimensions(T))'
      : dimension === '3d'
      ? 'vec3f(v.pos.xy - 0.5 - vec2f(f32(v.ndx), 0), 0) / vec3f(textureDimensions(T))'
      : '(v.pos.xy - 0.5 - vec2f(f32(v.ndx), 0)) / vec2f(textureDimensions(T))'
  };`;
  const derivativeType =
    isCubeViewDimension(viewDescriptor) || dimension === '3d'
      ? 'vec3f'
      : dimension === '1d'
      ? 'f32'
      : 'vec2f';

  const stageWGSL =
    stage === 'vertex'
      ? `
// --------------------------- vertex stage shaders --------------------------------
@vertex fn vsVertex(
    @builtin(vertex_index) vertex_index : u32,
    @builtin(instance_index) instance_index : u32) -> VOut {
  let positions = array(vec2f(-1, 3), vec2f(3, -1), vec2f(-1, -1));
  return VOut(vec4f(positions[vertex_index], 0, 1),
              instance_index,
              getResult(instance_index, ${derivativeType}(0)));
}

@fragment fn fsVertex(v: VOut) -> @location(0) vec4u {
  return bitcast<vec4u>(v.result);
}
`
      : stage === 'fragment'
      ? `
// --------------------------- fragment stage shaders --------------------------------
@vertex fn vsFragment(
    @builtin(vertex_index) vertex_index : u32,
    @builtin(instance_index) instance_index : u32) -> VOut {
  let positions = array(vec2f(-1, 3), vec2f(3, -1), vec2f(-1, -1));
  return VOut(vec4f(positions[vertex_index], 0, 1), instance_index, ${returnType}(0));
}

@fragment fn fsFragment(v: VOut) -> @location(0) vec4u {
  ${derivativeBaseWGSL}
  return bitcast<vec4u>(getResult(v.ndx, derivativeBase));
}
`
      : `
// --------------------------- compute stage shaders --------------------------------
@group(1) @binding(0) var<storage, read_write> results: array<${returnType}>;

@compute @workgroup_size(1) fn csCompute(@builtin(global_invocation_id) id: vec3u) {
  results[id.x] = getResult(id.x, ${derivativeType}(0));
}
`;

  const code = `
${structs}

struct Data {
${dataFields}
}

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) @interpolate(flat, either) ndx: u32,
  @location(1) @interpolate(flat, either) result: ${returnType},
};

@group(0) @binding(0) var          T    : ${textureType};
${sampler ? `@group(0) @binding(1) var          S    : ${samplerType}` : ''};
@group(0) @binding(2) var<uniform> data : Data;

fn getResult(idx: u32, derivativeBase: ${derivativeType}) -> ${returnType} {
  var result : ${resultType};
${body}
  return ${returnType}(result);
}

${stageWGSL}
`;

  const pipelines =
    s_deviceToPipelines.get(t.device) ?? new Map<string, GPURenderPipeline | GPUComputePipeline>();
  s_deviceToPipelines.set(t.device, pipelines);

  // unfilterable-float textures can only be used with manually created bindGroupLayouts
  // since the default 'auto' layout requires filterable textures/samplers.
  // So, if we don't need filtering, don't request a filtering sampler. If we require
  // filtering then check if the format is 32float format and if float32-filterable
  // is enabled.
  const type = getTextureFormatType(format ?? 'rgba8unorm');
  const isFiltering =
    !!sampler &&
    (sampler.minFilter === 'linear' ||
      sampler.magFilter === 'linear' ||
      sampler.mipmapFilter === 'linear');
  let sampleType: GPUTextureSampleType = textureType.startsWith('texture_depth')
    ? 'depth'
    : isDepthTextureFormat(format)
    ? 'unfilterable-float'
    : isStencilTextureFormat(format)
    ? 'uint'
    : type ?? 'float';
  if (isFiltering && sampleType === 'unfilterable-float') {
    assert(is32Float(format));
    assert(t.device.features.has('float32-filterable'));
    sampleType = 'float';
  }
  if (sampleCount > 1 && sampleType === 'float') {
    sampleType = 'unfilterable-float';
  }

  const visibility =
    stage === 'compute'
      ? GPUShaderStage.COMPUTE
      : stage === 'fragment'
      ? GPUShaderStage.FRAGMENT
      : GPUShaderStage.VERTEX;

  const entries: GPUBindGroupLayoutEntry[] = [
    {
      binding: 2,
      visibility,
      buffer: {
        type: 'uniform',
      },
    },
  ];

  const viewDimension = effectiveViewDimensionForDimension(
    viewDescriptor.dimension,
    dimension,
    depthOrArrayLayers
  );

  if (textureType.includes('storage')) {
    entries.push({
      binding: 0,
      visibility,
      storageTexture: {
        access: 'read-only',
        viewDimension,
        format,
      },
    });
  } else if (textureType === 'texture_external') {
    entries.push({
      binding: 0,
      visibility,
      externalTexture: {},
    });
  } else {
    entries.push({
      binding: 0,
      visibility,
      texture: {
        sampleType,
        viewDimension,
        multisampled: sampleCount > 1,
      },
    });
  }

  if (sampler) {
    const type = isCompare ? 'comparison' : isFiltering ? 'filtering' : 'non-filtering';
    entries.push({
      binding: 1,
      visibility,
      sampler: { type },
    });
  }

  const id = `${resultType}:${stage}:${JSON.stringify(entries)}:${code}`;
  let pipeline = pipelines.get(id);
  if (!pipeline) {
    const module = t.device.createShaderModule({ code });
    const bindGroupLayout0 = t.device.createBindGroupLayout({ entries });
    const bindGroupLayouts = [bindGroupLayout0];

    if (stage === 'compute') {
      const bindGroupLayout1 = t.device.createBindGroupLayout({
        entries: [
          {
            binding: 0,
            visibility: GPUShaderStage.COMPUTE,
            buffer: {
              type: 'storage',
            },
          },
        ],
      });
      bindGroupLayouts.push(bindGroupLayout1);
    }

    const layout = t.device.createPipelineLayout({
      bindGroupLayouts,
    });

    switch (stage) {
      case 'compute':
        pipeline = t.device.createComputePipeline({
          layout,
          compute: { module },
        });
        break;
      case 'fragment':
      case 'vertex':
        pipeline = t.device.createRenderPipeline({
          layout,
          vertex: { module },
          fragment: {
            module,
            targets: [{ format: 'rgba32uint' }],
          },
        });
        break;
    }
    pipelines.set(id, pipeline);
  }

  const gpuSampler = sampler ? t.device.createSampler(sampler) : undefined;

  const run = async (gpuTexture: GPUTexture | GPUExternalTexture) => {
    const resultBuffer = t.createBufferTracked({
      label: 'createTextureCallsRunner:resultBuffer',
      size: align(calls.length * 16, 256),
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    const aspect = getAspectForTexture(gpuTexture);
    const runViewDescriptor = {
      ...viewDescriptor,
      aspect,
    };

    const bindGroup0 = t.device.createBindGroup({
      layout: pipeline!.getBindGroupLayout(0),
      entries: [
        {
          binding: 0,
          resource:
            gpuTexture instanceof GPUExternalTexture
              ? gpuTexture
              : gpuTexture.createView(runViewDescriptor),
        },
        ...(sampler ? [{ binding: 1, resource: gpuSampler! }] : []),
        { binding: 2, resource: { buffer: dataBuffer } },
      ],
    });

    let storageBuffer: GPUBuffer | undefined;
    const encoder = t.device.createCommandEncoder({ label: 'createTextureCallsRunner' });

    if (stage === 'compute') {
      storageBuffer = t.createBufferTracked({
        label: 'createTextureCallsRunner:storageBuffer',
        size: resultBuffer.size,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      });

      const bindGroup1 = t.device.createBindGroup({
        layout: pipeline!.getBindGroupLayout(1),
        entries: [{ binding: 0, resource: { buffer: storageBuffer } }],
      });

      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline! as GPUComputePipeline);
      pass.setBindGroup(0, bindGroup0);
      pass.setBindGroup(1, bindGroup1);
      pass.dispatchWorkgroups(calls.length);
      pass.end();
      encoder.copyBufferToBuffer(storageBuffer, 0, resultBuffer, 0, storageBuffer.size);
    } else {
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: renderTarget.createView(),
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
      });

      pass.setPipeline(pipeline! as GPURenderPipeline);
      pass.setBindGroup(0, bindGroup0);
      for (let i = 0; i < calls.length; ++i) {
        pass.setViewport(i, 0, 1, 1, 0, 1);
        pass.draw(3, 1, 0, i);
      }
      pass.end();
      encoder.copyTextureToBuffer(
        { texture: renderTarget },
        {
          buffer: resultBuffer,
          bytesPerRow: resultBuffer.size,
        },
        [renderTarget.width, 1]
      );
    }
    t.device.queue.submit([encoder.finish()]);

    await resultBuffer.mapAsync(GPUMapMode.READ);

    const view = TexelView.fromTextureDataByReference(
      resultFormat,
      new Uint8Array(resultBuffer.getMappedRange()),
      {
        bytesPerRow: calls.length * 16,
        rowsPerImage: 1,
        subrectOrigin: [0, 0, 0],
        subrectSize: [calls.length, 1],
      }
    );

    let outIdx = 0;
    const out = new Array<PerTexelComponent<number>>(calls.length);
    for (const bin of binned) {
      for (const callIdx of bin) {
        const x = outIdx;
        out[callIdx] = view.color({ x, y: 0, z: 0 });
        outIdx++;
      }
    }

    storageBuffer?.destroy();
    resultBuffer.destroy();

    return out;
  };

  return {
    run,
    destroy() {
      dataBuffer.destroy();
      renderTarget.destroy();
    },
  };
}

export async function doTextureCalls<T extends Dimensionality>(
  t: GPUTest,
  gpuTexture: GPUTexture | GPUExternalTexture,
  viewDescriptor: GPUTextureViewDescriptor,
  textureType: string,
  sampler: GPUSamplerDescriptor | undefined,
  calls: TextureCall<T>[],
  shortShaderStage: ShortShaderStage
) {
  const stage = kShortShaderStageToShaderStage[shortShaderStage];
  const runner = createTextureCallsRunner(
    t,
    gpuTexture instanceof GPUExternalTexture
      ? { format: 'rgba8unorm', dimension: '2d', depthOrArrayLayers: 1, sampleCount: 1 }
      : gpuTexture,
    viewDescriptor,
    textureType,
    sampler,
    calls,
    stage
  );
  const results = await runner.run(gpuTexture);

  return {
    runner,
    results,
  };
}
