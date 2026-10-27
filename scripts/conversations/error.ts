export class ConversationError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 413 | 503,
    message: string,
  ) {
    super(message);
  }
}
