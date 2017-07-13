import * as Lint from 'tslint';
import * as ts from 'typescript';
import { NgWalker } from './angular/ngWalker';
import { ComponentMetadata } from './angular/metadata';
import { ParseSourceSpan } from './angular/styles/parseUtil';
import { BasicTemplateAstVisitor } from './angular/templates/basicTemplateAstVisitor';
import * as e from '@angular/compiler/src/expression_parser/ast';
import * as ast from '@angular/compiler';

const unstrictEqualityOperator = '==';

interface IElementTracker {
  fileName: string;
  element: ast.ElementAst,
  properties: string[];
}

interface IComponent {
  properties: string[];
  checks: ((args: boolean[]) => IFailure | null)[];
}

interface IFailure {
  inputName: string;
  decorator: ts.Decorator;
  message: string;
}

const enum Mode {
  Tagged,
  All,
}

function getMode(options: any[]): Mode {
  return options[0] === 'all-without-defaults' ? Mode.All : Mode.Tagged;
}

class ComponentTracker {
  private elementQueue: IElementTracker[] = [];
  private component: IComponent;

  /**
   * Adds the element to be processed.
   */
  public addElement(fileName: string, element: ast.ElementAst): IFailure[] {
    const record = {
      fileName,
      element,
      properties: (<{ name: string }[]> element.inputs)
        .concat(element.attrs)
        .map(i => i.name),
    };

    if (this.component) {
      return this.process(record, true);
    }

    this.elementQueue.push(record);
  }

  /**
   * Adds the component to be processed. Returns the ts.Node of the decorator
   * declarations that caused linting to fail upon error.
   */
  public addComponent(component: IComponent): IFailure[] {
    this.component = component;

    const queue = this.elementQueue;
    this.elementQueue = [];

    return queue
      .map(item => this.process(item, false))
      .reduce((acc, item) => acc.concat(item), []);
  }

  private process(tracker: IElementTracker, fromElement: boolean): IFailure[] {
    const args = [];
    this.component.properties.forEach(property => {
      args.push(tracker.properties.indexOf(property) > -1);
    });

    return this.component.checks
      .map(check => {
        const result = check(args);
        if (!result) {
          return null;
        }

        result.message = `Component <${tracker.element.name}> ${result.message}`
        result.message += fromElement
          ? ` (declared in ${result.decorator.getSourceFile().fileName}:${result.decorator.pos})`
          : ` (used in ${tracker.fileName}:${tracker.element.sourceSpan.start.line})`;
        return result;
      })
      .filter(Boolean);
  }
}

/**
 * an (incomplete) list of elements to not bother tracking, for performance.
 */
const skippedElements = [
  // basic HTML tags:
  'div', 'a', 'p', 'span', 'em', 'strong', 'i', 'b', 'ul', 'li', 'ol', 'header',
  'footer', 'nav', 'main', 'aside', 'footer', 'br', 'img', 'table', 'thead',
  'tbody', 'td', 'th', 'tr',
  // built-in Angular elements:
  /^ng\-.+/,
];

/**
 * Tracks tag decalarations and properties on those declarations. Once we get
 * a declaration for the component, we check to make sure that all inputs are
 * correct.
 *
 * This definitely isn't the most optimal or pretty approach, but this seems
 * to be the only viable way in tslint and is plenty fast. My ideal scenario
 * would be parsing all components first, then looking at templates, but tslint
 * doesn't provide the tools we need to do this unless `--type-check` is used,
 * which not everyone uses or would like to use.
 */
class TemplateRequireInputTracker {
  private readonly tags: { [name: string]: ComponentTracker } = Object.create(null);

  public addElement(fileName: string, element: ast.ElementAst): IFailure[] {
    if (skippedElements.indexOf(element.name) > -1) {
      return null;
    }
    if (skippedElements.some(s => s instanceof RegExp && s.test(element.name))) {
      return null;
    }

    return this.getByName(element.name).addElement(fileName, element);
  }

  public addComponent(name: string, options: IComponent): IFailure[] {
    return this.getByName(name).addComponent(options);
  }

  private getByName(name: string) {
    if (!this.tags[name]) {
      this.tags[name] = new ComponentTracker();
    }

    return this.tags[name];
  }
}

function createTemplateWalker(tracker: TemplateRequireInputTracker) {
  return class TemplateRequireInputsVisitor extends BasicTemplateAstVisitor {
    visitElement(element: ast.ElementAst, context: any): any {
      tracker
        .addElement(this.getSourceFile().fileName, element)
        .forEach(failure => {
          this.addFailure(this.createFailure(
            element.sourceSpan.start.offset,
            element.sourceSpan.end.offset - element.sourceSpan.start.offset,
            failure.message,
          ));
        });

      return super.visitElement(element, context);
    }
  }
}

const requiredExpressionRe = /@required\s+if\s+(.*?)(\*?\*\/|\n|$)/;

interface IPendingInput {
  name: string;
  alias: string;
  required: boolean;
  node: ts.Decorator;
  match?: string;
}

