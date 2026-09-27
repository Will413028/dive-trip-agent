export class DomainError extends Error {
  readonly code: string;

  constructor(code: string, message = code) {
    super(message);
    this.code = code;
  }
}
