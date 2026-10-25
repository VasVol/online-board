const keys = new Map<string, string>();
export function boardKey(id: string) {
  if (!keys.has(id)) {
    const key =
      new URLSearchParams(location.hash.slice(1)).get('key') ||
      sessionStorage.getItem(`pole-key:${id}`) ||
      '';
    keys.set(id, key);
    if (key) sessionStorage.setItem(`pole-key:${id}`, key);
  }
  return keys.get(id) || '';
}
export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const id = path.match(/^\/boards\/([\w-]+)/)?.[1];
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(id && boardKey(id) ? { Authorization: `Bearer ${boardKey(id)}` } : {}),
      ...init.headers,
    },
  });
  const body = await response.json().catch(() => ({ error: 'Сервер вернул некорректный ответ' }));
  if (!response.ok) throw new Error(body.error || `Ошибка ${response.status}`);
  return body;
}
export const json = (method: string, data?: unknown): RequestInit => ({
  method,
  body: data === undefined ? undefined : JSON.stringify(data),
});
export function download(name: string, content: Blob | string, type = 'application/json') {
  const url = URL.createObjectURL(
    typeof content === 'string' ? new Blob([content], { type }) : content,
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
