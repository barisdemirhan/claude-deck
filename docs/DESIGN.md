# Deck: design

Agreed on 2026-10-05, against Claude Code 2.1.289. Nothing here is built yet.

## What it is

One mod, three layers.

1. **A label on the hint line**, always there: `Fable 5.1 ▰▰▰▱▱ high · ⏵ 3 · Auth renewal 5/8`. A click on it opens or closes the pane. `/deck` does the same, `/deck close` takes the mod away in every session.
2. **A pane beside the conversation**, made of sections. Each section is one source of data, so a new feature is a new section.
3. **Runs**: step-by-step progress of any job, as a tree of any depth (story, task, subtask). Several runs can go at once.

```
✻ Deck                                                      ×
 Fable 5.1   ▰▰▰▱▱ high ⟳        ctx ▰▰▱▱▱▱▱▱ 23%
──────────────────────────────────────────────────────────────
 RUNNING · 3                                     2 shell 1 agent
 ⏵ Typecheck, test and lint             shell          1m 12s
 ⏵ npm run dev                          shell         14m 03s
 ⏵ liman(megarefill prod deploy)        agent            48s
──────────────────────────────────────────────────────────────
 ▾ Auth renewal                        ▰▰▰▰▰▱▱▱ 5/8    12m 40s
   ✓ Token rotation                            3/3      6m 02s
   ▾ Session cleanup                           2/3      4m 11s
     ✓ Move the old table                               1m 30s
     ✓ Remove the cron                                    41s
     ⏵ Update the tests                                 2m 00s
   ○ Documentation                             0/2
──────────────────────────────────────────────────────────────
 ▸ megarefill deploy · liman           ▰▰▰▰▰▰▱▱ 3/4     3m 05s
 ▸ ✓ Parser refactor                   ▰▰▰▰▰▰▰▰ 6/6     9m 17s
──────────────────────────────────────────────────────────────
 RECENT
 ✓ npm run build                        shell          2m 03s
 ✗ pytest -k auth                       shell              8s
```

- A finished branch folds by itself, the running one stays open; `▸` and `▾` are clickable.
- A failed step is a red `✗` and marks every parent above it, so a folded run still shows it.

## Where the data comes from

| Shown | Source | State |
| --- | --- | --- |
| Model and effort | `turn.step`, main thread (`agentId` absent) | Known |
| A shell's start, duration, failure | `tool.call` on `Bash`: `description`, `command`, `run_in_background` | Known |
| A background shell's end | The task notification row (`UserMessage`, `origin.kind: 'task-notification'`) and `classic.Stop`'s `background_tasks` | **Verify first** |
| Subagents | `agent.spawn`, `$.agent.list()` | Known |
| Runs | The three feeds below | |

There is no call that lists running tasks, so background shells are tracked from events.

## Effort

A click on the meter raises the level one step: low, medium, high, xhigh, max, then back to low. The mod does it by rewriting `effort` on the main thread's `turn.step`. Subagents keep their own. `/effort` hands control back to Claude Code from the next request.

## Runs: three feeds, one tree

| Feed | Who uses it | Cost to the agent |
| --- | --- | --- |
| Claude Code's own `TaskCreate` and `TaskUpdate` calls, watched | The agent, as it already does | None; a flat list |
| The mod's tool, two calls: `plan` and `step` | The agent, when the job has levels | One call to start, a few tokens per change |
| A JSONL file | Scripts, CI, a deploy script | For work outside the agent |

Rules that keep the agent's cost low:

- **The plan comes once, as indented text.** The mod gives each line an id from its place: `1`, `1.2`, `1.2.1`.
- **The agent updates leaves only.** `step("1.1.2", "start")`. A parent's state and count come from its children.
- **Starting a step ends the one before it** under the same parent, so most changes are one call.
- **The mod keeps the time.** The agent never sends one.

Each `plan` is its own run. A run a subagent opened carries that agent's name.

The tool is a setting that defaults to off. So is the file feed, since it reads files.

**Verify:** whether a subagent sees the mod's tool. If not, a subagent's run comes from the file feed or from its tool calls.

## What it reads that the other mods do not

`description` and `command` of a `Bash` call, kept in memory only. Nothing goes to disk or to the network. README and PRIVACY.md say so.

## Order

1. **0.1** The label, the pane, the model, the clickable effort meter, shells and agents, recent.
2. **0.2** The tree, watching `TaskCreate` and `TaskUpdate`, the `plan` and `step` tool.
3. **0.3** The JSONL feed, and a line in liman's agent definition that reports deploy steps.

Start 0.1 with the two checks marked **Verify**.
