# bugs-bot — conformity to the spec

Date: 2026-10-02. Checked against `docs/specs/2026-10-02-bugs-bot-design.md`, section by section,
on the head `95f56c4` (this document is the only change after it). Each claim names the file that
meets it and the test that shows it, or the gap. Items a review already ruled out are not reopened.

Verdicts: **met**, **partly met** (with what is missing), **not testable** (with the evidence that exists).

## Success criteria

| # | Criterion | Verdict | Where, and the proof |
| --- | --- | --- | --- |
| 1 | A second project needs only `/bugs-bot:init` then `/bugs-bot:start`, no code or plugin file changed | met | `bugs_bot/init.py` writes only `<repo>/.bugs-bot.json`, `.git/info/exclude` and the registry; Pull reads the registry every round (`pull.py` `cmd_pull`), so no restart. `tests/e2e.sh` drives two projects through `bin/bugs-bot`; `tests/test_routing.py::test_one_batch_of_two_projects_and_an_unregistered_group_lands_each_where_it_belongs`; `tests/test_guard.py` (no project name in any plugin file). |
| 2 | One bot, one group and one agent per project, one machine, no report lost or delivered twice | met | `registry.py` `Registry.add` (a chat held by another project refused: `test_registry.py::test_a_chat_held_by_another_project_is_refused_and_nothing_changes`); the offset is saved only after every report is on disk (`test_routing.py::test_a_failed_download_in_one_project_keeps_the_offset_and_blocks_no_other_project`, `::test_the_redelivered_batch_does_not_duplicate_what_the_other_project_already_has`, `test_tm_bugs.py::test_pull_retry_after_failure_is_complete_and_not_duplicated`); one Pull checked by `doctor` (`test_doctor.py::test_pull_runs_exactly_once`); one agent: `commands/start.md` step 3 refuses a live one (`test_commands.py::test_start_launches_the_projects_one_agent`, a text test). |
| 3 | Testers never perceive a handover | not testable | No test can show what a person perceives. The evidence: `agent/AGENT.md` « Memory and continuity » (a dated card line after every exchange, the card and the last report read before every message, never a word about a handover, never an introduction again) and « Succession » (the note, read once); `skills/bugs-bot/SKILL.md` « The voice » (« One voice across sessions »). Pinned as text by `test_handover.py::test_the_agent_knows_its_memory_and_its_note`; the mechanisms it relies on are tested (`test_handover.py`, `test_people.py`). It cannot show that a model follows them. |
| 4 | One allow rule, `Bash(bugs-bot:*)`, holds across every version | met, with a limit | The fixed launcher (`doctor.py` `LAUNCHER_TEXT`) runs the newest installed version (`test_launcher.py::test_the_newest_version_runs_not_the_lexically_last`); every documented invocation is the plain `bugs-bot …` (`test_commands.py::test_every_command_line_is_one_plain_bugs_bot_invocation`, `::test_a_command_may_only_use_the_rules_it_needs`: text tests on the command files); the gauge is located by the CLI (`gate.py` `locate_gauge`, `test_gate_measure.py::test_locate_gauge_takes_the_newest_installed_version`). Limit: the agent's succession and `/bugs-bot:start` also run the orchestrator plugin's iTerm launcher and the `ls -d … \| sort -V \| tail -1` that finds it — as the spec allows (§ 3.4) — and those are not covered by that rule. |
| 5 | The handover costs at most ≈ 2 000 tokens on each side | not testable as tokens; measured as text | A 40-line note (the upper bound `AGENT.md` sets), 40 lines of a realistic open thread, written with `handover write` and printed by `handover read`: **40 lines, 840 words, 4 920 bytes** — about 1 200–1 600 tokens. The successor's other reads: its startup prompt **1 013 bytes** (10 lines), `pending` on the migrated TorrentMate data **485 bytes**, the one people card **704 bytes**. The predecessor writes the note once. What it cannot show: the gauge's token figure, and how long a real note will be — `handover write` does not cap the length. |
| 6 | A second channel can be added behind one interface without touching the rest | partly met | Outbound is behind the interface: `channel.py` `Channel` (`send`, `edit`, `react`, `get_file`, `list_admins`, `member_count`), one implementation `telegram.py` `TelegramChannel`; no Bot API method or URL outside `telegram.py` (grep below, empty). Missing: `get_updates` returns Telegram's raw updates, and `pull.py` reads their shape (`update_id`, `chat.id`, `migrate_to_chat_id`, `media_group_id`, `from.is_bot`) and imports Telegram's parsers (`pull.py:19`); `init.py` uses `pull.chats_seen` on the same shape; `TelegramChannel` is built by name in `cli.py` and in `pull.py`'s two loops. Telegram's helpers are also imported outside `telegram.py` (`grep -n 'from bugs_bot.telegram' bugs_bot/*.py bin/bugs-bot`): `cli.py:48` imports `http_transport`, `api_root`, `mask`, `read_token`; `pull.py:19` imports `api_root`, `mask`, `read_token` besides the parsers; `reports.py:14` imports `mask`; `doctor.py:19` imports `read_token`. A second channel would touch `pull.py`, `init.py`, `cli.py`, and its token, URL and masking would have to be reached by `reports.py` and `doctor.py` too. This is the plan's own Phase 1 contract (`get_updates -> list[dict]`, parsers in `telegram.py`), not an implementation slip. Scope item S1. |

