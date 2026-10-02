/**
 * reqdoc 渲染模板送达（兼容入口，实现已搬进 shared）。
 *
 * 为什么搬走：模板结构此前在 `reqdoc-render.ts` 有一份手抄本、与 md 又是一份，两份不一致
 * 时零告警（槽位收了但进不了交付件）。结构改为从 md 解析后，解析器与模板读取必须在同一层——
 * 否则消费解析结果的纯函数调用点（`requiredSlots` 等）都要加参数传模板文本。
 * `shared/src` 与 `plugin/src` 到仓库根同为上溯三级，同一份路径探测对两个包都成立。
 *
 * 原本的设立理由仍然有效，保留备查：reqdoc-r14/r20 要求以模板为唯一依据逐字渲染，
 * 而模板只在仓库 docs/ 下；打包部署到客户端后模型的运行目录没有 docs/，故必须从
 * **插件自身所在目录**的相对路径读取，客户端才不依赖运行目录存在模板文件。
 *
 * 本文件仅为 re-export，供插件层保持原调用点不变；实现见
 * `reqdoc-template-schema.ts` 的 `loadTemplateText`。
 */
export { loadTemplateText as loadReqdocTemplate } from "sm-shared"