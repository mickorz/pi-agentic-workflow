/** E2E 共享常量（config 与 spec 双端 import；不含可变状态） */
export const TOKEN = "pw-e2e-fixed-token";
export const MOCK_API_PORT = 4671;
export const REAL_API_PORT = 4673;

export function apiBase(real: boolean): string {
  return `http://127.0.0.1:${real ? REAL_API_PORT : MOCK_API_PORT}`;
}
