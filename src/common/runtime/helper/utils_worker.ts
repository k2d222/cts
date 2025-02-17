import { globalTestConfig } from '../../framework/test_config';
import { Logger } from '../../internal/logging/logger';
import { TestQueryWithExpectation } from '../../internal/query/query';
import { setDefaultRequestAdapterOptions } from '../../util/navigator_gpu';

import { CTSOptions } from './options';

export interface WorkerTestRunRequest {
  query: string;
  expectations: TestQueryWithExpectation[];
  ctsOptions: CTSOptions;
}

/**
 * Set config environment for workers with ctsOptions and return a Logger.
 */
export function setupWorkerEnvironment(ctsOptions: CTSOptions): Logger {
  const { powerPreference, compatibility } = ctsOptions;
  globalTestConfig.enableDebugLogs = ctsOptions.debug;
  globalTestConfig.unrollConstEvalLoops = ctsOptions.unrollConstEvalLoops;
  globalTestConfig.compatibility = compatibility;
  globalTestConfig.enforceDefaultLimits = ctsOptions.enforceDefaultLimits;
  globalTestConfig.logToWebSocket = ctsOptions.logToWebSocket;

  const log = new Logger();

  if (powerPreference || compatibility) {
    setDefaultRequestAdapterOptions({
      ...(powerPreference && { powerPreference }),
      // MAINTENANCE_TODO: remove compatibilityMode once no longer needed.
      ...(compatibility && { compatibilityMode: true, featureLevel: 'compatibility' }),
    });
  }

  return log;
}
