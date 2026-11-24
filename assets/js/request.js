// GET idempotentes: recuperación acotada, sin recargar la página.
export class RequestError extends Error {
  constructor(message, retryable = false) {
    super(message);
    this.name = "RequestError";
    this.retryable = retryable;
  }
}

export async function fetchText(url, { timeout = 8000, attempts = 3, onRetry = () => {} } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new RequestError("Tiempo de espera agotado", true));
        controller.abort();
      }, timeout);
    });
    try {
      return await Promise.race([
        (async () => {
          const response = await fetch(url, { cache: "no-cache", signal: controller.signal });
          if (!response.ok) throw new RequestError(`HTTP ${response.status}`, response.status === 408 || response.status === 429 || response.status >= 500);
          return response.text();
        })(),
        deadline,
      ]);
    } catch (error) {
      if (attempt === attempts || !(error instanceof TypeError || error.retryable)) throw error;
      clearTimeout(timer);
      onRetry(attempt + 1);
      await new Promise((resolve) => setTimeout(resolve, attempt === 1 ? 500 : 1500));
    } finally {
      clearTimeout(timer);
    }
  }
}
