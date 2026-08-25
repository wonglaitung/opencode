---
description: 按项目规约提交改动（conventional commits，中文 message）
---

审查当前改动（`git status --short`、`git diff`），确认无遗漏、无上游文件改动后提交。

规约：

- conventional commit：`type(scope): summary`，type 用 `feat`/`fix`/`docs`/`chore`/`refactor`/`test`，scope 可用 `plugin`/`cli`/`collector`/`shared`/`docs` 等。
- commit message 用中文，说明「为什么」而非罗列「做了什么」。
- 只提交本工程相关改动，不得包含上游 `packages/*` 或根目录文件。

推送前与用户确认。
