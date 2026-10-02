---
description: Bind this repository to its bug group (a Telegram group or a Slack channel) and register the project
allowed-tools: Bash(bugs-bot:*)
---

Set this repository up as a bugs-bot project, or update its setup. Ask the
operator ONE question at a time, wait for the answer, and keep the answers for
the single `bugs-bot init` line at the end. Anything he leaves empty is simply
left out of that line; on a re-run, whatever he does not change keeps its
current value.

1. If `.bugs-bot.json` exists in the repository, read it and say what is set;
   this is a re-run, and only what he wants changed is asked.
2. Ask, in this order:
   - the project id (`[a-z0-9-]+`: it names the data directory under
     `~/.bugs-bot/`);
   - the title of the agent session, for example `Agent : <Project> Bugs`;
   - the deployment URL, if the project has one, then optionally a shell command
     that proves a commit is served (`--deploy-check`; none means the launcher
     checks);
   - the documentation the agent answers from: files or directories of this
     repository;
   - the language of the agent's messages in the group (default `fr`);
   - where the group is: Telegram (the default) or Slack — ONE per project.
3. Telegram: ask him to post one message in the new group (the bot must already
   be a member), then wait for him to say it is done. If the bot's Pull is
   running, that message is found in Pull's log of dropped chats; otherwise in
   the bot's pending updates, which are not consumed.
   Slack: ask him to invite the app into the project's channel (`/invite
   @<app>`), then wait for him to say it is done; `init` lists the channels the
   app is a member of.
4. Run the one line, with only the options he gave:

   ```
   bugs-bot init --project <id> --agent-title "<title>" [--channel slack] [--deploy-url <url>] [--deploy-check "<cmd>"] [--docs <path> ...] [--language <l>]
   ```

   Exit 1 with a list means several groups were found: show him the list, ask
   which, and run the line again with `--chat-id <id> --title "<title>"` (a Slack
   channel id is `C…` or `G…`, its title the channel's name). Exit 1 with « no
   group found » means his message was not seen (Telegram) or the app is in no
   free channel (Slack): ask him to post, or to invite the app, again.
5. Report what the command printed: the project file written, the registry line,
   and that the file is kept out of git through `.git/info/exclude`. Then point
   him to `/bugs-bot:doctor` if this machine was never checked, and to
   `/bugs-bot:start` to launch the agent.

The project file is local and never committed. Never print a token.
