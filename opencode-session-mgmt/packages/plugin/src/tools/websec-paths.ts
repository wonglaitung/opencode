import { mkdir, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { WorkflowOpError } from "../workflow-ops"

export function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80) || "evidence"
}

/** 解析项目内证据根目录；拒绝绝对路径与越界。 */
export function resolveEvidenceRoot(projectDir: string, configured: string | undefined): string {
  const root = resolve(projectDir)
  const rel = configured ?? "websec-evidence"
  if (isAbsolute(rel) || rel.split(/[\\/]+/).some((part) => part === "." || part === "..")) {
    throw new WorkflowOpError("evidence_dir 必须是项目内相对路径")
  }
  const resolved = resolve(root, rel)
  const check = relative(root, resolved)
  if (check.startsWith("..") || isAbsolute(check) || check === "") {
    throw new WorkflowOpError("evidence_dir 不能跳出项目目录")
  }
  return resolved
}

export function evidenceSessionDir(
  projectDir: string,
  configured: string | undefined,
  sessionID: string,
): string {
  return join(resolveEvidenceRoot(projectDir, configured), safeName(sessionID))
}

/** 测试产物只能落在当前证据根目录内。 */
export function resolveEvidencePath(
  projectDir: string,
  configured: string | undefined,
  value: string,
): string {
  if (/%TEMP%|%TMP%|\$env:TEMP|\$env:TMP/i.test(value)) {
    throw new WorkflowOpError("测试产物必须位于项目内，禁止使用系统临时目录")
  }
  const root = resolveEvidenceRoot(projectDir, configured)
  const absolute = isAbsolute(value) ? resolve(value) : resolve(projectDir, value)
  const check = relative(root, absolute)
  if (check === "" || check.startsWith("..") || isAbsolute(check)) {
    throw new WorkflowOpError("测试产物必须位于项目内的 websec 证据目录")
  }
  return absolute
}

export async function ensureEvidenceGitignore(root: string): Promise<void> {
  await mkdir(root, { recursive: true })
  try {
    await writeFile(join(root, ".gitignore"), "*\n!.gitignore\n", { encoding: "utf8", flag: "wx" })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
  }
}

export async function writeEvidenceFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, { encoding: "utf8", mode: 0o600 })
}
