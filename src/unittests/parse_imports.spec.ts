export const description = `
Test for "parseImports" utility.
`;

import { makeTestGroup } from '../common/framework/test_group.ts';
import { parseImports } from '../common/util/parse_imports.ts';

import { UnitTest } from './unit_test.ts';

class F extends UnitTest {
  test(content: string, expect: string[]): void {
    const got = parseImports('a/b/c.ts', content);
    const expectJoined = expect.join('\n');
    const gotJoined = got.join('\n');
    this.expect(
      expectJoined === gotJoined,
      `
expected: ${expectJoined}
got:      ${gotJoined}`
    );
  }
}

export const g = makeTestGroup(F);

g.test('empty').fn(t => {
  t.test(``, []);
  t.test(`\n`, []);
  t.test(`\n\n`, []);
});

g.test('simple').fn(t => {
  t.test(`import 'x/y/z.ts';`, ['a/b/x/y/z.ts']);
  t.test(`import * as blah from 'x/y/z.ts';`, ['a/b/x/y/z.ts']);
  t.test(`import { blah } from 'x/y/z.ts';`, ['a/b/x/y/z.ts']);
});

g.test('multiple').fn(t => {
  t.test(
    `
blah blah blah
import 'x/y/z.ts';
more blah
import * as blah from 'm/n/o.ts';
extra blah
import { blah } from '../h.ts';
ending with blah
`,
    ['a/b/x/y/z.ts', 'a/b/m/n/o.ts', 'a/h.ts']
  );
});

g.test('multiline').fn(t => {
  t.test(
    `import {
  blah
} from 'x/y/z.ts';`,
    ['a/b/x/y/z.ts']
  );
  t.test(
    `import {
  blahA,
  blahB,
} from 'x/y/z.ts';`,
    ['a/b/x/y/z.ts']
  );
});

g.test('file_characters').fn(t => {
  t.test(`import '01234_56789.ts';`, ['a/b/01234_56789.ts']);
});

g.test('relative_paths').fn(t => {
  t.test(`import '../x.ts';`, ['a/x.ts']);
  t.test(`import '../x/y.ts';`, ['a/x/y.ts']);
  t.test(`import '../../x.ts';`, ['x.ts']);
  t.test(`import '../../../x.ts';`, ['../x.ts']);
  t.test(`import '../../../../x.ts';`, ['../../x.ts']);
});
