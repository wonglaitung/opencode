/** 面向用户的中文错误（CLI 捕获后打到 stderr 并以退出码 1 结束）。 */
export class TeamShareError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TeamShareError"
  }
}
