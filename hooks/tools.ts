// The two tools the model can call, for a person who turned them on. Here
// only as the model reads them: the hooks module serves them. Their words
// are in every request's context, so they are kept short.

import type { ToolSpec } from 'claude-code'

/**
 * What tells an agent the tools are there. Where many tools are listed, the
 * model sees these two by name only and reads their descriptions only once
 * it loads them, so the descriptions alone bring no agent to call them. With
 * the setting on, this goes into the main thread's system prompt and at the
 * end of each subagent's task.
 */
export const NOTE =
  'The person follows progress in a pane called Deck, which shows them the title and steps of a plan and the description of each shell command you run. They read these to understand what is happening: write them in the language the person writes in. If you have the tool mcp__deck__plan and this job will take more than a couple of minutes or more than three stages, call it once as you begin with three to six steps (load it and mcp__deck__step with ToolSearch if their schemas are not loaded); its first step starts by itself, so call mcp__deck__step only as you move to the next one. Skip it for a short job: each call costs the person a round trip.'

/** The note's id among the system prompt's sections. */
export const NOTE_SECTION = 'deck:plan'

export const WORDS = ['start', 'done', 'fail'] as const

export const TOOLS: readonly ToolSpec[] = [
  {
    name: 'plan',
    description:
      "Shows your job's steps to the person as a live progress tree. Call it once, as you begin a job of several stages, whichever agent you are; skip it for a short job. The first step starts by itself. Answers each step's id (1, 1.2, 1.2.1).",
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'The job, in a few words' },
        steps: {
          type: 'string',
          description: 'One step a line; indent a step under its parent with two spaces',
        },
      },
      required: ['title', 'steps'],
    },
  },
  {
    name: 'step',
    description:
      'Updates one leaf step of the plan. start also ends any step still running before it in the plan, so moving on needs only start. The last step of a subagent is done by itself when it answers; the main thread marks its last step done. Parents follow their steps; times are kept for you.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The leaf step, as plan answered it: 1.2.1' },
        state: { type: 'string', enum: WORDS },
        run: { type: 'string', description: 'Only with several plans open: the run plan answered' },
      },
      required: ['id', 'state'],
    },
  },
]
