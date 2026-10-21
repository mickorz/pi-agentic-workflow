/**
 * Token 存取：Server 启动时打印 token，用户粘贴到工作台后存 localStorage。
 * 不放 query string（Server 也不接受 query token）。
 */
const TOKEN_KEY = "pi-workflow-web.token";

export function getToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string): void {
  try {
    window.localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // 隐私模式等场景忽略
  }
}

export function clearToken(): void {
  try {
    window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    // ignore
  }
}
