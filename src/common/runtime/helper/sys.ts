/* eslint-disable no-process-exit, n/no-process-exit */
/* eslint-disable @typescript-eslint/no-namespace */

function node() {
  /* eslint-disable-next-line n/no-restricted-require */
  const { readFile, existsSync } = require('fs/promises');

  return {
    type: 'node',
    readFile,
    existsSync,
    args: process.argv.slice(2),
    cwd: () => process.cwd(),
    exit: (code?: number | undefined) => process.exit(code),
    import: async (id: string) => require(id),
  };
}

declare global {
  namespace Deno {
    function readFile(
      path: string,
      callback?: (error: unknown, data: string) => void
    ): Promise<Uint8Array>;
    function readFileSync(path: string): Uint8Array;
    const args: string[];
    const cwd: () => string;
    function exit(code?: number): never;
  }
}

function deno() {
  function existsSync(path: string) {
    try {
      Deno.readFileSync(path);
      return true;
    } catch (err) {
      return false;
    }
  }

  return {
    type: 'deno',
    existsSync,
    readFile: Deno.readFile,
    args: Deno.args,
    cwd: Deno.cwd,
    exit: Deno.exit,
    import: (id: string) => import(id),
  };
}

const sys = globalThis.Deno ? deno() : node();

export default sys;
