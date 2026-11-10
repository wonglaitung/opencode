import type { ToolDefinition } from "@opencode-ai/plugin"
import { getDefinition, type WorkflowType } from "sm-shared"
import type { Store } from "../db"
import type { IdeEntry } from "../open-ide/config"
import type { LockRegistry } from "../open-ide/lock"
import { createOpenIdeTool } from "../open-ide/open-ide-tool"
import { createLockTools } from "../open-ide/tools/lock-tools"
import { createReqdocConventionReviewTool } from "./reqdoc-review-conventions"
import { createReqdocExportTool } from "./reqdoc-export"
import { createReqdocFeatureTools } from "./reqdoc-features"
import { createReqdocImportTool } from "./reqdoc-import"
import { createReqdocInitTool } from "./reqdoc-dirs"
import { createReqdocKbTools } from "./reqdoc-kb-tools"
import { createReqdocScanTool } from "./reqdoc-scan"
import { createReviewTools } from "./review"
import { createTaskCheckTool } from "./task-check"
import { createTaskClassifyTool } from "./task-classify"
import { createTaskReviewTool } from "./task-review"
import { createTaskScanTool } from "./task-scan"
import { createWebsecAnonymousTool } from "./websec-anonymous"
import { createWebsecEdgeTools } from "./websec-edge"
import { createWebsecHttpTools } from "./websec-http"
import { createWebsecSurfaceTools } from "./websec-surface"
import { createWebsecTools } from "./websec"
import { createWorkflowStartTools } from "./workflow-start"
import { createWorkflowTools } from "./workflow"

type Input = {
  store: Store
  workflowType: WorkflowType
  ideEntries: IdeEntry[]
  lockRegistry: LockRegistry
  projectDir: string
}

export function createToolset(input: Input): Record<string, ToolDefinition> {
  const def = getDefinition(input.workflowType)
  const workflow = createWorkflowTools(input.store)
  if (!def.hasCommitGate) {
    delete workflow.commit_gate_check
    delete workflow.commit_force_unlock
  }

  return {
    ...workflow,
    ...createWorkflowStartTools(input.store),
    ...(def.type === "task" ? createTaskClassifyTool(input.store) : {}),
    ...(def.type === "task" ? createTaskReviewTool(input.store) : {}),
    ...(def.type === "task" ? createTaskScanTool(input.store) : {}),
    ...(def.type === "task" ? createTaskCheckTool(input.store) : {}),
    ...(def.reviewStage === null ? {} : createReviewTools(input.store, def.type)),
    ...(def.type === "reqdoc" ? reqdocTools(input.store) : {}),
    ...(def.type === "websec" ? createWebsecTools(input.store, input.projectDir) : {}),
    ...(def.type === "websec" ? createWebsecEdgeTools(input.store, input.projectDir) : {}),
    ...(def.type === "websec" ? createWebsecAnonymousTool(input.store, input.projectDir) : {}),
    ...(def.type === "websec" ? createWebsecSurfaceTools(input.store, input.projectDir) : {}),
    ...(def.type === "websec" ? createWebsecHttpTools(input.store, input.projectDir) : {}),
    open_ide: createOpenIdeTool(input.ideEntries, input.lockRegistry),
    ...createLockTools(input.lockRegistry),
  }
}

function reqdocTools(store: Store): Record<string, ToolDefinition> {
  return {
    ...createReqdocScanTool(),
    ...createReqdocInitTool(),
    ...createReqdocFeatureTools(store),
    ...createReqdocKbTools(store),
    ...createReqdocExportTool(store),
    ...createReqdocImportTool(),
    ...createReqdocConventionReviewTool(),
  }
}
