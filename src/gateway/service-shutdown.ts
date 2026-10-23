/**
 * Bot 进程优雅停止（F2，P0-B T1；需求：dev-docs/design/2026-10-22-wechat-persistent-service.md §4 F2）
 *
 * 双触发源共享一条停止路径：
 *   - 前台：SIGINT（Ctrl-C）
 *   - 后台：PM2 shutdown_with_message 发来的 process.on("message", "shutdown")
 *
 * 契约：
 *   - 防重复停止（stopping 标志，二次触发直接忽略——SIGINT 连按/PM2 超时强信号前又补消息）
 *   - await app.stop()（WG-007：只停 Bot，不取消运行中任务，可 resume）
 *   - stop 抛错也必须释放单实例锁（finally——锁残留靠陈锁自愈兜底，但正常路径不制造残留）
 *   - 服务模式（PI_WECHAT_SERVICE=1，PM2 托管）停止完成即 exit(0)——PM2 stop 等的是进程退出；
 *     前台模式回调交还主流程正常返回（保持 CLI 语义不变）
 */

export interface GracefulShutdownDeps {
  stop: () => Promise<void>;
  releaseLock: () => void;
  /** 停止完成后回调（前台模式用它 resolve 主等待 Promise） */
  onStopped: () => void;
  /** 服务模式（PM2 托管）下停止后直接退出进程 */
  serviceMode: boolean;
  log?: (msg: string) => void;
}

/** 返回停止触发函数（幂等：重复触发被忽略） */
export function createGracefulShutdown(deps: GracefulShutdownDeps): (reason: string) => void {
  let stopping = false;
  return (reason: string) => {
    if (stopping) return; // 防重复停止
    stopping = true;
    const log = deps.log ?? ((m: string) => process.stdout.write(m));
    log(`\n收到停止指令（${reason}），正在优雅停止 Bot（运行中任务不受影响）…\n`);
    void deps
      .stop()
      .catch(() => undefined)
      .finally(() => {
        try {
          deps.releaseLock();
        } finally {
          deps.onStopped();
          if (deps.serviceMode) process.exit(0);
        }
      });
  };
}
