import type { ActiveStepState, CompletionResult, StepResult } from '../types.js';

export class ActiveStep {
  state: ActiveStepState = 'FRAMING';
  completionResult?: CompletionResult;
  readonly startedAt = new Date().toISOString();
  timedOut = false;
  constructor(readonly operationId: string, readonly completionToken: string) {}
  complete(result: CompletionResult) {
    if (!['CANCELLED', 'EXITED', 'FAILED', 'COMPLETED'].includes(this.state)) {
      this.completionResult = result;
      this.state = 'COMPLETED';
    }
  }
}

export interface PendingStepWaiter {
  resolve(value: StepResult): void;
  timer: ReturnType<typeof setTimeout>;
}
