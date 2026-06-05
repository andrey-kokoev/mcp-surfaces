export class WorkerMcpError extends Error {
  codeName: string;
  details: Record<string, unknown>;

  constructor(codeName: string, message: string = codeName, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'WorkerMcpError';
    this.codeName = codeName;
    this.details = details;
  }
}

export function diagnosticError(codeName: string, message: string = codeName, details: Record<string, unknown> = {}): WorkerMcpError {
  return new WorkerMcpError(codeName, message, details);
}
