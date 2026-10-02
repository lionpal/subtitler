// Errors from the services subtitle.lol calls, and retrying the ones that are temporary.

const MAX_ATTEMPTS = 5;

export class ApiError extends Error {
  service: string; // "ElevenLabs", "Gemini"
  status: number;
  canRetry: boolean;
  isKeyProblem: boolean;
  retryAfterSeconds: number | null;

  constructor(service: string, message: string, status: number, retryAfterSeconds: number | null = null) {
    super(`${service} ${status}: ${message}`);
    this.service = service;
    this.status = status;
    // 429 = too many requests at once, 5xx = their side. Anything else will fail again.
    this.canRetry = status === 429 || status >= 500;
    // 401 and 403 mean a wrong or disabled key; a key of the wrong length gets a 400 that says so.
    this.isKeyProblem = status === 401 || status === 403 || (status === 400 && /api key/i.test(message));
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

// Builds an ApiError from a failed response, using the message in its body when there is one.
export async function errorFromResponse(service: string, response: Response): Promise<ApiError> {
  const body = await response.text();
  const retryAfter = Number(response.headers.get("retry-after")) || null;
  return new ApiError(service, describeErrorBody(body), response.status, retryAfter);
}

// Calls `send` until it succeeds, waiting longer each time, when the failure is temporary.
export async function withRetries<T>(send: () => Promise<T>, onRetry?: (message: string) => void): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await send();
    } catch (error) {
      // A network error (no status at all) is worth retrying too.
      const canRetry = error instanceof ApiError ? error.canRetry : true;
      if (!canRetry || attempt === MAX_ATTEMPTS) throw error;

      const suggested = error instanceof ApiError ? error.retryAfterSeconds : null;
      const waitSeconds = suggested ?? 5 * 2 ** (attempt - 1); // 5s, 10s, 20s, 40s
      onRetry?.(`${errorMessage(error)}; retrying in ${waitSeconds}s (attempt ${attempt + 1} of ${MAX_ATTEMPTS})`);
      await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
    }
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Error bodies are usually JSON such as {"detail": {"message": "..."}} or {"error": {"message": "..."}}.
function describeErrorBody(body: string): string {
  try {
    const parsed = JSON.parse(body);
    const detail = parsed.detail ?? parsed.error;
    if (typeof detail === "string") return detail;
    if (detail?.message) return detail.message;
  } catch {
    // Not JSON; fall through and show the raw text.
  }
  return body.slice(0, 300) || "(empty response)";
}
