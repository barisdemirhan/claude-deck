# Privacy

What the Deck mod for Claude Code does with data. Last changed on 5 October 2026.

## Out of the box

Nothing leaves your machine. The mod makes no network request, and has no server, no account and no analytics. Nothing is sent to the author of this mod. It reads no files, writes none and runs no processes.

It reads more of Claude's work than a mod usually does, to name the rows of its pane:

- Of each `Bash` call, its `description`, cut to 80 characters, and the first line of its `command`, cut to 200. Of the call's result, whether it failed, whether it was interrupted, and the id of the background task it became. Not its output.
- Of a group of tool calls the conversation draws as one line, which of its calls are shell commands, and of those the id, the state, and the same description and first line of the command. Of the group's other calls, the tool's name only.
- Of each `TaskStop` call, the id of the task that was stopped.
- Of each `TaskCreate` call, the new task's id and its subject, cut to 80 characters. Of each `TaskUpdate` call, the task's id, its new status and, when it changes, its subject. Not a task's description.
- Of each subagent, its type, its name, the few words its call names the task with, and how its turn ended.
- Of each model request, the model, the effort, and whether a subagent made it.
- Of the row Claude Code draws when a background task ends, the task's id, how it ended and how long it ran. Not the row's text.
- When Claude stops, the ids of the background tasks still running.
- From Claude Code, the main thread's model, how full the context window is, what the session cost, and how full its rate limits are.

It reads nothing of a prompt's text, of any other tool's call, or of an answer.

What it reads stays in the session's memory: the titles and times of the shells and agents that run and of the last eight that ended, the last six runs with their steps' titles and times, what you folded, the model, and the effort you set. Out of the box none of it is written to disk, and it is gone when the session ends; what is over leaves the pane after half an hour. While the deck is closed with `/deck close`, it reads none of it.

In the plugin's own Claude Code store, on your disk, it keeps two values: whether you closed the deck with `/deck close`, and whether you closed the label's row.

## What it changes

Two things, each only after you ask. A press on a row's `■ stop` asks Claude Code to stop that one background task. After a press on the effort meter, the mod sends the main thread's model requests at that effort in place of Claude Code's own, from the next request on. A subagent's requests are never changed. `/effort` with another level, `/deck close` or the session's end stops it.

With **Tool for Claude** on (it is off until you turn it on), it also adds one fixed note saying its two tools are there: as a section of the main thread's system prompt, and at the end of the task each subagent is given. The note's words are in the README. It holds nothing of yours.

It never changes the prompt you type, a tool call or a tool's result.

## What reaches Claude

What `/deck` answers is a row of the conversation, as any command's output is, and Claude reads it with the rest: one fixed sentence saying what the command did. It carries no title of a shell, an agent or a step. Out of the box the mod gives Claude no tool.

With **Tool for Claude** on (it is off until you turn it on), Claude can call the mod's `plan` and `step` tools. What Claude sends them, a job's title and its steps, is kept in the session's memory as a run. What they answer goes into the conversation: the steps Claude itself sent, each with its id, and how many are done.

## What you turn on

Each of these is off until you turn it on in the plugin's settings:

- **Tool for Claude** lists the `plan` and `step` tools for Claude, as told above.

## Taking your data off

What the mod keeps on your machine is one JSON file, the plugin's store: `~/.claude/plugins/store/deck_<marketplace>-<id>.json`, which is `deck_claude-mods-1f3bccb355da.json` when installed from `claude-mods`. That is where Claude Code 2.1.289 keeps it; the place is Claude Code's own and may change with it. Deleting the file with no session open takes it all off.

If something here is unclear or wrong, [open an issue](https://github.com/barisdemirhan/claude-deck/issues). To report a security problem in private, see [SECURITY.md](SECURITY.md).

## Changes

This file's history in the repository is the record of what changed and when.
