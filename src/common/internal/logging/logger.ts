import { globalTestConfig } from '../../framework/test_config.ts';
import { version } from '../version.ts';

import { LiveTestCaseResult } from './result.ts';
import { TestCaseRecorder } from './test_case_recorder.ts';

export type LogResults = Map<string, LiveTestCaseResult>;

export class Logger {
  readonly overriddenDebugMode: boolean | undefined;
  readonly results: LogResults = new Map();

  constructor({ overrideDebugMode }: { overrideDebugMode?: boolean } = {}) {
    this.overriddenDebugMode = overrideDebugMode;
  }

  record(name: string): [TestCaseRecorder, LiveTestCaseResult] {
    const result: LiveTestCaseResult = { status: 'running', timems: -1 };
    this.results.set(name, result);
    return [
      new TestCaseRecorder(result, this.overriddenDebugMode ?? globalTestConfig.enableDebugLogs),
      result,
    ];
  }

  asJSON(space?: number): string {
    return JSON.stringify({ version, results: Array.from(this.results) }, undefined, space);
  }
}
