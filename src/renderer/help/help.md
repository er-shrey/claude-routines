# Claude Routines

Claude Routines runs Claude Code tasks for you on a schedule. Each **routine** is a prompt or skill file plus a schedule. When the schedule fires, the app runs Claude Code in the background, keeps the full transcript, and asks you before Claude uses any tool you haven't allowed. Runs use your own Claude subscription, not an API key.

New here? Read [Getting started](#getting-started), then [Create a routine](#create-a-routine).

## Getting started

### What you need

- **A Mac with Apple Silicon** (M1 or later).
- **Claude Code installed.** In Terminal:

  ```bash
  npm install -g @anthropic-ai/claude-code
  ```

- **Claude Code signed in with your Claude account** (Pro, Max, Team or Enterprise). Run `claude` in Terminal and type `/login`. Routines use this sign-in, which is separate from the Claude desktop app's.
- **The tools your routines use**, such as `git`, `jq` or `gh`, plus any Claude Code plugins and skills they call.

### Install

1. Open the `.dmg` and drag **Claude Routines** into **Applications**.
2. Open the app. The app isn't signed by Apple, so macOS blocks it the first time. Go to **System Settings → Privacy & Security**, scroll down and click **Open Anyway**. (On older macOS, right-click the app and choose **Open**.)
3. Allow notifications when asked. That's how approval requests reach you.

### Check your setup

Open **Settings → Claude Code**. You should see **Installed** and **Signed in: Yes**.

![Settings showing Claude Code installed and signed in](help/img/settings-claude.png)

If it says *Not found*, set the path to `claude` (run `which claude` in Terminal to find it). If it says *Signed in: No*, see [Troubleshooting](#troubleshooting).

> The app finds your `claude` path and your shell's `PATH` when it first opens. If you install new tools later, click **Detect from login shell** and **Save**.

## Create a routine

Click **+ New routine** in the sidebar.

![The routine editor](help/img/editor.png)

### Basics

- **Name** and **Description**: shown in the sidebar and in notifications.
- **Working directory**: the folder Claude runs in. Claude loads that folder's `CLAUDE.md`, `.claude/settings.json`, project MCP servers and skills, and treats files inside it as the project. Pick the repo the task is about.

### Prompt or skill

Write what Claude should do, in plain language or Markdown. Three ways to add it:

- Type or paste it into the box.
- Click **Upload .md** and choose a file.
- Drag a `.md` file, such as a `SKILL.md`, onto the box.

If the file starts with YAML frontmatter (`name:` and `description:`), those fill in the name and description. The frontmatter is removed before the prompt is sent.

You can call **plugin commands and skills** in the prompt, for example `/loop:eng-pr-review <url>`, or just ask Claude to use a skill by name. See [Plugins, skills and connectors](#plugins-skills-and-connectors).

> Routines run with nobody watching. Write prompts that never need a reply. For example: *"Never ask questions; if something is unclear, skip it and say so in the summary."*

### Save

Click **Create routine**. The schedule is installed straight away. Click **Run now** on the routine's page to try it without waiting.

## Schedules and pre-checks

![Schedule and pre-check settings](help/img/editor-schedule.png)

### Schedule types

- **Every N minutes**: for example every 5 or 30 minutes. No minimum.
- **At a time of day**: a time, plus the weekdays to run on. Select no days to run every day.

Schedules keep running when the app is closed. They're handled by macOS (launchd), so they **don't run while your Mac is asleep**. A missed time-of-day run starts when the Mac wakes up.

### Runs never overlap

If a run is still going when the next one is due, the new one is skipped and the routine's page shows *Previous run still in progress*.

### Pre-check: skip runs that have nothing to do

A **pre-check** is a shell command that runs before Claude starts. If it exits with an error (non-zero), the run is skipped and **uses none of your usage**. If it succeeds, anything it prints is added to the end of the prompt.

This is the best way to make frequent schedules cheap. Examples:

| Goal | Pre-check |
|---|---|
| Only on weekdays, 9:00–20:00 | `[ "$(date +%u)" -le 5 ] && [ "$(date +%H)" -ge 9 ] && [ "$(date +%H)" -lt 20 ]` |
| Only when a file changed recently | `test -n "$(find ./reports -newer .last-run -print -quit)"` |
| Only when there are open PRs (GitHub) | `test -n "$(gh pr list --json number -q '.[]')"` |

The routine's page shows the last pre-check and the last skip, with the reason.

## Permissions and approvals

Claude Code asks before it uses tools that can change things or reach outside the project. Because no one is watching a scheduled run, the app handles those questions for you.

![A run waiting for approval](help/img/run-waiting.png)

### How it works

1. Tools in the routine's **Allowed tools** run without asking.
2. Tools in **Disallowed tools** are always blocked.
3. Anything else **pauses the run** and asks you. You get a macOS notification. The run shows **waiting for approval**, and the request appears on the run's page and on **Approvals**.
4. Choose:
   - **Allow once**: allow this one call.
   - **Always allow this rule**: allow it now and add the rule (which you can edit first) to the routine, so it won't ask again.
   - **Deny**: block it. Claude is told it was denied and carries on without it.
5. If you don't answer within the **approval timeout** (10 minutes by default), the call is denied automatically.

![The Approvals page](help/img/approvals.png)

### Writing allow and deny rules

Put one rule per line.

| Rule | Meaning |
|---|---|
| `Read`, `Grep`, `Glob` | Read and search files |
| `Skill` | Use skills and plugin commands |
| `Bash(gh pr list:*)` | Bash commands that start with `gh pr list` |
| `Bash(/full/path/script.sh meta:*)` | One subcommand of a script |
| `Edit(//Users/you/notes/**)` | Create and edit files under that folder (note the **two** leading slashes for an absolute path) |
| `Read(//Users/you/.secrets)` | Reading that file (use under *Disallowed* to block it) |
| `Bash(*credentials*)` | Any Bash command mentioning "credentials" (good under *Disallowed*) |
| `mcp__claude_ai_Slack__slack_read_channel` | One MCP tool |
| `AskUserQuestion` | Under *Disallowed*: stops Claude trying to ask you questions, which can't be answered in a scheduled run |

Tips that save a lot of approvals:

- **A Bash command that chains steps** with `|`, `&&`, `;` or `>` is checked part by part, and a script called through a variable (`"$S" ...`) can't be matched at all. Ask in the prompt: *"Call scripts by their full path and run one command per Bash call."*
- After a run, its page lists any **denied tool calls**. Tick the rules you want and click **Allow selected and re-run**.

### Why there's no "allow everything" switch

Routines often read text written by other people, such as Slack messages, PR descriptions and tickets. With every tool allowed and nobody watching, an instruction hidden in that text could make Claude run any command on your Mac. Allow-rules plus approvals keep you in control of anything risky, such as posting comments, sending messages or deleting files.

## Runs

Each routine's page lists its runs, newest first.

![A routine's page with its run history](help/img/routine.png)

### Statuses

| Status | Meaning |
|---|---|
| **running** | Claude is working |
| **waiting for approval** | Paused until you allow or deny a tool call |
| **success** | Finished normally |
| **error** | Finished with a problem. The run page says why. |
| **timeout** | Took longer than the routine's *Run timeout* |
| **stopped** | You clicked **Stop** |

### The run page

Click any run to open it.

![A finished run with its result and transcript](help/img/run.png)

- **Result**: Claude's final answer.
- **Denied tool calls**: with **Allow selected and re-run**.
- **Transcript**: every message and tool call. Click a tool call to see exactly what was sent and what came back.
- **Prompt sent and command**: the exact prompt (including pre-check output) and the `claude` command line.
- **Open run folder**: the raw files for that run.

When a run fails, the page says why in plain words:

![A run that stopped at the max turns limit](help/img/run-error.png)

## Settings

Settings apply to every routine.

### Claude Code

The `claude` path, the `PATH` that scheduled runs use, and whether Claude Code is installed and signed in. See [Getting started](#getting-started).

### Variables & secrets

![Variables and secrets](help/img/settings-secrets.png)

- **Variables** are added to every run's environment, so prompts, scripts and pre-checks can use them (for example a repo path).
- **Secrets** (tokens, passwords) are stored in your **macOS Keychain**, never in a file. A secret is only filled into MCP server settings that reference it as `${NAME}`. Turn on **Expose to shell** only if a script must read it from the environment, because anything in the environment can be read by Claude's Bash commands.
- **Import .env file…** reads `KEY=VALUE` lines from a file. Names containing PASS, TOKEN, SECRET, KEY, AUTH or CREDENTIAL are saved as secrets; the rest become variables.
- To keep schedules signed in for a year, run `claude setup-token` in Terminal and save the token as a secret named `CLAUDE_CODE_OAUTH_TOKEN`.

### MCP servers

![MCP servers with a connection test](help/img/settings-mcp.png)

- Servers here are added to **every** run. You **don't** need to add connectors from your claude.ai account (Slack, Atlassian…) or servers you added with `claude mcp add`. Those load by themselves.
- **+ Add server**: choose *stdio* (a command) or *http* (a URL), and use `${NAME}` for tokens, for example `Authorization: Bearer ${JIRA_TOKEN}`.
- **Import JSON**: paste an `mcpServers` block from Claude Code or Claude Desktop.
- **Test** connects to the server and lists its tools. **Check with Claude Code** runs `claude mcp list`, which checks every server Claude Code would load from a folder, with tokens masked.
- The switch on each server includes or excludes it from runs.

### Routine defaults

![Defaults for new routines](help/img/settings-defaults.png)

Permission mode, allowed and disallowed tools, model, max turns, timeouts and notifications that **new** routines start with. Changing these doesn't affect existing routines.

### Data

Where the app keeps its files, and **Reinstall schedules** if schedules ever stop firing.

## Plugins, skills and connectors

Scheduled runs load the same things as `claude` does in Terminal:

- **Plugins** installed for your user, with their commands and skills. Call them as `/plugin:command args` or ask Claude to use the skill.
- **Skills** in `~/.claude/skills` and in the working directory's `.claude/skills`.
- **claude.ai connectors** (Slack, Atlassian and others) connected to your Claude account.
- **MCP servers** you added with `claude mcp add`, project servers you've already approved for the working directory, and servers in **Settings → MCP servers**.

Add the tools they need to the routine's **Allowed tools** (for example `Skill` and the connector tools you use), or approve them once with **Always allow**.

## Usage and billing

- Runs use **your Claude subscription**, the account Claude Code is signed in with. `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are always removed from runs, so nothing is billed to the API.
- Runs count toward your plan's usage limits, the same as using Claude yourself. The cost shown on each run is an estimate of that usage.
- To use less:
  - Add a [pre-check](#schedules-and-pre-checks) so runs with nothing to do are skipped.
  - Run less often.
  - Pick **Haiku** or **Sonnet** for simple routines (Edit → Advanced → Model).
  - Keep **Max turns** sensible: 15 for small tasks, 50 for reviews of large changes.

## Troubleshooting

**"Failed to authenticate… OAuth access token has been revoked" or "Signed in: No"**
Claude Code's sign-in expired or was signed out. Run `claude` in Terminal and type `/login`. To stop it happening on schedules, run `claude setup-token` and save the token as the secret `CLAUDE_CODE_OAUTH_TOKEN`.

**A run stays on "waiting for approval"**
Open the run and answer the request. To stop it asking next time, use **Always allow this rule** or add the rule to *Allowed tools*. If it's trying to ask you a question (`AskUserQuestion`), add that to *Disallowed tools* and tell it in the prompt not to ask questions.

**"Stopped after reaching the max turns limit"**
The task needed more steps. Edit the routine and raise **Max turns** (Advanced).

**A tool error such as "File content exceeds maximum allowed tokens" in the transcript**
Usually harmless. Claude tried to read too much at once and retries in smaller pieces. Only act if the run fails.

**"command not found" for git, jq, gh or node**
Scheduled runs only see the `PATH` saved in **Settings → Claude Code**. Click **Detect from login shell**, then **Save**.

**macOS asks whether the app can access Documents, Desktop or Downloads**
Click **Allow**. Routines whose working directory is in those folders need it.

**A schedule isn't firing**

- Check the switch on the routine's page. It must be on, not *Paused*.
- The Mac must be awake.
- If you moved the app, open it once. Or use **Settings → Data → Reinstall schedules**.
- **Scheduler log** on the routine's page shows each start and finish.

**Something else**
Open the run, check **stderr** at the bottom, and use **Open run folder** for the raw files.

## Sharing and uninstalling

### Sharing the app

Send the `.dmg`. Each person needs everything in [Getting started](#getting-started), with their own sign-in. Their routines, history, settings and secrets are their own. Nothing is shared between Macs. A routine that uses paths like `/Users/you/...` must be adjusted for their Mac.

### Uninstalling

1. Delete each routine in the app (this removes its schedule), or remove all schedules in Terminal:

   ```bash
   for f in ~/Library/LaunchAgents/com.claude-routines.*.plist; do launchctl bootout gui/$(id -u) "$f"; rm "$f"; done
   ```

2. Quit the app and drag it from **Applications** to the Bin.
3. Optional: delete your routines and history with `rm -rf ~/.claude-routines`, and delete saved secrets in **Keychain Access** by searching for `claude-routines`.

## Where data lives

```
~/.claude-routines/
  config.json        settings (no secret values)
  routines/<id>/     routine.json, prompt.md, state.json
  runs/<id>/<run>/   meta.json, events.jsonl (transcript), stderr.log, prompt.md
  approvals/         pending requests and your answers
  logs/<id>.log      scheduler log
~/Library/LaunchAgents/com.claude-routines.<id>.plist   one per enabled routine
Keychain: service "claude-routines"                     your secrets
```
