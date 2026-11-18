export class CLIError extends Error {
  readonly kind: string;
  readonly nextAction: string;
  readonly exitCode: number;
  constructor(kind: string, message: string, nextAction: string, exitCode = 1) {
    super(message);
    this.kind = kind;
    this.nextAction = nextAction;
    this.exitCode = exitCode;
  }
}
