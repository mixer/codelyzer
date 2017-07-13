import { assertSuccess, assertAnnotated, lint } from './testHelper';
import { expect } from 'chai';

describe('templates-require-inputs', () => {
  describe('tagged option', () => {
    it('passes when required inputs are provided', () => {
      let source = `
        @Component({
          selector: 'foobar',
          template: '<foobar [foo]="42"></foobar>'
        })
        class Test {
          @Input()
          public foo: number; // @required
          constructor(private foo: number) {}
        }
      `;

      assertSuccess('templates-require-inputs', source, ['tagged']);
    });

    [
      {
        name: 'parses block comments before @Input',
        code: `
          /** @required */
          @Input()
          ~~~~~~~~
          public foo: number;
        `,
        fails: true,
      },
      {
        name: 'parses block comments after @Input()',
        code: `
          @Input()
          ~~~~~~~~
          /** @required */
          public foo: number;
        `,
        fails: true,
      },
      {
        name: 'parses line comments',
        code: `
          @Input()
          ~~~~~~~~
          public foo: number; // @required
        `,
        fails: true,
      },
      {
        name: 'passes when members are not required',
        code: `
          @Input()
          public foo: number;
        `,
        fails: false,
      },
    ].forEach(testcase => {
      it(testcase.name, () => {
        let source = `
          @Component({
            selector: 'foobar',
            template: '<foobar></foobar>'
          })
          class Test {
            ${testcase.code}
            constructor(private foo: number) {}
          }
        `;

        if (testcase.fails) {
          assertAnnotated({
            ruleName: 'templates-require-inputs',
            message: 'Component <foobar> is missing required input `foo` (used in file.ts:0)',
            options: ['tagged'],
            source
          });
        } else {
          assertSuccess('templates-require-inputs', source, ['tagged']);
        }
      });
    });
  });

  describe('complex expression evaluation', () => {
    it('passes when expressions pass', () => {
      let source = `
        @Component({
          selector: 'foobar',
          template: '<foobar [foo]="42"></foobar>'
        })
        class Test {
          @Input()
          public foo: number;

          @Input()
          public bar: number; // @required if !foo

          constructor(private foo: number) {}
        }
      `;

      assertSuccess('templates-require-inputs', source, ['tagged']);
    });

    it('fails when expressions fail', () => {
      let source = `
        @Component({
          selector: 'foobar',
          template: '<foobar></foobar>'
        })
        class Test {
          @Input()
          public foo: number;

          @Input()
          ~~~~~~~~
          public bar: number; // @required if !foo

          constructor(private foo: number) {}
        }
      `;

      assertAnnotated({
        ruleName: 'templates-require-inputs',
        message: 'Component <foobar> is missing input `bar` required when `!foo` (used in file.ts:0)',
        options: ['tagged'],
        source
      });
    });
  });

  describe('all-without-defaults option', () => {
    it('does not require input if a default value is provided', () => {
      let source = `
        @Component({
          selector: 'foobar',
          template: '<foobar></foobar>'
        })
        class Test {
          @Input()
          public foo: number = 42;

          constructor(private foo: number) {}
        }
      `;

      assertSuccess('templates-require-inputs', source, ['all-without-defaults']);
    });

    it('requires input if a default is not provided', () => {
      let source = `
        @Component({
          selector: 'foobar',
          template: '<foobar></foobar>'
        })
        class Test {
          @Input()
          ~~~~~~~~
          public foo: number;

          constructor(private foo: number) {}
        }
      `;

      assertAnnotated({
        ruleName: 'templates-require-inputs',
        message: 'Component <foobar> is missing required input `foo` (used in file.ts:0)',
        options: ['all-without-defaults'],
        source
      });
    });
  });

  it('uses renamed inputs in failure messages when applicable', () => {
    let source = `
      @Component({
        selector: 'foobar',
        template: '<foobar></foobar>'
      })
      class Test {
        @Input('renamed-input')
        ~~~~~~~~~~~~~~~~~~~~~~~
        public foo: number;

        constructor(private foo: number) {}
      }
    `;

    assertAnnotated({
      ruleName: 'templates-require-inputs',
      message: 'Component <foobar> is missing required input `renamed-input` (used in file.ts:0)',
      options: ['all-without-defaults'],
      source
    });
  });
});
