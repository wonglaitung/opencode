import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import { startGuestClient } from "./client"
import { startHostRoom } from "./host"
import { consumeIntent, intentCandidates } from "./intent"
import { parseInvite } from "./protocol"
import { ROUTE, roomRoute } from "./route"

const id = "collab-room"

const tui: TuiPlugin = async (api) => {
  const consumed = await consumeIntent(intentCandidates({ directory: api.state.path.directory, cwd: process.cwd() }))
  if (!consumed) return

  if (consumed.intent.mode === "join") {
    const invite = parseInvite(consumed.intent.invite)
    if (!invite) {
      api.ui.toast({ title: "协作房间", message: "邀请码无效，请向主机重新索取" })
      return
    }
    const client = startGuestClient({ url: invite.url, name: consumed.intent.name })
    const previous = leaveTarget(api)
    api.route.register([roomRoute({ api, client, leave: () => api.route.navigate(previous.name, previous.params) })])
    api.lifecycle.onDispose(() => client.dispose())
    setTimeout(() => api.route.navigate(ROUTE), 0)
    return
  }

  const host = startHostRoom(api)
  api.lifecycle.onDispose(host.dispose)
}

function leaveTarget(api: TuiPluginApi): { name: string; params?: Record<string, unknown> } {
  const route = api.route.current
  if (route.name === "session" && "params" in route && route.params) {
    const sessionID = (route.params as Record<string, unknown>).sessionID
    if (typeof sessionID === "string" && sessionID) return { name: "session", params: { sessionID } }
  }
  return { name: "home" }
}

export default { id, tui }
