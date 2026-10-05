# claude-deck

A pane beside the conversation in [Claude Code](https://claude.com/claude-code) for the work behind it: the shells and agents that run, the model, an effort meter you can press, and the steps of each job as a tree.

Type `/deck`, or press its mark, `◨`, under the prompt:

```
 Fable 5.1  ▰▰▰▱▱ high ↑                          ctx ▰▰▱▱▱▱▱▱ 23%
 ──────────────────────────────────────────────────────────────
 SHELLS · 2
 ⏵ Typecheck, test and lint                              1m 12s
 ⏵ npm run dev                                           14m 03s
 ──────────────────────────────────────────────────────────────
 AGENTS · 1
 ⏵ general-purpose(Ship the release)                        48s
   ⏵ Build the package                                      12s
 ──────────────────────────────────────────────────────────────
 ▾ Auth renewal                        ▰▰▰▰▰▱▱▱   5/8   12m 40s
   ✓ Token rotation                               3/3    6m 02s
   ▾ Session cleanup                              2/3    4m 11s
     ✓ Move the old table                                1m 30s
     ✓ Remove the cron                                      41s
     ⏵ Update the tests                                  2m 00s
   ○ Documentation                                0/2
 ──────────────────────────────────────────────────────────────
 ▸ Ship the release · general-purpose  ▰▰▰▰▰▰▱▱   3/4    3m 05s
 ▸ ✓ Parser refactor                   ▰▰▰▰▰▰▰▰   6/6    9m 17s
 ──────────────────────────────────────────────────────────────
 RECENT
 ✓ npm run build                                shell    2m 03s
 ✗ pytest -k auth                               shell        8s
```

## Install

```sh
claude plugin marketplace add barisdemirhan/claude-mods
claude plugin install deck@claude-mods
```

Restart Claude Code, then run `/deck`.

The same two steps work from inside a session with `/plugin marketplace add barisdemirhan/claude-mods` and `/plugin install deck@claude-mods`.

[claude-mods](https://github.com/barisdemirhan/claude-mods) is one marketplace for all of these mods, so its first line is needed once for the lot.

### If you installed from `claude-deck`

Nothing has to change. This repository is a marketplace of its own too, and `deck@claude-deck` goes on getting updates. Keep one of the two installs, not both: with both on, every hook runs twice.

## Use

| Command | What it does |
| --- | --- |
| `/deck` | Opens the pane, or closes the open one. `/deck open` only opens it. It asks for 52 columns beside the conversation; a width you drag it to stands |
| `/deck clear` | Takes what is over out of the pane: the ended shells and agents, and the runs that finished or stopped. What still runs stays |
| `/deck row` | Keeps the label as text on the hint line, or brings its row back. The row's `×` does the first. Every open session follows within two seconds |
| `/deck close` | Takes the deck away in every open session within two seconds: the label, the pane, the reading of shell calls and the effort it set. `/deck exit` and `/deck quit` do the same; `/deck` brings it back |

### The label

Under the prompt the deck keeps one label: the model, its effort, how many shells and agents run, and the job under way with its steps done.

```
? for shortcuts
◨ Fable 5.1 ▰▰▰▱▱ high · ⏵ 3 · Auth renewal 5/8 ×
```

Where there is a pointer, the terminal's fullscreen layout or the desktop app, the label is a row of its own right under the hint line, and it begins with the deck's mark, `◨`: a press on it opens or closes the pane, and so does a press on the run at the row's end. The model's name between them is plain text. Its effort is drawn in its level's color, and a press on the level's name steps it up, as on the pane's meter. What runs has the color of a running row, a failed step's `✗` is red, the rest is dim. `×` closes the row: the label is then text on the hint line. Where another mod has already drawn a row of its own there, the label joins that row at its end, so the two take one row between them. The model follows `/model` within two seconds; its effort shows again with its first request. On the terminal's main screen it is text at the end of the hint line. The **Hint label** setting keeps it text everywhere, or takes it off.

### The pane

| Part | What it shows |
| --- | --- |
| The first rows | The main thread's model, its effort meter, and how full the context window is. Under them what the session cost and how full each rate limit is (`$1.24 · 5h 34% · 7d 12%`) |
| `SHELLS` and `AGENTS` | Each shell command and each subagent that runs now, in a section of its own, with how long it has run. A title too long for its row is cut with `…`. A shell is named by what its call says it does, or by the first line of its command where the call says nothing; a subagent by its type and task, as `general-purpose(Ship the release)`. What a running agent started, its own shells and agents and the run it opened, is drawn under its row |
| The runs | Each job's steps as a tree, between the two lists. See below |
| `RECENT` | The last eight that ended: `✓` done, `✗` failed, `■` stopped, `·` ended with no word on how. A foreground command that went well in under three seconds is left out |

A press on a row's title opens its detail under it: a shell's command, its first line, or an agent's model and effort. Where the job runs in the background, the detail has a `■ stop` button, which asks Claude Code to stop that task as its own TaskStop tool does. `× clear` on the pane's last line does what `/deck clear` does. What is over also leaves the pane by itself after half an hour.

A shell that Claude runs in the background, or that a timeout or ctrl+b moves there, stays under `SHELLS` until Claude Code reports its end. That report waits for the tool call Claude is in, so a background shell's time can read longer than it ran.

### Transcript rows

Where Claude Code folds a run of tool calls into one line of the conversation, the deck adds a row under it for each shell command of the group:

```
Ran 3 shell commands
  ✓ Check the version           2s
  ✗ Verify the profile          8s
  ⏵ Restart the daemon         14s
```

Each row is that call's own: matched by the call's id, in the order Claude made them, with the state the transcript gives it. A command that went to the background keeps `⏵` and its time until it ends. A press on a title opens the pane with that command's row open. Past four commands the rest are counted, `+2 more`. Claude Code's own line stays as it is, other tools get no row, and a group you expand with ctrl+o is left alone. The **Transcript rows** setting turns them off.

### Runs

A run is one job's steps, with how many are done and how long each took. The deck keeps the last six. When the subagent that opened a run ends, the run's clock stops and a step it left running goes back to waiting.

A loop shows one run at a time: when an agent opens a plan, the task list it was following leaves the pane, and its later tasks open none while the plan is under way. `/clear` takes every run away with the conversation.

- **Claude Code's own task list** shows as a run by itself: when Claude makes tasks and moves them along, as it already does, each task is a step. A list is flat, one level.
- **A plan with levels** needs the **Tool for Claude** setting, below.

The run under way is open, and the others are one row each. Inside a run, a branch is open while it is under way and folds by itself before it starts and once it is over. A press on a row's mark folds or unfolds it: `▾` open, `▸` folded. A step that failed is a red `✗`, and so is every branch above it, so a folded run still shows it. A run a subagent opened carries the agent's name: `Ship the release · general-purpose`.

Only the steps at the ends of the tree have a state. A branch's state, its count and its time come from the steps under it.

### Tool for Claude

With **Tool for Claude** on, Claude can call two tools:

- `plan` takes a job's title and its steps as indented text, one step a line, and opens a run. Each line gets an id from its place: `1`, `1.2`, `1.2.1`.
- `step` moves one step: `start`, `done` or `fail`. Starting a step ends any step still running before it in the plan, in the same branch or an earlier one, so moving on is one call. The first step starts with the plan, and a subagent's last step is done by itself when the agent answers, so a job of three stages costs an agent four calls: one to load the tools, the plan, and two moves. The note below also tells agents to skip the tree for a short job. The deck keeps the times; Claude never sends one.

Every agent of the session gets them with that one setting: the main thread and each subagent alike, of any type, with no line added to an agent's definition. So that an agent uses them without being asked, the same setting adds one note, the same words in two places: as a section of the main thread's system prompt, and at the end of the task each subagent is given.

> The person follows progress in a pane called Deck, which shows them the title and steps of a plan and the description of each shell command you run. They read these to understand what is happening: write them in the language the person writes in. If you have the tool mcp__deck__plan and this job will take more than a couple of minutes or more than three stages, call it once as you begin with three to six steps (load it and mcp__deck__step with ToolSearch if their schemas are not loaded); its first step starts by itself, so call mcp__deck__step only as you move to the next one. Skip it for a short job: each call costs the person a round trip.

The note also asks for the words you will read in the pane, a plan's title and steps and each shell command's description, in the language you write in. A tool's description alone does not do this: where many tools are installed, Claude Code lists most by name only, and an agent reads a description only after it loads the tool. You can still ask, "plan this in the deck". The one agent that cannot is one whose definition lists its `tools` and leaves these two out: Claude Code refuses it any other tool. Claude Code asks your permission for them as for any tool, and their descriptions take a little of every prompt's context, which is why they are off by default.

### The effort meter

`▰▰▰▱▱ high` is the effort the main thread's requests go out with, drawn in its level's color: low dim, medium green, high yellow, xhigh orange, max red. Press the level's name and it goes one step up: low, medium, high, xhigh, max, then low again. From the next request on, the deck sends that level in place of Claude Code's own, on the main thread only; a subagent keeps its own. The mark beside the meter is `⟳` while the deck sets the effort and `↑` while Claude Code does.

It lasts for the session, until one of these hands the effort back to Claude Code: `/effort` with another level, a step that lands on Claude Code's own level, or `/deck close`. A model that takes no effort setting shows no meter.

## Settings

In Claude Code's `/config` menu, under the plugin's name:

| Setting | Default | What it does |
| --- | --- | --- |
| Hint label | `button` | `button`: a row under the hint line with parts you can press, where there is a pointer, and text elsewhere. `text`: always at the end of the hint line. `off`: no label |
| Tool for Claude | off | Lists the `plan` and `step` tools for Claude. See above |
| Transcript rows | on | The rows under a group of tool calls in the conversation. See above |
| Toasts | on | A toast when a background job fails or ends after half a minute, when a step fails and when a run finishes |

## Requirements

- A Claude Code build with mod support (plugins that ship a hooks module). Built and tested on 2.1.289. Mods sit behind a rollout switch, so if `/deck` does not show up after installing, the switch may still be off for you.
- The terminal or the desktop app: the label and the pane are drawn only there. A press needs a pointer: the terminal's fullscreen layout or the desktop app. On the terminal's main screen the commands do it all.
- The pane fits its rows to the width it gets: a long title is cut first, and the context meter moves to a row of its own when the first row is full.

## Privacy and data handling

The mod registers one slash command, adds one label under the prompt, adds rows under the conversation's lines for groups of tool calls, and draws its pane when you open it. It reads no files, writes none and runs no processes. Out of the box it changes one thing of Claude's work, and only after you ask: the effort of the main thread's model requests, after a press on the meter. A press on a row's `■ stop` asks Claude Code to stop that one background task. With **Tool for Claude** on it changes one more: it adds the note quoted under that setting to the main thread's system prompt and to the end of each subagent's task. It never changes the prompt you type, a tool call or a tool's result.

**What it reads.** More than the other mods of this marketplace, which read no argument of a tool call:

- Of each `Bash` call: its `description`, cut to 80 characters, as the row's title, and the first line of its `command`, cut to 200, as the row's detail (and its title where the call has no description). Both are kept in memory until the session ends, eight newer rows push the row out, or half an hour passes. Of the call's result: whether it failed, whether it was interrupted, and the id of the background task it became. Not its output.
- Of a group of tool calls the conversation draws as one line: which of its calls are shell commands, and of those the id, the state, and the same `description` and first line of `command` as above. Of the group's other calls, the tool's name only, to pass them by.
- Of each `TaskStop` call: the id of the task that was stopped.
- Of each `TaskCreate` call: the new task's id and its subject, cut to 80 characters and kept in memory as a step's title. Of each `TaskUpdate` call: the task's id, its new status and, when it changes, its subject. Not a task's description.
- Of each subagent: its type, its name and the few words its call names the task with, and when its turn ends, how.
- Of each model request: the model, the effort, and whether a subagent made it. Not the conversation.
- Of the row Claude Code draws when a background task ends: the task's id, how it ended and how long it ran. Not the row's text.
- When Claude stops: the ids of the background tasks still running.
- From Claude Code: the main thread's model, how full the context window is, what the session cost and how full its rate limits are.

It reads nothing of a prompt's text, of any other tool's call, or of an answer.

**What it sends.** Nothing. It makes no network request, and has no server, no account and no analytics.

**What reaches Claude.** What `/deck` answers is a row of the conversation, as any command's output is: one fixed sentence saying what the command did. No title of a shell, an agent or a step is in it. Out of the box the mod gives Claude no tool. With **Tool for Claude** on, it lists two, and what they answer goes into the conversation the same way: `plan` answers the steps Claude itself sent, each with its id, and `step` the step's id and how many are done.

**What it keeps.** On disk, in the plugin's own Claude Code store, one JSON file under `~/.claude/plugins/store/`: whether you closed the deck with `/deck close`, and whether you closed the label's row. Everything else, the rows' titles and times, the runs and their steps, what you folded, the model and the effort you set, is in the session's memory and gone with it.

**Sound.** None.

**Files and processes.** It reads no files, writes none and runs no processes.

[PRIVACY.md](PRIVACY.md) is the same as a privacy policy, with what reaches Claude and how to take your data off.

### Hooks

Its hooks are in `hooks/register.tsx`:

- `session.start` registers the `/deck` command (and with Tool for Claude on, the two tools) and starts the one-second tick that follows another session's `/deck close`, asks Claude Code for the main thread's model and moves the open pane's clock, then passes the event on unchanged.
- `session.end` takes the runs and what is over out of the pane when `/clear` ends the conversation, and passes the event on unchanged.
- `command.run` answers only the `/deck` command. Other commands never reach it.
- `tool.call` on `Bash` notes the call's start, its title and its end; on `TaskStop` the task that was stopped; on `TaskCreate` and `TaskUpdate` the task and its state. Each passes the call on unchanged and answers what Claude Code answered. With Tool for Claude on, two more answer the mod's own `plan` and `step`. A press on `■ stop` raises one `TaskStop` call of the mod's own, for the task of that row. No other tool reaches any of them.
- `agent.spawn` notes a subagent's type, task and id. It passes the spawn on unchanged; with Tool for Claude on, with the note added at the end of the subagent's task, a fork left out.
- `prompt.compose`, hooked only with Tool for Claude on, adds the note as one section after the system prompt's own, which stay as they are.
- `turn.complete` notes the end of a subagent's turn. It passes the event on unchanged.
- `session.measure` reads Claude Code's own figures as they move: the context window's fill, the session's cost and the rate limits. It passes the event on unchanged.
- `classic.Stop` reads which background tasks still run, and passes the event on unchanged.
- `turn.step` reads the model and the effort of each request. For the main thread, while a level you set stands, it passes the request on with that effort; otherwise, and for every subagent's request, unchanged. It passes the response on as it streams.
- `ui.render` adds the label to the end of the hint line, or where there is a pointer draws it as a row under the line, keeping the line and what other mods drew with it. It draws the deck's pane, and only that pane. Under a group of tool calls it adds the shell commands' rows after the group's own line, which it draws as it came; an expanded group it passes on untouched. On a background task's notification row it reads the task's fields and draws the row as it came.

While the deck is closed with `/deck close`, each of these passes its event on without reading it, the two tools answer that no plan is shown, and the note is added nowhere.

The files under `tests/` run only under `claude plugin test`, and are never loaded in a session.

## Develop

```sh
git clone https://github.com/barisdemirhan/claude-deck
claude plugin validate claude-deck
claude plugin test claude-deck
claude --plugin-dir claude-deck
```

`hooks/register.tsx` holds the hooks that tie the mod to Claude Code, and every call it makes on Claude Code: the engine follows `$` into no function of another file. The other files are plain functions it calls:

- `hooks/work.ts`: the shells and agents, running and lately ended.
- `hooks/meter.ts`: the model's name and the effort meter.
- `hooks/runs.ts`: the runs, their steps and the rows they draw as.
- `hooks/tools.ts`: the tools Claude reads, as it reads them.
- `hooks/view.ts`: the label's text and the times.
- `hooks/pane.tsx`: the pane's drawing.
- `hooks/values.ts`: readers for values from outside.

[docs/DESIGN.md](docs/DESIGN.md) is the design, with what was checked against Claude Code before it was built.

## More mods

From the same marketplace, [claude-mods](https://github.com/barisdemirhan/claude-mods):

- [ambient](https://github.com/barisdemirhan/claude-ambient): a living band above the prompt, with sound, fed by Claude's work.
- [dino](https://github.com/barisdemirhan/claude-dino): a T-Rex runner in a pane, with Claude's tool calls as the obstacles.
- [pomodoro](https://github.com/barisdemirhan/claude-pomodoro): a pomodoro timer on the hint line whose break lands while Claude works.
- [tycoon](https://github.com/barisdemirhan/claude-tycoon): Token Tycoon, an idle game where Claude's tool calls earn the money.

## License

MIT