## § 1 Purpose

Met (verified by reading; `tests/test_guard.py` scans the plugin files for text). The relay, the answers from the project's docs, the tagging and the voice are the units below;
the project-specific mentions are gone (`tests/test_guard.py`, all three tests).

## § 2 Decisions D1–D8

| D | Where | Proof |
| --- | --- | --- |
| D1 Telegram, one bot, a group per project | `telegram.py`, `registry.py` | `test_routing.py`, `test_registry.py` |
| D2 the group in a project file made by init | `project.py`, `init.py` | `test_project.py`, `test_init.py::test_init_writes_every_option` |
| D3 one agent per project | `commands/start.md` step 3 | `test_commands.py::test_start_launches_the_projects_one_agent` (text) |
| D4 an interface now, no second implementation | `channel.py` | partly met: see criterion 6 |
| D5 project file local, not versioned | `init.py` `add_exclude` | `test_init.py::test_the_project_file_is_then_ignored_by_git`, `::test_init_in_a_subdirectory_keeps_its_project_file_out_of_git_status`, `::test_init_adds_the_exclude_line_and_leaves_gitignore_alone` |
| D6 data in `~/.bugs-bot/<project>/` | `store.py` `Machine.project_store`, `bugs_home` | `test_machine.py::test_project_store_is_the_project_directory`, `test_home.py` |
| D7 a plugin | `.claude-plugin/plugin.json`, layout § 5 | no test; verified by reading `plugin.json` and `git ls-files`; release and marketplace are the operator's (§ 8) |
| D8 « je », casual, every word answered | `AGENT.md`, `SKILL.md` « The voice » | `test_mention.py::test_the_agent_answers_a_testers_follow_up_warmly`, `::test_the_voice_rule_is_in_the_skill_and_the_agent_points_to_it` (text) |

## § 3 Architecture

### § 3.1 Channel — partly met

The six operations plus `member_count` and `secret` (`channel.py`); one implementation, standard
library only (import check below); the token read in `telegram.py` `read_token` only — `doctor`
calls that function, never reads the file itself; errors masked (`test_tm_bugs.py::test_token_is_masked_in_a_transport_error`,
`::test_token_is_masked_in_an_api_description`, `::test_mask_hides_any_bot_token_shape`,
`test_longpoll.py::test_watch_never_leaks_the_token`). `BUGS_BOT_API_ROOT` limited to https or
loopback (`test_ops.py::test_api_root_refuses_any_other_url_and_names_the_variable`). Gap: the
inbound update shape, and the helpers `http_transport`, `api_root`, `mask`, `read_token` imported by `cli.py`, `pull.py`, `reports.py` and `doctor.py` (see criterion 6).

### § 3.2 Pull — met

