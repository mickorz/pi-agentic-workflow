#!/usr/bin/env python3
"""微信草稿 API 层：token / 素材上传 / draft add-update-get，真实与 Mock 双实现。

契约（需求文档 V1.2 第 4.5 节）：
- 账号槽位透传：凭证按 WECHAT_<N>_APPID / WECHAT_<N>_APPSECRET 读取，上层选哪个账号就用哪个
- 失败三分类（上层据此决定状态迁移）：
    WechatAPIError    —— 微信返回确定失败的 errcode（明确失败，可修复后重试）
    WechatNetworkError —— 超时/连接中断等结果不明（不确定失败，进 unknown，禁止自动重试）
- Mock 实现（--mock）：本地 JSON store 持久化草稿，跨子进程共享；
  自身读改写也走 O_EXCL 锁 + 原子替换，支持多进程并发测试；
  故障注入由 inject 参数驱动：add-timeout / add-errcode / crash-after-add /
  update-timeout / crash-after-update
- draft/update 固定 index=0（首篇）；draft/get 用于复用核对与恢复核对
"""
from __future__ import annotations

import json
import os
import time
import uuid
from pathlib import Path
from urllib.error import URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

BASE = "https://api.weixin.qq.com"


class WechatAPIError(Exception):
    """明确失败：微信返回了确定失败的 errcode。"""

    def __init__(self, where: str, errcode, errmsg):
        self.where = where
        self.errcode = errcode
        super().__init__(f"{where} errcode={errcode} errmsg={errmsg}")


class WechatNetworkError(Exception):
    """不确定失败：请求结果未知（超时/断连/进程崩溃前夜）。"""

    def __init__(self, where: str, detail: str):
        self.where = where
        super().__init__(f"{where} network: {detail}")


def load_account_credentials(config_dir: Path, account_slot: int) -> tuple[str, str, str | None]:
    """从 aws.env 读取指定槽位凭证与可选 API base（代理通道，缺省直连官方）。槽位不存在立即报错（账号透传失败必须显性暴露）。"""
    env_file = Path(config_dir) / "aws.env"
    env_vars: dict[str, str] = {}
    for line in env_file.read_text(encoding="utf-8-sig", errors="replace").splitlines():
        line = line.strip()
        if "=" in line and not line.startswith("#"):
            k, _, v = line.partition("=")
            env_vars[k.strip()] = v.strip()
    appid = env_vars.get(f"WECHAT_{account_slot}_APPID")
    secret = env_vars.get(f"WECHAT_{account_slot}_APPSECRET")
    if not appid or not secret:
        raise WechatAPIError("credentials", f"missing WECHAT_{account_slot}_APPID/APPSECRET in {env_file}")
    api_base = (env_vars.get(f"WECHAT_{account_slot}_API_BASE") or "").strip() or None
    return appid, secret, api_base


# ---------------------------------------------------------------- 真实实现 --


