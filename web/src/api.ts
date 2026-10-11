export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function parse(res: Response): Promise<unknown> {
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // plain text body
  }
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    if (body && typeof body === 'object') {
      const o = body as Record<string, unknown>;
      if (typeof o.error === 'string') msg = o.error;
      else if (typeof o.message === 'string') msg = o.message;
    } else if (typeof body === 'string' && body.trim()) {
      msg = body.slice(0, 200);
    }
    if (res.status === 404 && msg.startsWith('404')) msg = `Not available yet: ${new URL(res.url).pathname}`;
    throw new ApiError(res.status, msg);
  }
  return body;
}

export async function get<T = unknown>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { accept: 'application/json' } });
  return (await parse(res)) as T;
}

export async function post<T = unknown>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: body === undefined ? '{}' : JSON.stringify(body),
  });
  return (await parse(res)) as T;
}

export function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
