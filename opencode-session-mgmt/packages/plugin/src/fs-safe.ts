/**
 * 安全路径解析（防越界）：把工具收到的相对路径解析到工作区内，
 * 拒绝逃出 worktree 的路径（如 `..`、绝对路径、Windows 上的 `C:\...`）。
 * reqdoc_scan / reqdoc_check / reqdoc_export 读取用户/AI 传入的相对路径前统一经此收敛，
 * 避免越权读工作区外的文件（Windows 上尤为关键，绝对盘符路径会直接越界）。
 */
import { resolve, sep } from "node:path"

/** 解析 rel 到 worktree 内；越界抛错。返回绝对路径。 */
export function resolveWithinWorktree(worktree: string, rel: string): string {
  const base = resolve(worktree)
  const full = resolve(base, rel)
  if (full !== base && !full.startsWith(base + sep)) {
    throw new Error(`路径越界：'${rel}' 解析后不在工作区内（${base}），已拒绝访问`)
  }
  return full
}
