import { SyntaxStyle } from "@opentui/core"
import type { TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import { createEffect, createMemo, on, onCleanup } from "solid-js"

/**
 * 房间页的语法高亮。
 *
 * 宿主没有把 Theme.syntax 暴露给插件，只能按 TuiThemeCurrent 的颜色重建一份；
 * scope 与 packages/tui/src/theme 的 getSyntaxRules 子集一致，保证代码块观感接近。
 */
export function createSyntaxStyle(theme: TuiThemeCurrent) {
  return SyntaxStyle.fromTheme([
    { scope: ["default"], style: { foreground: theme.text } },
    { scope: ["comment", "comment.documentation"], style: { foreground: theme.syntaxComment } },
    { scope: ["string", "symbol", "character.special"], style: { foreground: theme.syntaxString } },
    { scope: ["number", "boolean", "constant"], style: { foreground: theme.syntaxNumber } },
    {
      scope: ["keyword", "keyword.return", "keyword.conditional", "keyword.repeat", "keyword.coroutine"],
      style: { foreground: theme.syntaxKeyword },
    },
    { scope: ["keyword.type", "type", "module", "class"], style: { foreground: theme.syntaxType } },
    {
      scope: ["keyword.function", "function", "function.method", "function.call", "constructor"],
      style: { foreground: theme.syntaxFunction },
    },
    { scope: ["operator", "keyword.operator", "punctuation.delimiter"], style: { foreground: theme.syntaxOperator } },
    {
      scope: ["variable", "variable.parameter", "variable.member", "property", "parameter"],
      style: { foreground: theme.syntaxVariable },
    },
    { scope: ["punctuation", "punctuation.bracket"], style: { foreground: theme.syntaxPunctuation } },
    { scope: ["markup.heading"], style: { foreground: theme.markdownHeading } },
    { scope: ["markup.link"], style: { foreground: theme.markdownLink } },
    { scope: ["markup.raw"], style: { foreground: theme.markdownCode } },
  ])
}

/** 页面级共享一份 SyntaxStyle：每条消息各建一份会泄漏原生句柄。 */
export function useSyntaxStyle(theme: () => TuiThemeCurrent) {
  const style = createMemo(() => createSyntaxStyle(theme()))
  createEffect(
    on(style, (value, previous) => {
      if (previous && previous !== value) previous.destroy()
    }),
  )
  onCleanup(() => style().destroy())
  return style
}
