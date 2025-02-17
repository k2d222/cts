import { globalTestConfig } from '../../framework/test_config';
import { version } from '../version';

import { LiveTestCaseResult } from './result';
import { TestCaseRecorder } from './test_case_recorder';

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
