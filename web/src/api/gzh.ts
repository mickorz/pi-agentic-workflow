/**
 * GZH 排版工作台 API(T0.3):文章列表/加载/保存。
 * 契约见 src/server/gzh-routes.ts;token 复用全局 auth(仅 Authorization 头)。
 */
import { ApiRequestError } from "./client";
import { getToken } from "./auth";

export interface GzhArticleListItem {
  dir: string;
  title: string;
  mtime: number;
  style: string;
  drafted: boolean;
}

export interface GzhArticle {
  dir: string;
  mdName: string;
  markdown: string;
  mdHash: string;
  style: string;
  styleHash: string;
  yaml: { title: string; digest: string; author: string };
  images: Array<{ name: string; url: string }>;
}

export interface GzhSaveResult {
  dir: string;
  saved: string[];
  mdHash?: string;
  styleHash?: string;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { Authorization: `Bearer ${getToken() ?? ""}` } });
  return handle<T>(res);
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${getToken() ?? ""}` },
    body: JSON.stringify(body),
  });
  return handle<T>(res);
}

async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let payload: { code?: string; message?: string } = {};
    try {
      payload = (await res.json()) as { code?: string; message?: string };
    } catch {
      /* 非 JSON 错误体 */
    }
    throw new ApiRequestError(
      { code: (payload.code ?? "INTERNAL_ERROR") as never, message: payload.message ?? res.statusText, requestId: "-" },
      res.status,
    );
  }
  return (await res.json()) as T;
}

export const gzhApi = {
  listArticles: () => get<{ articles: GzhArticleListItem[] }>("/api/gzh/articles"),
  loadArticle: (dir: string) => get<GzhArticle>(`/api/gzh/article?dir=${encodeURIComponent(dir)}`),
  save: (body: {
    dir: string;
    markdown?: string;
    style?: string;
    baseMdHash?: string;
    baseStyleHash?: string;
  }) => post<GzhSaveResult>("/api/gzh/article/save", body),
  exportLayout: (dir: string, html: string) =>
    post<{ file: string; size: number }>("/api/gzh/article/export", { dir, html }),
};
