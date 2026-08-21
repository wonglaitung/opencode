/**
 * 安全路径解析（防越界）：把工具收到的相对路径解析到工作区内，
 * 拒绝逃出 worktree 的路径（如 `..`、绝对路径、Windows 上的 `C:\...`）。
 * reqdoc_scan / reqdoc_check / reqdoc_export 读取用户/AI 传入的相对路径前统一经此收敛，
 * 避免越权读工作区外的文件（Windows 上尤为关键，绝对盘符路径会直接越界）。
 */
import { resolve, sep } from "node:path"

/**
 * 解析需求资料根目录（项目根）。
 * 优先用 context.directory（SDK 定义为「当前项目目录」），回退 worktree。
 * 背景：opencode 对非 git 项目的 worktree 可能解析到守护进程启动目录而非项目根，
 * 导致 01~06 骨架被建到错误位置；contract 要求 01~06 与 .opencode 同级落在项目根，
 * 故以 directory 为准。reqdoc_init / scan / check / export / features 统一经此取根。
 */
export function projectRoot(ctx: { directory?: string; worktree: string }): string {
  return ctx.directory || ctx.worktree
}

/** 解析 rel 到工作区内；越界抛错。返回绝对路径。 */
export function resolveWithinWorktree(worktree: string, rel: string): string {
  const base = resolve(worktree)
  const full = resolve(base, rel)
  if (full !== base && !full.startsWith(base + sep)) {
    throw new Error(`路径越界：'${rel}' 解析后不在工作区内（${base}），已拒绝访问`)
  }
  return full
}
