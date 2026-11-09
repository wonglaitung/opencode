# edge-debug-core

`opencode-edge-debug` 与 `opencode-session-mgmt` 共用的 Edge/CDP 浏览器调试核心。

包含：

- Edge 进程启动/停止与专用 profile
- 零依赖 CDP 客户端
- Console/网络日志环形缓冲
- 页面求值、页面信息/正文
- 结构化请求详情（供证据落盘/哈希）

不包含 OpenCode 插件工具定义、工作流状态或 websec 语义。

## 采集策略

`NetworkCapturePolicy` 支持 `debug`（默认）与 `websec` 两种模式：

- `debug`：4xx/5xx + `/api/` + JSON，工具展示最近 50 条
- `websec`：内部缓冲 500 条，保留同源 2xx `Document`/`XHR`/`Fetch`、3xx、4xx/5xx；脚本仅元数据
- `shouldCaptureBody()` 判断是否值得拉取响应体，避免把脚本/静态资源正文写入证据
- `WEBSEC_CAPTURE_POLICY` 提供 websec 默认策略，可由上层补 `origins` 白名单