class WechatClient:
    def __init__(self, appid: str, secret: str, api_base: str | None = None):
        self.appid = appid
        self.secret = secret
        # 代理通道：aws.env 的 WECHAT_<N>_API_BASE（如 IP 白名单场景），缺省直连官方
        self.base = (api_base or BASE).rstrip("/")
        self._token: str | None = None

    def _get_json(self, url: str, timeout: int = 60) -> dict:
        try:
            with urlopen(Request(url, headers={"User-Agent": "pi-workflow-draft/1.0"}), timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except (URLError, OSError) as e:
            raise WechatNetworkError(url.split("?")[0].rsplit("/", 1)[-1], str(e))

    def _post_json(self, url: str, body: dict, timeout: int = 60) -> dict:
        req = Request(
            url,
            data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
            headers={"Content-Type": "application/json; charset=utf-8"},
            method="POST",
        )
        try:
            with urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except (URLError, OSError) as e:
            raise WechatNetworkError(url.split("?")[0].rsplit("/", 1)[-1], str(e))

    def token(self) -> str:
        if self._token:
            return self._token
        r = self._get_json(self.base + "/cgi-bin/token?" + urlencode({"grant_type": "client_credential", "appid": self.appid, "secret": self.secret}))
        if not r.get("access_token"):
            raise WechatAPIError("token", r.get("errcode"), r.get("errmsg"))
        self._token = r["access_token"]
        return self._token

    def _upload_multipart(self, url: str, path: Path) -> dict:
        boundary = "----piworkflow" + uuid.uuid4().hex
        ctype = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp"}.get(path.suffix.lower(), "application/octet-stream")
        body = b"".join([
            f"--{boundary}\r\n".encode(),
            f'Content-Disposition: form-data; name="media"; filename="{path.name}"\r\n'.encode(),
            f"Content-Type: {ctype}\r\n\r\n".encode(),
            path.read_bytes(),
            f"\r\n--{boundary}--\r\n".encode(),
        ])
        req = Request(url, data=body, headers={"Content-Type": f"multipart/form-data; boundary={boundary}"}, method="POST")
        try:
            with urlopen(req, timeout=120) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except (URLError, OSError) as e:
            raise WechatNetworkError("upload", str(e))

    def add_material_image(self, path: Path) -> str:
        r = self._upload_multipart(f"{self.base}/cgi-bin/material/add_material?access_token={self.token()}&type=image", path)
        if not r.get("media_id"):
            raise WechatAPIError("add_material", r.get("errcode"), r.get("errmsg"))
        return r["media_id"]

    def uploadimg(self, path: Path) -> str:
        r = self._upload_multipart(f"{self.base}/cgi-bin/media/uploadimg?access_token={self.token()}", path)
        if not r.get("url"):
            raise WechatAPIError("uploadimg", r.get("errcode"), r.get("errmsg"))
        return r["url"]

    def draft_add(self, article: dict) -> str:
        r = self._post_json(f"{self.base}/cgi-bin/draft/add?access_token={self.token()}", {"articles": [article]})
        if not r.get("media_id"):
            raise WechatAPIError("draft_add", r.get("errcode"), r.get("errmsg"))
        return r["media_id"]

    def draft_update(self, media_id: str, article: dict, index: int = 0) -> None:
        r = self._post_json(
            f"{self.base}/cgi-bin/draft/update?access_token={self.token()}",
            {"media_id": media_id, "index": index, "articles": article},
        )
        if r.get("errcode", 0) not in (0, None):
            raise WechatAPIError("draft_update", r.get("errcode"), r.get("errmsg"))

    def draft_get(self, media_id: str) -> dict | None:
        """取草稿；草稿不存在（已删除/已发表移除）返回 None，其他错误照常抛出。"""
        r = self._post_json(f"{self.base}/cgi-bin/draft/get?access_token={self.token()}", {"media_id": media_id})
        if r.get("errcode") and r.get("errcode") != 0:
            # 40007 = 无效 media_id（草稿已删除或已发表移除）
            if r.get("errcode") == 40007:
                return None
            raise WechatAPIError("draft_get", r.get("errcode"), r.get("errmsg"))
        return r.get("news_item") is not None and r or None

    def freepublish_submit(self, media_id: str) -> str:
        """提交公开发表；仅表示任务已受理，返回 publish_id，最终状态必须经 freepublish_get 确认。"""
        r = self._post_json(f"{BASE}/cgi-bin/freepublish/submit?access_token={self.token()}", {"media_id": media_id})
        if r.get("errcode") and r.get("errcode") != 0:
            # 53402 = 草稿已发表/不存在等；统一作明确失败抛出
            raise WechatAPIError("freepublish_submit", r.get("errcode"), r.get("errmsg"))
        if not r.get("publish_id"):
            raise WechatAPIError("freepublish_submit", "missing", "no publish_id in response")
        return r["publish_id"]

    def freepublish_get(self, publish_id: str) -> dict:
        """查询发表状态。返回 {publish_status: 0成功|1发表中|其他失败, raw}。

        微信 publish_status：0=发表成功；1=发表中；2=原创失败；3=常规失败；4=平台审核不通过。
        """
        r = self._post_json(f"{BASE}/cgi-bin/freepublish/get?access_token={self.token()}", {"publish_id": publish_id})
        if r.get("errcode") and r.get("errcode") != 0:
            raise WechatAPIError("freepublish_get", r.get("errcode"), r.get("errmsg"))
        return {"publish_status": r.get("publish_status"), "raw": r}


# ---------------------------------------------------------------- Mock 实现 --


class MockWechatClient:
    """本地 Mock：草稿存 JSON store（跨子进程共享，自身 RMW 串行化 + 原子落盘）。

    store 结构：{"counter": N, "drafts": {media_id: {title, digest, author, content,
    thumb_media_id, appid, deleted}}, "calls": [{op, appid, at}]}
    inject：None / add-timeout / add-errcode / crash-after-add / update-timeout / crash-after-update
    """

    def __init__(self, appid: str, store_path: Path, inject: str | None = None, secret: str = ""):
        self.appid = appid
        self.store_path = Path(store_path)
        self.inject = inject
        self.secret = secret
        self._token = "mock-token"

    # -- store 原子读写 -------------------------------------------------------

    def _store_lock(self):
        return self.store_path.parent / (self.store_path.name + ".lock")

    def _store_read(self) -> dict:
        if not self.store_path.is_file():
            return {"counter": 0, "drafts": {}, "calls": []}
        return json.loads(self.store_path.read_text(encoding="utf-8"))

    def _store_write(self, data: dict) -> None:
        tmp = self.store_path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
        os.replace(str(tmp), str(self.store_path))

    class _StoreTx:
        """store 读改写事务（O_EXCL 串行 + 死进程接管，同 article_state 的 RMW 模式）。"""

        def __init__(self, client: "MockWechatClient"):
            self.c = client
            self.fd = None

        def __enter__(self):
            lock = self.c._store_lock()
            lock.parent.mkdir(parents=True, exist_ok=True)
            while True:
                try:
                    self.fd = os.open(str(lock), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                    break
                except OSError as e:
                    if e.errno != errno_EEXIST:
                        raise
                    try:
                        info = json.loads(lock.read_text(encoding="utf-8"))
                        if info.get("pid") and not _pid_alive(info["pid"]):
                            lock.unlink()
                            continue
                    except (OSError, ValueError):
                        pass
                    time.sleep(0.02)
            os.write(self.fd, json.dumps({"pid": os.getpid()}).encode())
            self.data = self.c._store_read()
            return self

        def __exit__(self, *a):
            if a[0] is None:
                self.c._store_write(self.data)
            os.close(self.fd)
            try:
                self.c._store_lock().unlink()
            except OSError:
                pass

    # -- API ------------------------------------------------------------------

    def _record_call(self, op: str) -> None:
        with MockWechatClient._StoreTx(self) as tx:
            tx.data.setdefault("calls", []).append({"op": op, "appid": self.appid, "at": time.time()})

    def token(self) -> str:
        return self._token

    def add_material_image(self, path: Path) -> str:
        self._record_call("add_material")
        return "mock-thumb-" + uuid.uuid4().hex[:12]

    def uploadimg(self, path: Path) -> str:
        self._record_call("uploadimg")
        return "mock-img-url://" + path.name

    def draft_add(self, article: dict) -> str:
        if self.inject == "add-timeout":
            raise WechatNetworkError("draft_add", "mock timeout")
        if self.inject == "add-errcode":
            raise WechatAPIError("draft_add", 40007, "mock invalid media id size")
        media_id = "mock-draft-" + uuid.uuid4().hex[:12]
        with MockWechatClient._StoreTx(self) as tx:
            tx.data["counter"] = tx.data.get("counter", 0) + 1
            tx.data["drafts"][media_id] = {
                "title": article.get("title"),
                "digest": article.get("digest"),
                "author": article.get("author"),
                "content": article.get("content"),
                "thumb_media_id": article.get("thumb_media_id"),
                "appid": self.appid,
                "deleted": False,
            }
            tx.data.setdefault("calls", []).append({"op": "draft_add", "appid": self.appid, "at": time.time()})
        if self.inject == "crash-after-add":
            # 模拟"微信已建草稿、进程未写回状态即崩溃"
            _abort_hard()
        return media_id

    def draft_update(self, media_id: str, article: dict, index: int = 0) -> None:
        if self.inject == "update-timeout":
            raise WechatNetworkError("draft_update", "mock timeout")
        with MockWechatClient._StoreTx(self) as tx:
            d = tx.data["drafts"].get(media_id)
            if d is None or d.get("deleted"):
                raise WechatAPIError("draft_update", 40007, "mock draft not found")
            if index != 0:
                raise WechatAPIError("draft_update", 40008, "mock only index=0 supported")
            d.update({k: article.get(k) for k in ("title", "digest", "author", "content", "thumb_media_id")})
            tx.data.setdefault("calls", []).append({"op": "draft_update", "appid": self.appid, "at": time.time()})
        if self.inject == "crash-after-update":
            _abort_hard()

    def draft_get(self, media_id: str) -> dict | None:
        with MockWechatClient._StoreTx(self) as tx:
            d = tx.data["drafts"].get(media_id)
        if d is None or d.get("deleted"):
            return None
        return {"news_item": [{"title": d["title"]}]}

    def freepublish_submit(self, media_id: str) -> str:
        if self.inject == "publish-timeout":
            raise WechatNetworkError("freepublish_submit", "mock timeout")
        publish_id = "mock-pub-" + uuid.uuid4().hex[:12]
        with MockWechatClient._StoreTx(self) as tx:
            d = tx.data["drafts"].get(media_id)
            if d is None or d.get("deleted"):
                raise WechatAPIError("freepublish_submit", 53402, "mock draft not found")
            status = 2 if self.inject == "publish-errcode" else 1  # 2=原创失败(明确失败), 1=发表中
            tx.data.setdefault("publishes", {})[publish_id] = {
                "media_id": media_id, "appid": self.appid, "status": status, "polls": 0,
            }
            tx.data.setdefault("calls", []).append({"op": "freepublish_submit", "appid": self.appid, "at": time.time()})
        if self.inject == "crash-after-submit":
            # 提交已受理(store 已写)但进程崩溃,publish_id 未及落盘 => 状态只能人工核对
            _abort_hard()
        return publish_id

    def freepublish_get(self, publish_id: str) -> dict:
        with MockWechatClient._StoreTx(self) as tx:
            p = tx.data.get("publishes", {}).get(publish_id)
            if p is None:
                raise WechatAPIError("freepublish_get", 40007, "mock publish not found")
            if p["status"] == 1:
                p["polls"] = p.get("polls", 0) + 1
                if p["polls"] >= 2:  # 模拟异步:首次查发表中,再次查成功
                    p["status"] = 0
                    # 发表成功后草稿从草稿箱移除(真实微信行为)
                    d = tx.data["drafts"].get(p["media_id"])
                    if d is not None:
                        d["deleted"] = True
            result = {"publish_status": p["status"], "raw": {"publish_id": publish_id}}
        return result


def _abort_hard() -> None:
    """硬退出，模拟崩溃（绕过所有清理逻辑，状态停在 submitting/running）。"""
    import os as _os

    _os._exit(9)


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if os.name == "nt":
        import ctypes

        SYNCHRONIZE = 0x00100000
        kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
        handle = kernel32.OpenProcess(SYNCHRONIZE, False, pid)
        if not handle:
            return False
        kernel32.CloseHandle(handle)
        return True
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


import errno as _errno  # noqa: E402

errno_EEXIST = _errno.EEXIST