class InputMetadataWalker extends NgWalker {
  private tracker: TemplateRequireInputTracker;

  private componentName: string;
  private inputs: IPendingInput[] = [];

  public attachTracker(tracker: TemplateRequireInputTracker) {
    this.tracker = tracker;
  }

  public visitClassDeclaration(declaration: ts.ClassDeclaration) {
    this.pushLast();
    return super.visitClassDeclaration(declaration);
  }

  protected visitNgComponent(metadata: ComponentMetadata) {
    this.componentName = metadata.selector;
    return super.visitNgComponent(metadata);
  }

  public visitEndOfFileToken(node: ts.Node) {
    this.pushLast();
  }

  public visitNgInput(property: ts.PropertyDeclaration, input: ts.Decorator, args: string[]) {
    // Read the text around the decorator. We can't simply use property.getText()
    // since we want to read line comments after the end of the block.
    const sourceText = this.getSourceFile().text;
    const start = property.pos;
    const end = property.end + sourceText.slice(property.end).indexOf('\n'); // read to EOL

    const decoratorText = sourceText.slice(start, end);
    const requiredExpr = requiredExpressionRe.exec(decoratorText);

    const decoratorArgs = (<ts.CallExpression> input.expression).arguments;
    const inputAlias = decoratorArgs.length > 0 && decoratorArgs[0].kind === ts.SyntaxKind.StringLiteral
      ? (<ts.StringLiteral> decoratorArgs[0]).text
      : property.name.getText();

    let required = decoratorText.includes('@required');
    if (decoratorText.includes('@required')) {
      required = true;
    } else if (getMode(this.getOptions()) === Mode.All) {
      required = property.initializer === undefined;
    }

    this.inputs.push({
      node: input,
      alias: inputAlias,
      name: property.name.getText(),
      match: requiredExpr && requiredExpr[1],
      required,
    });
  }

  private pushLast() {
    if (this.inputs.length === 0) {
      return;
    }

    const properties = this.inputs.map(i => i.name);
    const errs = this.tracker.addComponent(this.componentName, {
      properties,
      checks: this.inputs
        .map((input, i) => {
          if (!input.required) {
            return () => null;
          }

          const checker = input.match
            ? this.createCustomMatch(properties, input)
            : this.createDefaultMatch(properties, input);

          return (args: boolean[]) => {
            const errMessage = checker(args);
            if (!errMessage) {
              return null;
            }

            return {
              inputName: input.name,
              decorator: input.node,
              message: errMessage,
            };
          };
        }),
    });

    errs.forEach(err => {
      this.addFailureAtNode(
        err.decorator,
        err.message
      );
    });

    this.inputs = [];
  }

  private createDefaultMatch(properties: string[], input: IPendingInput): (args: boolean[]) => string | null {
    const i = properties.indexOf(input.name);
    return args => {
      if (!args[i]) {
        return `is missing required input \`${input.alias}\``;
      }

      return null;
    };
  }
  private createCustomMatch(properties: string[], input: IPendingInput): (args: boolean[]) => string | null {
    const tryExec = <T>(fn: () => T) => {
      try {
        return fn();
      } catch (err) {
        throw new Error(
          `Could not evaluate @required directive on ${this.componentName}.${input.name}` +
          ` \`${input.match}\`: ${err.message}`
        );
      }
    };

    const fn = tryExec(() => new Function(...properties, `return ${input.match}`));
    return args => {
      if (tryExec(() => fn(...args))) {
        return `is missing input \`${input.alias}\` required when \`${input.match}\``;
      }

      return null;
    };
  }
}


export class Rule extends Lint.Rules.AbstractRule {
  public static metadata: Lint.IRuleMetadata = {
    ruleName: 'templates-require-inputs',
    type: 'functionality',
    description: `Ensures that required inputs are provided to templates.`,
    descriptionDetails: `If used in "tagged" mode, only inputs that have "@required"` +
      ` in their docstring will be marked as required. If "all-without-defaults", properties` +
      ` without default values must be fullfilled, though @require can override this.\n\n` +
      `You can pass expressions to @required, like \`@required if !other_property\`, where` +
      ` other properties are made available as variables and set to \`true\` if they're set.`,
    rationale: `Angular has no way to statically determine required component inputs; this rule creates one.`,
    options: {
      type: 'array',
      items: [
        {
          enum: ['tagged', 'all-without-defaults']
        }
      ]
    },
    optionExamples: [
      `"tagged"`,
      `"all-without-defaults"`
    ],
    optionsDescription: `See the description details for more information`,
    typescriptOnly: true,
  };

  private tracker = new TemplateRequireInputTracker();
  private templateWalker = createTemplateWalker(this.tracker);

  public apply(sourceFile: ts.SourceFile): Lint.RuleFailure[] {
    const walker = new InputMetadataWalker(
      sourceFile,
      this.getOptions(),
      { templateVisitorCtrl: this.templateWalker }
    );

    walker.attachTracker(this.tracker);

    return this.applyWithWalker(walker);
  }
}