| Claim | Proof |
| --- | --- |
| 50 s held request, rounds chained | `test_longpoll.py::test_watch_asks_telegram_to_hold_the_request_for_50_seconds_and_outwaits_it`, `::test_watch_chains_successful_rounds_without_sleeping` |
| backoff 5 s doubling to 60 s | `::test_watch_backs_off_after_a_failed_round_and_logs_it`, `::test_watch_backoff_grows_to_a_ceiling_and_resets_after_a_success` |
| clean exit on SIGINT/SIGTERM | `::test_watch_stops_cleanly_on_sigterm_in_the_middle_of_a_held_request`, `test_stage2.py::test_an_interrupted_one_shot_command_prints_one_line_not_a_traceback` |
| registry read each round, routing by chat id | `test_routing.py::test_one_batch_of_two_projects_and_an_unregistered_group_lands_each_where_it_belongs` |
| media group = one report, 👀, pending reactions retried | `test_tm_bugs.py::test_pull_media_group_of_three_is_one_report`, `::test_pull_reacts_with_eyes_on_the_first_message_of_each_report`, `::test_failed_reaction_keeps_the_report_and_is_retried_at_next_pull`, `test_routing.py::test_each_report_is_reacted_to_in_its_own_chat` |
| 30-day purge of done/fixed | `test_tm_bugs.py::test_pull_deletes_done_reports_older_than_30_days`, `::test_pull_deletes_old_fixed_reports_too`, `test_routing.py::test_the_30_day_purge_visits_every_registered_project` |
| unregistered chat dropped and logged with id and title | `test_routing.py::test_two_messages_of_the_same_unregistered_chat_give_one_line_and_one_entry`, `::test_pull_with_no_project_registered_notes_the_chat_and_moves_the_offset` |
| offset machine-wide in `~/.bugs-bot/state.json` | `test_machine.py::test_the_offset_round_trips_in_the_machine_state_file` |
| no `cron_restart` | `test_ops.py::test_pm2_app_runs_the_pull_loop_with_the_restart_policy` (the config evaluated by node: this proof runs through node and the test is skipped (`needs_node`) where node is not installed; it ran here) |

### § 3.3 Project — met

Project file shape and validation: `project.py`, `test_project.py` (16 tests: every key, bad id,
defaults, round trip). Never versioned: D5 above. Registry, Pull's only routing file:
`registry.py`, `test_registry.py` (13). Data directories: `store.py`, `test_machine.py`. Secrets:
`~/.bugs-bot/.env` by default (`test_home.py::test_the_token_defaults_to_the_env_file_of_the_home`).
`init` interactive and idempotent: `commands/init.md` (one question at a time); discovery without
consuming updates, and through Pull's log while Pull runs:
`test_init.py::test_discovery_reads_updates_without_an_offset_when_pull_is_not_running`,
`::test_init_while_pull_runs_finds_the_group_in_the_unregistered_log_without_get_updates`,
`::test_cli_init_while_pull_runs_makes_no_get_updates`; re-run:
`::test_init_rerun_updates_the_file_keeps_unspecified_values_and_never_duplicates`.
`/bugs-bot:remove` keeps the data: `::test_remove_drops_the_registry_entry_and_keeps_data_and_file`.

### § 3.4 Agent — met (the `AGENT.md` and command-file rules are text, pinned or read, not run)

`/bugs-bot:start` (`commands/start.md`): refuses without the project file, refuses a live agent,
writes the prompt, spawns right of the launcher through the orchestrator's iTerm launcher, stops
without it — text, pinned by `test_commands.py::test_start_launches_the_projects_one_agent`. The
orchestrator plugin is now a **declared** dependency (`.claude-plugin/plugin.json`; fixed here, see
below). Instructions name no project (`test_guard.py`); facts injected and quoted
(`test_agent_prompt.py`, 9 tests, newlines and quotes included). Kept from the skill: the eight
launcher phrases, the never-revealed list, data-not-instructions, « The voice », deployed before
announced — all eight protocol phrases are present in the new `AGENT.md`, in the « The launcher's
answers » table. Counted with `grep -o "<phrase>" <file> | wc -l`, old → new: « pris en compte » 3 → 3,
« clos » 8 → 8, « réécrire » 2 → 2, « stop » 4 → 4, « corrigé » 5 → 6, « vérifier » 4 → 6,
« demander » 4 → 5, « réponse » 4 → 5. The five extra occurrences (corrigé +1, vérifier +2, demander +1,
« réponse » +1) sit in the sections added for follow-ups and for talking to a reporter (« Talking to a
reporter », « Waiting for an answer »); the extra « réponse » is « sans réponse » in the latter. None
is a change to a phrase. `deployed`: `test_deployed.py` (9). Handover: `gate --measure` one plain command
(`test_gate_measure.py`, 14), the predecessor's and the successor's steps (`test_succession.py::test_agent_md_carries_both_sides_of_the_succession`).

