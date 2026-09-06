/**
 * Application-level error with an HTTP status and a stable machine code.
 * Thrown from routes/plugins and translated to a response by errorHandler.js.
 */
export class AppError extends Error {
  /**
   * @param {number} statusCode HTTP status
   * @param {string} message human-readable, safe to return to the client
   * @param {string} code stable machine-readable code (SCREAMING_SNAKE_CASE)
   */
  constructor(statusCode, message, code = 'APP_ERROR') {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.isAppError = true;
  }
}

export default AppError;
