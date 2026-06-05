export class GitMcpError extends Error {
  codeName: string;
  details: Record<string, unknown>;

  constructor(codeName: string, message: string = codeName, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'GitMcpError';
    this.codeName = codeName;
    this.details = details;
  }
}

export function diagnosticError(codeName: string, message: string = codeName, details: Record<string, unknown> = {}): GitMcpError {
  return new GitMcpError(codeName, message, details);
}
