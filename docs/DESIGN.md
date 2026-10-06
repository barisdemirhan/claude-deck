# Deck: design

Agreed on 2026-10-05, against Claude Code 2.1.289. The two points first marked **Verify** were checked the same day; what was found is under [Checked](#checked).

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
 ⏵ general-purpose(Ship the release)    agent            48s
──────────────────────────────────────────────────────────────
 ▾ Auth renewal                        ▰▰▰▰▰▱▱▱ 5/8    12m 40s
   ✓ Token rotation                            3/3      6m 02s
   ▾ Session cleanup                           2/3      4m 11s
     ✓ Move the old table                               1m 30s
     ✓ Remove the cron                                    41s
     ⏵ Update the tests                                 2m 00s
   ○ Documentation                             0/2
──────────────────────────────────────────────────────────────
 ▸ Ship the release · general-purpose  ▰▰▰▰▰▰▱▱ 3/4     3m 05s
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
| A background shell's end | The notification row's own fields (`UserMessage`, `origin.kind: 'task-notification'`, `props.task`: `id`, `status`), and `classic.Stop`'s `background_tasks` | Checked, see below |
| Subagents | `agent.spawn`, `$.agent.list()` | Known |
| Runs | The feeds below | |

There is no call that lists running tasks, so background shells are tracked from events.

## Effort

A click on the meter raises the level one step: low, medium, high, xhigh, max, then back to low. The mod does it by rewriting `effort` on the main thread's `turn.step`. Subagents keep their own. `/effort` hands control back to Claude Code from the next request.

## Runs: the feeds, one tree

Three were designed. The third, a JSONL file, was built and then taken out: see [Built](#built).

| Feed | Who uses it | Cost to the agent |
| --- | --- | --- |
| Claude Code's own `TaskCreate` and `TaskUpdate` calls, watched | The agent, as it already does | None; a flat list |
| The mod's tool, two calls: `plan` and `step` | The agent, when the job has levels | One call to start, a few tokens per change |
| A JSONL file | Scripts, CI, a deploy script | For work outside the agent |

Rules that keep the agent's cost low:

- **The plan comes once, as indented text.** The mod gives each line an id from its place: `1`, `1.2`, `1.2.1`.
- **The agent updates leaves only.** `step("1.1.2", "start")`. A parent's state and count come from its children.
- **Starting a step ends the ones still running before it** in the plan, so most changes are one call. (First built as "under the same parent"; a subagent's trial run left a step running when it moved on to the next branch, so the rule was widened.)
- **The mod keeps the time.** The agent never sends one.

Each `plan` is its own run. A run a subagent opened carries that agent's name.

The tool is a setting that defaults to off.

A subagent sees the mod's tool as the main thread does (checked, see below), so a subagent's run comes from the same two calls.

## What it reads that the other mods do not

`description` of a `Bash` call, or the first line of its `command` where it has none, kept in memory only as the row's title. Nothing of it goes to disk or to the network. README and PRIVACY.md say so. It reads no prompt's text, a task notification's included: see [Checked](#checked).

## Order

1. **0.1** The label, the pane, the model, the clickable effort meter, shells and agents, recent.
2. **0.2** The tree, watching `TaskCreate` and `TaskUpdate`, the `plan` and `step` tool.
3. **0.3** The JSONL feed (taken out in 0.5).

## Built

0.1, 0.2 and 0.3 are built as above, with these choices made on the way:

- **The label is a button on a row of its own** under the hint line where there is a pointer, as pomodoro's row is: the hint line's own tail is text and cannot be pressed. Elsewhere it is the tail.
- **The meter hands the effort back** when a step lands on Claude Code's own level, and by `/deck effort auto`, besides `/effort`. Its mark is `⟳` while the deck sets the effort and `↑` while Claude Code does.
- **The file feed is gone** (0.5). It was built as 0.3 and taken out: a file belongs to a folder, not to a session, so a script's run showed in sessions it had nothing to do with, first in every project and then in every session of one. What a run shows is what happens in its session; a script's stages are shown by the agent that runs it, through the tool. The mod reads no file again. As first built: the feed read `.deck/*.jsonl` at the session's project root: a `run` line with the plan, then `step` lines. README has the format. It first read `~/.deck`, which put one script's run into every session of every project; a run belongs to the session whose work it is, and the project folder is the nearest a script can name.
- **Any agent uses the mod, with nothing written into its definition.** With Tool for Claude on, `plan` and `step` are listed for the main thread and for every subagent of any type, and one note tells each agent they are there: a section of the main thread's system prompt, and a line at the end of every subagent's task. Descriptions alone did not do it: on a machine with 500 tools both are listed by name only, and an agent given a three-stage job with no word of the deck called neither. No agent is named anywhere in the mod, and none has to be changed for it. The limit is Claude Code's: an agent whose definition lists its `tools` without these two is refused them. Work that is no agent at all, a script, reports through the file feed.

## 0.4

Added after the first trial in a real session, at the person's word:

- **Clear**: `/deck clear`, a button, a `clear` tool for the agent, and half an hour by itself.
- **Rows open**: a shell's command, an agent's model and effort; a background job can be stopped from there.
- **An agent's run sits under the agent's row** while the agent runs.
- **Toasts** for a background job's end, a failed step and a finished run; **a mark while Claude Code waits** on the person; **cost and limits** under the model.
- **History**, off by default: the one thing that puts the session's rows on disk.
- **The tree costs an agent less**: the plan starts its first step, a subagent's last step ends with its answer, and the note says to skip a short job. The first trial spent 6 of 11 calls on the tree for a three-stage job.

## 0.6

A pass over what a day of additions had left, taking out what earned no place:

- **Out**: history on disk (the one thing that broke "nothing is written"), the `clear` tool (a command, a button and half an hour already clear), the mark for a pending permission (Claude Code shows that itself), and `/deck effort` (the meter and `/effort` are enough).
- **One run a loop**: a plan takes the place of the task list its loop was following, so one job is not shown twice.
- **`/clear` clears the deck's runs** with the conversation they belong to.
- **What an agent starts sits under the agent's row**: its shells and agents, as its run did already.
- **The kind column says `shell` or `agent`** and nothing else; an agent's model is in its opened row.
- The effort meter can still differ from what Claude Code's own display says: a mod can rewrite a request's effort, not Claude Code's setting. `⟳` marks that case.

## 0.7

- **Transcript rows**: under the conversation's one line for a group of tool calls, a row for each shell command of the group, matched by the call's id. The group's own line is kept, other tools are passed by, and an expanded group is left alone. On by default.
- **The label shares a row** another mod drew under the hint line, has a close mark, and draws the effort in its level's color.
- **The model follows `/model`** within two seconds; usage comes from Claude Code's own measure event.

## 0.8

**GitHub checks**, a setting that defaults to off: the deck follows the checks of a pull request, a workflow run, a branch or a commit, and shows them as a run. It came from one case, an agent that ends its answer with "the CI is running again; I will merge when it passes", and is built for any check GitHub lists.

- **A watch is a run** of a third feed, `checks`: a check is a step, and a workflow run's jobs have their steps under them. So the tree, the folds, the label's count, the toasts and the clearing are the ones a plan has, and the pane gained no section.
- **Two questions a poll, the same for every target.** A pull request is asked for as the commit `pull/N/head`, so it, a branch and a commit are one case: the commit's check runs, and its statuses, which is where services outside Actions report. A workflow run is the other: the run, and its jobs.
- **`gh api` first, the API itself second.** The answers are GitHub's REST JSON either way, so one reader serves both. With `gh` the mod holds no token and any host `gh` is signed in to works. Without it the mod asks `api.github.com` alone, with `GH_TOKEN` or `GITHUB_TOKEN` where set: a token of the environment must not go to a host an address names.
- **Over means over twice** for a commit's checks: a workflow that starts after another ends adds its checks late, and one poll between the two would call it done.
- **`wake`**: the tool's one switch. The deck submits a prompt when the checks are over, so the agent that asked ends its turn and leaves no shell polling. Without it an agent has no reason to call the tool over `gh pr checks --watch`.
- **A watch does not wait for good** (0.8.1): it is given up when no check shows up in ten minutes, when none moves for half an hour, after two hours in all, or after five polls GitHub did not answer; a question to GitHub is cut at 20 seconds. Each end is told, to Claude too where it asked. A poll is every 30 seconds: 15 spent a tenth of an account's hourly requests on one watch.
- **Not built**: starting a watch by itself from a `git push` or a `gh pr create` the deck sees. The command's first line is read already, but which push has checks worth a row is the agent's to know.

- **The effort's button keeps its width** (0.8.2): the level's name is drawn as wide as the longest, `medium`, in the label and in the pane. It came from a report that the label stayed at `max` where the pane went on to `low`, with one function behind both. The reading, from the code and not yet seen in a live session: a button is pressed on its own cells alone, and the label's was the name, so from `xhigh` to `max` it lost two cells and a pointer on the name's fourth or fifth cell was then on nothing; the pane's button also holds the mark, and kept those cells. The engine's tests press by key, with no pointer, so they passed all along.

Also in 0.8: a pane that Claude Code keeps waiting undrawn (opened where it had no room) is no longer taken for an open one. A press on the label closed such a pane, the next opened it to wait again, and nothing was drawn or said. Now the press opens it, and a toast gives Claude Code's reason where it still waits. A press on a transcript row asks for the pane before anything else.

## Checked

Both on 2026-10-05 with Claude Code 2.1.289: a throwaway mod that logged every event under `claude -p`, then 0.1 itself in an interactive session.

**A background shell's end is in the events, and no text has to be read for it.**

- The `Bash` call's result carries `backgroundTaskId` when the command went to the background: with `run_in_background`, and also when a timeout or ctrl+b moved it there.
- When the shell ends, Claude Code adds a notification row to the conversation. Its `ui.render` (`UserMessage`, `origin.kind: 'task-notification'`) carries `props.task`: the same `id`, and `status` (`completed`, `failed`, `killed`). The mod reads those two fields and passes the row on as it came. Checked in an interactive session, fullscreen terminal: a shell that failed and one that completed during a turn, and one that completed after the turn in an idle session, were each listed with the right mark.
- The same end also arrives as `prompt.submit` with `origin.kind: 'task-notification'`, whose text is the engine's envelope (`<task-id>`, `<status>`, a summary that quotes the command). **The mod does not use it**: reading it would be reading a prompt's text, which the row's fields make unnecessary. The cost: with no surface drawing rows (`claude -p`) an end is seen only through `classic.Stop`, without its status. Nothing draws the deck there either.
- The notification is delivered late while a turn runs: a shell that ended 3 s into a 14 s foreground command was reported when that command returned. `props.task.durationMs` would give the true length, but the rows of background shells did not carry it in this build. So a background shell's time runs until Claude Code reports its end; where a row does carry the length, the mod takes it.
- `classic.Stop` lists what still runs in `background_tasks`, each with the same `id`, `type: 'shell'`, `status`, `description` and `command`. Only the ids are read. A shell the mod tracks that is neither there nor reported has ended without a notice (its session was cleared, say), and is closed with no status.

**A subagent sees the mod's tool.** A `general-purpose` subagent found `mcp__probe__ping` as the main thread did (deferred behind `ToolSearch` on this machine, where 500 tools are listed) and called it; the `tool.call` carried the subagent's `agentId`. So `plan` and `step` work inside a subagent, and the run is named from `$.agent.list()` by that id.

Seen on the way, and used:

- `turn.step` carries `effort` as a level (`xhigh`) on a model that takes one and leaves it out on one that does not (Haiku 4.5): the meter is drawn dim there and a click does nothing.
- `TaskCreate` answers `{ task: { id, subject } }`, `TaskUpdate` `{ success, taskId, statusChange: { from, to } }`; the ids are small numbers, per list.
- A foreground subagent ends with `turn.complete` carrying its `agentId`, before its `Agent` call returns.
