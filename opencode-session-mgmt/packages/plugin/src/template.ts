/**
 * reqdoc 渲染模板送达（实施方案「渲染铁律」的部署保障，模板冻结约束下只改送达机制）。
 *
 * 背景：渲染铁律（reqdoc-r14/r20）要求以模板为唯一依据严格逐字遵循渲染，但模板文件
 * docs/reqdoc-prd-template.md 只在仓库 docs/ 下。打包部署到客户端后，模型运行目录
 * （用户项目）没有 docs/，仅靠规则里的内联骨架无法做到逐字遵循。本模块让插件在
 * prd 阶段从**插件自身所在目录**的相对路径读取模板全文、注入系统提示——客户端不
 * 依赖运行目录存在模板文件，「逐字遵循」才真正可执行。
 *
 * 路径解析：插件以源码运行（package.json main 指向 src/index.ts），import.meta.dir
 * = <root>/packages/plugin/src；按部署形态依次探测候选路径，全部读不到返回 null，
 * 调用方退化为 reqdoc-r14 的内联骨架兜底（与旧行为一致）。
 */
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

const TEMPLATE_FILENAME = "reqdoc-prd-template.md"

/** 候选路径（相对 import.meta.dir，按部署形态排列）：
 *  1. 源码 / 整包运行：<root>/packages/plugin/src → ../../../docs → <root>/docs
 *  2. dist 构建（bun build --outdir dist/plugin）：<root>/dist/plugin → ../../docs → <root>/docs
 *  3. 运行目录兜底（旧「运行目录可读」行为，开发仓库内 cwd=仓库根 时生效） */
function templateCandidates(): string[] {
  const here = import.meta.dir
  return [
    join(here, "../../../docs", TEMPLATE_FILENAME),
    join(here, "../../docs", TEMPLATE_FILENAME),
    join(process.cwd(), "docs", TEMPLATE_FILENAME),
  ]
}

// 模块级缓存：模板只读一次（undefined=未读；string|null=已读结果），避免每轮重复 I/O。
let cached: string | null | undefined

/** 读取 reqdoc 渲染模板全文（首次读取后缓存）。返回 null 表示所有候选路径均读不到。 */
export function loadReqdocTemplate(): string | null {
  if (cached !== undefined) return cached
  for (const path of templateCandidates()) {
    try {
      if (existsSync(path)) {
        cached = readFileSync(path, "utf8").trim()
        return cached
      }
    } catch {
      // 单个候选读失败不致命，继续探测下一个
    }
  }
  cached = null
  return null
}
