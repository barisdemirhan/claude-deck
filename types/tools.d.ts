// The inputs of the tools the mod lists for the model, so a `tool.call`
// hook on them is typed.
export {}

declare module 'claude-code' {
  interface McpToolInputs {
    mcp__deck__plan: { title: string; steps: string }
    mcp__deck__step: { id: string; state: string; run?: string }
  }
}
