export class AutomationExecutionError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "AutomationExecutionError";
  }
}