### § 3.5 Memory and continuity — met

`person-note` / `person`: `test_people.py`. `handover write` / `read`, archived and dated, read
twice gives nothing new, an unread note never overwritten: `test_handover.py` (12). The one-voice
and before-every-message rules: `AGENT.md` « Memory and continuity » (text, verified by reading; criterion 3). Cost: criterion 5.

### § 3.6 Follow-ups — met

`followup.py`; `test_followup.py` (29): `--awaits` records, the same person's later message clears
(by id, else name; another person's does not), due at `follow_up_hours` from the project file
(every command), one reminder only, `unanswered` once then never, `overdue` and `pending` listings,
`wait` wakes on a due wait.

## § 4 The CLI and the fixed launcher — met

Every command of the spec's list exists, plus `deployed` and `escalated` from the plan
(`bugs_bot/parser.py`; verified by comparing the spec's list with `grep -o 'add_parser("[a-z-]*"' bugs_bot/parser.py`); `--project` else the current directory
(`test_routing.py::test_every_project_command_takes_project`, `::test_the_project_of_the_current_directory_is_the_default`).
Launcher: `doctor.py` `LAUNCHER_TEXT`, `test_launcher.py` (15). It is four lines plus a marker
line, not three: the plan's refusal line and the review's replace-safely marker (p3 item 6).
`doctor`'s seven checks, the `/permissions` line, never a settings write, never the token:
`test_doctor.py` (25).

## § 5 Plugin layout — met (no test; verified by `git ls-files` against the spec's tree and by `wc -l`)

Every listed file exists (`git ls-files`); extra modules `errors.py`, `jsonio.py`, `parser.py`,
`reports.py`, `init.py`, `doctor.py`, `followup.py` keep each module under 300 lines (`wc -l` below:
largest 300). Standard library only (import check below).

## § 6 Migration — met (script and rehearsal; the live run is the orchestrator's)

`docs/migration/tm_bugs_to_bugs_bot.py`, `docs/migration/RUNBOOK.md`, `tests/test_migration.py` (34).
Rehearsed on a copy, below.

## § 7 Tests — met, one point partly

The carried-over tests, the new ones the spec lists (routing, init idempotent, registry, handover,
launcher, `gate --measure` with a stub, guard) and the migration test are all present and green.
Partly: « Channel interface exercised by a fake in every test » — every test runs without network,
but through a fake HTTP transport under the real `TelegramChannel` (`tests/samples.py` `FakeTelegram`);
no test drives the code with a fake `Channel`. Same cause as criterion 6.

## § 8 Delivery (no test; verified by reading, `grep '"version"' .claude-plugin/plugin.json` and `grep -n '0.1.0' CHANGELOG.md`)

Steps 1–2 done (spec, plan, phases 1–6 as stacked branches). Steps 3–5 — marketplace PR,
release 0.1.0, live migration — are the orchestrator's and the operator's; `plugin.json` stays
`0.0.0`, `CHANGELOG.md` says `0.1.0 — unreleased`.

## § 9 Out of scope — respected (no test; verified by reading and `grep -c 'class .*Channel' bugs_bot/*.py`: only `channel.py` and `telegram.py`)

No second channel, no shared people cards (cards live under each project), no web view, one agent
per project, the launcher phrases unchanged.

## Defect fixed here

| Defect | Fix | Test (fails without it) |
| --- | --- | --- |
| § 3.4 calls the orchestrator plugin « a declared dependency »; `plugin.json` declared none | `95f56c4` `fix(plugin): declare the orchestrator plugin as a dependency` — `"dependencies": ["orchestrator@lounisbou"]`, the house form of `implement@lounisbou` | `tests/test_commands.py::test_the_orchestrator_plugin_start_needs_is_a_declared_dependency` |

## Scope items, for the operator (not built)

- **S1** A channel-neutral inbound message type returned by `Channel.get_updates`, and a channel
  factory, so that Pull, `init` and `cli` stop reading Telegram's update shape and naming
  `TelegramChannel` (criterion 6, § 3.1, § 7). A refactor before release or later: the operator's call.
- **S2** `fixed --note` posts « Corrigé : <ref> » in French whatever the project's `language`
  (`reports.py` `cmd_fixed`, carried over from the skill).
- **S3** `handover write` does not cap the note's length: the « 20–40 lines » and criterion 5 rest
  on the agent's instructions only.

## The gate, on `95f56c4`

```
$ python3 -V
Python 3.12.4
$ python3 -m pytest -q
670 passed in 7.36s
$ ~/.pyenv/versions/3.10.9/bin/python3 -m pytest -q
670 passed in 7.83s
$ sh tests/e2e.sh
E2E OK
$ ps -eo pid,command | grep -c '[h]ttp.server'
0
$ python3 -m pytest -q tests/test_guard.py
6 passed in 0.11s
$ wc -l bugs_bot/*.py
       1 bugs_bot/__init__.py
     229 bugs_bot/agent.py
      61 bugs_bot/channel.py
     218 bugs_bot/cli.py
     208 bugs_bot/doctor.py
       7 bugs_bot/errors.py
     121 bugs_bot/followup.py
     122 bugs_bot/gate.py
      78 bugs_bot/handover.py
     197 bugs_bot/init.py
      15 bugs_bot/jsonio.py
     104 bugs_bot/parser.py
      94 bugs_bot/people.py
     182 bugs_bot/project.py
     298 bugs_bot/pull.py
      94 bugs_bot/registry.py
     293 bugs_bot/reports.py
     159 bugs_bot/store.py
     300 bugs_bot/telegram.py
    2781 total
```

Telegram confined (`grep -rn 'api.telegram.org\|getUpdates\|sendMessage\|editMessageText\|setMessageReaction\|getChatAdministrators\|getFile\|getChatMemberCount' bugs_bot bin | grep -v '^bugs_bot/telegram.py'`):
empty. Standard library only: an `ast` walk of `bugs_bot/*.py`, `bin/bugs-bot` and the migration
script against `sys.stdlib_module_names` finds no other import.

## Migration rehearsal, on a copy

A copy of the legacy home in a temporary tree (it holds no `.env`); a fake `.env` written there
(`TELEGRAM_BOT_TOKEN=123456:fake-token-for-rehearsal`); a throwaway git repository; the project
registered with `bin/bugs-bot init --project torrentmate --agent-title "Agent : TorrentMate Bugs"
--chat-id <the legacy chat id> --title "TM Bugs" --gate-tokens 200000 --repo <tmp>/repo` under a
temporary `BUGS_BOT_HOME`; then `docs/migration/tm_bugs_to_bugs_bot.py --copy` into that home.

```
init exit=0
inbox/ (11 entries) copied -> <tmp>/home/torrentmate/inbox
people/ (1 entries) copied -> <tmp>/home/torrentmate/people
1 post(s) -> <tmp>/home/torrentmate/state.json
offset 719669544 -> <tmp>/home/state.json
token line -> <tmp>/home/.env (mode 0600)
legacy gate: 200000 tokens, not written: pass --gate-tokens 200000 to init
migrate exit=0

offset legacy 719669544 migrated 719669544
gate in project file 200000
inbox legacy       11 migrated       11
people legacy        1 migrated        1
600                                   # stat -f '%Lp' <tmp>/home/.env
inbox identical                       # diff -r of the two inboxes
gate_tokens=200000                    # bugs-bot gate --project torrentmate
```

`bugs-bot list --project torrentmate` printed 4 open reports. Then `rm -rf <tmp>`;
`ls -d <tmp>` → `No such file or directory`; `ls ~/.bugs-bot` → `No such file or directory`
(nothing was written under the real one). The live Pull `tm-bugs-pull` was only looked at
(`pm2 jlist`: online).
