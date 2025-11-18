export class GeminiError extends Error {
  metadata: any;

  constructor(message: string, metadata: any = {}) {
    super(message);
    this.name = 'GeminiError';
    this.metadata = metadata;
    Object.setPrototypeOf(this, GeminiError.prototype);
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, GeminiError);
    }
  }
}

export class GeminiJsonError extends GeminiError {
  constructor(message: string, metadata: any = {}) {
    super(message, metadata);
    this.name = 'GeminiJsonError';
    Object.setPrototypeOf(this, GeminiJsonError.prototype);
  }
}

export class GeminiApiError extends GeminiError {
  constructor(message: string, metadata: any = {}) {
    super(message, metadata);
    this.name = 'GeminiApiError';
    Object.setPrototypeOf(this, GeminiApiError.prototype);
  }
}
