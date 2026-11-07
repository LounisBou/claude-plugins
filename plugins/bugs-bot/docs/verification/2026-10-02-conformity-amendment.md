# bugs-bot — conformity to the amendment

Date: 2026-10-02. Checked against the sections of `docs/specs/2026-10-02-bugs-bot-design.md` its
header « Amended 2026-10-02 » names — D4, criterion 6, § 3.1, § 3.2 (locked updates and edited
messages), § 3.5, § 3.7, § 3.8 — on the head `edddd59` (this document is the only change after it).
Each claim names the file that meets it and the test that shows it, or the gap. What the review
verdicts of the amended work dropped is not reopened. The first conformity document,
`2026-10-02-conformity.md`, stays the record for the sections the amendment did not touch.

Verdicts: **met**, **met, with a limit** (the limit said), **partly met** (what is missing),
**not testable** (the evidence that exists, and what it cannot show).

## Criterion 6 — re-judged: met, with a limit

« A second channel is built behind one interface: Slack beside Telegram. Adding a third touches only
its own module and the channel factory. »

| Claim | Where, and the proof |
| --- | --- |
| Slack built behind the interface | `bugs_bot/slack.py` `SlackChannel` and `bugs_bot/slack_inbound.py` implement `channel.py` `Channel` beside `telegram.py` / `telegram_inbound.py`. `tests/test_slack.py` (46 tests) drives every method against a fake transport. |
| Nothing else names a platform's API, token or URL | `tests/test_wire_guard.py::test_no_wire_name_leaves_its_platform_s_modules` and `::test_every_allowed_residue_is_still_there`. `::test_the_generic_channel_module_names_no_token_shape` and `::test_the_masks_and_the_long_polled_kinds_come_from_the_implementations`: token shapes and the long-polled kinds come from the classes. Run here: `grep -rnE "from bugs_bot(\.\| import )(telegram\|slack)" bugs_bot bin` leaves only `channels.py` and each platform's own pair of modules. |
| One factory | `channels.py` `_KINDS` and `channel_for`: `tests/test_inbound.py::test_the_factory_builds_telegram_with_its_token_and_api_root`, `::test_the_factory_refuses_an_unknown_kind`, `tests/test_slack.py::test_the_factory_builds_slack_from_its_own_token`. Pull, `init`, `doctor` and the CLI dispatch on `Channel.kind` / `Channel.exclusive`, not on a name (`watch.py` `pull_round`, `init.py` `_chosen_group`). |

The limit: a third channel would also touch three other places.

- **One row in `bugs_bot/project.py` `CHAT_IDS`.** That table gives the shape of each kind's chat
  id. Its comment says « The one table here that grows with a new channel kind ». It is an
  allowed residue in `test_wire_guard.py` `ALLOWED`, kept as it is by the correction round of the
  Slack review.
- **One convention in `parser.py` `_chat_id_arg` and `registry.py` `_INT_ID`.** Both read digits as
  an integer id. A platform whose ids are digit strings would need them changed.
- **Its operator steps in `commands/init.md` and `commands/doctor.md`.**

Scope item S4 below.

## § 2 D4 — met

« Slack is implemented behind the interface; ONE channel per project, chosen at init; Slack is read
by polling. »

| Claim | Proof |
| --- | --- |
| Slack implemented | criterion 6 above |
| ONE channel per project | `project.py` `Project.channel`, one per file; `registry.py` `Registry.add` drops the project's other entry: `tests/test_registry.py::test_a_project_moved_to_another_channel_replaces_its_old_entry`, `::test_the_same_project_under_a_new_chat_replaces_its_old_entry`, `::test_the_same_chat_id_under_two_channels_is_never_confused` |
| chosen at init | `init --channel slack`: `tests/test_slack_pull.py::test_init_slack_takes_the_one_channel_the_bot_is_in_and_is_idempotent`, `::test_init_slack_with_an_explicit_channel_asks_nothing`; a file with no `channel` reads as Telegram: `tests/test_project.py::test_a_file_without_channel_reads_as_telegram` |
| read by polling | `SlackChannel.poll` (`conversations.history`, `conversations.replies`), no Socket Mode or Events: `tests/test_slack.py::test_a_first_poll_reads_a_day_back_oldest_first_with_authors_from_users_info`, `::test_the_next_poll_reads_from_the_cursor_and_the_caller_s_cursor_is_never_moved` |

## § 3.1 Channel — met

| Claim | Proof |
| --- | --- |
| `poll(cursor, chats, timeout)` returns normalised messages (chat, id, date, author with id/username/name/language/bot, text, attachments, media-group key), the chats seen, the migrations, the next cursor | `channel.py` `InboundMessage`, `Author`, `Batch`. Telegram: `tests/test_inbound.py` (37 tests, e.g. `::test_a_media_group_shares_its_key_and_keeps_the_order`, `::test_the_author_without_a_username_is_named_by_first_name_with_language`, `::test_a_migration_maps_the_old_id_to_the_new_and_the_old_chat_is_dead`). Slack: `tests/test_slack.py::test_image_files_are_attachments_by_private_url_and_other_files_are_not`, `::test_bot_posts_service_messages_and_empty_ones_are_skipped_but_passed` |
| `send`, `send_images`, `edit`, `delete`, `react`, `get_file`, `list_admins`, `member_count` on both | Telegram: `tests/test_tm_bugs.py`, `test_delete.py::test_telegram_deletes_with_delete_message`, `test_images.py::test_telegram_*`, `test_inbound.py::test_administrators_are_authors`. Slack: `tests/test_slack.py::test_send_posts_json_with_the_token_in_the_header_only`, `::test_edit_updates_by_ts`, `::test_delete_deletes_by_ts`, `::test_react_puts_the_slack_name_and_takes_the_others_off`, `::test_get_file_downloads_the_private_url_with_the_token_header`, `::test_list_admins_returns_the_admins_and_owners_among_the_members`, `::test_member_count_reads_the_channel_info`, `test_images.py::test_slack_uploads_each_image_then_shares_them_all_in_one_message` |
| ids `int \| str` | `channel.py` `ChatId`, `MessageId`; `tests/test_slack_pull.py::test_string_chat_and_message_ids_make_a_report_whose_id_has_no_dot`, `::test_messages_are_ordered_by_date_then_id_never_by_id_alone` |
| reading never consumes; only the caller saving the cursor moves it | `tests/test_inbound.py::test_the_cursor_moves_past_every_update_and_is_only_returned`, `::test_init_discovers_a_group_from_the_batch_and_never_saves_the_cursor`, `::test_a_failed_download_keeps_the_cursor_and_the_other_project_is_written_once`; Slack: `test_slack.py::test_the_next_poll_reads_from_the_cursor_and_the_caller_s_cursor_is_never_moved`, `test_slack_pull.py::test_a_failed_answer_download_keeps_the_cursor_and_records_nothing` |
| the factory is the one place naming the implementations | criterion 6 |
| each token read by its own implementation, never printed, masked | `telegram.read_token` / `slack.read_token`, reached only through `channels.py`; `tests/test_inbound.py::test_the_factory_refuses_a_missing_token_without_printing_one`, `::test_token_problem_says_why_and_never_the_token`, `::test_mask_hides_the_secret_and_any_bot_token_shape`, `tests/test_slack.py::test_a_refusal_names_the_method_and_the_error_never_the_token`, `::test_mask_hides_slack_tokens_of_every_kind`, `::test_get_file_never_sends_the_token_off_slack`, `::test_the_transport_follows_no_redirect_with_a_credential_in_the_headers` |
| standard library only | an `ast` walk of `bugs_bot/*.py`, `bin/bugs-bot` and the migration script against `sys.stdlib_module_names`: « non-stdlib imports: none » |

## § 3.2 Pull — locked updates: met

« Every change to [a report or a card] is a locked read-modify-write: an exclusive `fcntl.flock` on
the project's `.lock`, taken before the read and released after the atomic rename. »

| Claim | Proof |
| --- | --- |
| an exclusive `flock` on `<project>/.lock`, beside the inbox | `store.py` `locked`, `LOCK_FILE`; `tests/test_lock.py::test_the_lock_is_a_file_lock_beside_the_inbox_held_until_the_last_exit` |
| taken before the read, released after the rename | `store.py` `update_report`, `people.py` `update_card` read, change and `write_json` under `locked`; `test_lock.py::test_two_updates_of_a_report_interleaved_both_land`, `::test_a_card_keeps_the_language_pull_records_while_the_agent_queues_a_question` |
| every writer goes through them | `test_lock.py::test_no_report_or_card_is_written_but_through_update_report_or_update_card` (AST guard) and `::test_the_guard_sees_a_report_saved_by_hand` |
| the defect of 2026-10-02 (a closed report brought back « seen », its reply gone) | `test_lock.py::test_pulls_reaction_retry_keeps_the_agents_done_and_reply`; `::test_a_reaction_retried_while_the_agent_moves_the_status_keeps_the_new_one` |
| never held over a network call | `test_lock.py::test_no_channel_call_is_made_while_the_lock_is_held`, `test_images.py::test_the_images_are_sent_while_the_lock_is_free` |
| the purge and a report gone meanwhile | `test_lock.py::test_the_purge_waits_for_an_update_in_progress`, `::test_a_report_purged_meanwhile_is_refused_and_not_written_back` |
| across processes | not shown by a test: the tests run threads of one process. The Phase 10 review measured two processes: P2 blocked 1.26 s behind P1's update, and both writes were present (review p10 verdict). |

## § 3.2 Pull — the rest of the amended paragraph: met

| Claim | Proof |
| --- | --- |
| held 10 s instead of 50 s while a Slack project is registered | `watch.py` `SHORT_HOLD`; `tests/test_slack_pull.py::test_one_round_reads_telegram_held_ten_seconds_then_each_slack_project`, `::test_telegram_alone_is_still_held_fifty_seconds`, `::test_a_slack_only_watch_pauses_between_clean_rounds` |

## § 3.2 Pull — edited messages: met on Telegram; on Slack a known limitation

| Claim | Proof |
| --- | --- |
| Telegram `edited_message` asked in `allowed_updates` | `telegram_inbound.py` `ALLOWED_UPDATES`; `tests/test_edits.py::test_telegram_is_asked_for_edited_messages` |
| the report holding the message takes the new text: its first message, a media-group member, an answer | `edits.py` `record_edit`; `test_edits.py::test_an_edit_replaces_the_report_text_keeps_the_previous_and_wait_says_it_until_show`, `::test_an_edit_of_a_media_group_member_corrects_that_member_only`, `::test_a_caption_removed_from_a_media_group_member_takes_that_member_s_line_only`, `::test_an_edit_of_a_thread_answer_goes_to_that_answer` |
| the previous text kept in `edits` `{date, message_id, previous}` (plus `seen`, and `text` for a legacy multi-member report) | same tests; `::test_a_media_group_report_written_without_its_members_texts_keeps_its_text_and_records_the_edit` |
| `wait` prints `edited <id>` until `show` has displayed it | `::test_an_edit_replaces_the_report_text_keeps_the_previous_and_wait_says_it_until_show`, `::test_show_prints_an_edit_of_a_thread_answer_from_its_previous_to_its_new_text` |
| an edit of a message never recorded is ignored | `::test_an_edit_of_a_message_never_recorded_writes_nothing`, `::test_an_edit_of_the_same_message_id_in_another_chat_writes_nothing` |
| never creates a report, never clears or sets a wait, never changes the status | `::test_an_edit_changes_no_status_no_wait_and_no_reaction`, `::test_a_slack_edit_through_pull_replaces_the_text_and_creates_no_report` |
| under the lock, on the report as it is now; a replay recorded once | `::test_an_edit_is_written_on_the_report_as_it_is_now`, `::test_an_edit_delivered_again_is_recorded_once`, `::test_an_edit_replayed_after_a_later_one_is_never_recorded_again` |
| **Slack: a known limitation of 0.1.0** (operator, 2026-10-02, « B ») | `conversations.history`, which Pull polls, never returns `message_changed`: Slack sends that event only through Events and RTM. So an edit on Slack is not seen. The code that normalises `message_changed` (`slack_inbound.py` `to_inbound`, `EDITED`) is kept unchanged, with its tests on a recorded payload (`test_edits.py::test_slack_message_changed_is_the_inner_message_edited_and_the_cursor_passes_it`). Those tests prove the normalisation only, not that Slack ever sends the event to Pull. Documented in `README.md` « Known limitations » and in `CHANGELOG.md`, 0.1.0 « Known limitations ». Detection comes with the live Slack test. |

## § 3.5 Memory and continuity — met (the agent's own rules are text)

| Claim | Proof |
| --- | --- |
| each card carries `language`, recorded by Pull on first sight from the platform (Telegram `language_code`, Slack `locale`), never over a value already there | `people.py` `record_language`; `tests/test_language.py::test_pull_records_the_language_on_first_sight`, `::test_pull_never_overwrites_a_language_already_there`, `::test_the_agents_correction_survives_the_next_pull`; Slack `locale` through `users.info … include_locale` to the card: `tests/test_slack_pull.py::test_pull_reads_slack_and_the_commands_answer_in_the_thread` (`language == "fr"`, then `person-lang` → `language: en`) |
| `person-lang <ref> <code>` | `people.py` `cmd_person_lang`; `test_language.py::test_person_lang_refuses_a_code_that_is_not_two_lower_case_letters`, `::test_person_lang_by_report_id_of_an_author_without_id_uses_the_name_card` |
| every message in the person's language, else the project's | `language_of`: `test_language.py::test_language_of_is_the_persons_then_the_projects`. The CLI posts no text of its own: every `send` / `send_images` carries the agent's text (`grep -rn "\.send(\|send_images(" bugs_bot`: only `images.py` `post` and Telegram's text-first path). Choosing the language is the agent's rule in `agent/AGENT.md` « Their language », pinned by `test_language.py::test_the_agent_writes_to_each_person_in_their_language`. **Not testable** that a model writes in that language. |
| the handover note capped at 40 lines / 8 000 characters, the limit and the size named, nothing written | `handover.py` `NOTE_MAX_LINES`, `NOTE_MAX_CHARS`, `write_note`; `tests/test_handover.py::test_a_note_at_the_limit_is_accepted`, `::test_a_note_over_the_limit_is_refused_and_nothing_is_written`, `::test_a_refused_note_leaves_the_unread_one_untouched`, `::test_the_agent_shortens_a_refused_note_and_writes_again`. This closes scope item S3 of the first conformity document. |
| no developer reference in the group | `fixed --note` records `fix_ref` and posts nothing: `tests/test_fix_ref.py::test_fixed_with_a_note_records_the_ref_and_posts_nothing`, `::test_the_agent_tells_the_fix_in_its_own_words_never_with_the_ref`. This closes scope item S2. |
| edit and delete of the bot's own messages | `tests/test_delete.py` (16 tests), `test_edit.py` |
| one question at a time | `questions.py`; `tests/test_questions.py` (29 tests) |

## § 3.7 Slack — met, one point as a review ruled it

| Claim | Proof |
| --- | --- |
| one app, its scopes, invited into each channel | `README.md` « Setting up Slack » lists the nine scopes, `files:write` included: `tests/test_images.py::test_the_readme_gives_the_slack_scope_and_the_option`. No live app was set up. |
| `conversations.history` of every registered Slack channel since its cursor; cursors per channel in `~/.bugs-bot/state.json` | `slack_inbound.py` `read_chat`; `store.py` `Machine.load_cursor` / `save_cursor` (key `slack`); `tests/test_slack.py::test_two_chats_keep_their_own_cursors`, `::test_history_follows_every_page`, `test_inbound.py::test_the_machine_keeps_one_cursor_per_kind_side_by_side` |
| `conversations.replies` of the threads of its open reports; a thread reply answers there | `pull.py` `open_threads` (every report not `done`: a `fixed` one is asked to be checked, review p9 K1); `tests/test_slack_pull.py::test_pull_gives_the_channel_the_open_reports_threads_per_chat`, `::test_a_thread_reply_is_an_answer_on_its_report_never_a_report`, `::test_a_reply_in_the_thread_of_a_fixed_report_answers_its_check`. **As ruled by review p9 (item 7)**: threads are read at most every 60 s (`THREADS_EVERY`), not every round, which keeps several open reports under Slack's rate limit: `test_slack.py::test_threads_are_read_at_most_once_a_minute_and_history_every_round` |
| HTTP 429 honours `Retry-After` | `test_slack.py::test_http_429_raises_rate_limited_carrying_retry_after`, `::test_http_429_without_retry_after_asks_no_particular_wait`; `test_slack_pull.py::test_a_slack_rate_limit_waits_what_slack_asked_then_retries` |
| a top-level message is a report; image files are its images, downloaded with the token; the bot's posts are not reports | `test_slack.py::test_image_files_are_attachments_by_private_url_and_other_files_are_not`, `::test_get_file_downloads_the_private_url_with_the_token_header`, `::test_bot_posts_service_messages_and_empty_ones_are_skipped_but_passed` |
| 👀 is `eyes`; a mention is `<@U…>`; a reply is threaded (`thread_ts`); `edit` is `chat.update` | `test_slack.py::test_react_puts_the_slack_name_and_takes_the_others_off`, `::test_send_threads_on_the_report_and_mentions_by_user_id`, `::test_edit_updates_by_ts`; end to end in `tests/e2e.sh` (below) |
| `init` lists `users.conversations` and the operator picks one | `test_slack.py::test_a_poll_of_no_chat_lists_the_channels_the_bot_is_in`; `test_slack_pull.py::test_init_slack_lists_the_channels_when_there_are_several_and_writes_nothing`, `::test_init_slack_never_offers_telegram_chats_nor_a_channel_another_project_holds` |
| `doctor` checks the token with `auth.test` when a Slack project is registered | `test_slack_pull.py::test_doctor_asks_each_registered_platform_who_the_bot_is`, `::test_doctor_fails_the_slack_check_when_its_token_is_refused`; what the operator does about it: `commands/doctor.md` (fixed here, below) |
| `list_admins`: workspace admins or owners among the members; `member_count`: the channel's | `test_slack.py::test_list_admins_returns_the_admins_and_owners_among_the_members`, `::test_member_count_reads_the_channel_info` |
| the live smoke test | **not run**. Operator, 2026-10-02: « l'essai Slack se fera plus tard, pas tout de suite, on release sans. » Every Slack claim above is shown against a fake transport or the loopback fake of `tests/http_server_fake_slack_api.py`. None of it shows that Slack's real answers match those fakes. |

## § 3.8 Screenshots to reporters — met (the asking and the looking are the agent's rules, text)

| Claim | Proof |
| --- | --- |
| asking the launcher « capture <id> : … », its answer « capture <id> <path> … » | `agent/AGENT.md` « Screenshots », `skills/bugs-bot/SKILL.md`; `tests/test_images.py::test_the_agent_knows_how_to_ask_for_look_at_and_send_a_screenshot`, `::test_the_launcher_knows_how_to_answer_a_capture_request`, `::test_the_agent_asks_for_a_capture_with_the_line_the_launcher_expects` |
| looking before sending; the never-revealed list on pixels | `AGENT.md` « Looking before sending » (text, pinned by the first test above). **Not testable** that a model looks. |
| `reply … --image`, `post … --image`: 1 to 10 PNG/JPEG/WebP, 10 MB each, checked before anything is sent | `images.py` `check_images`; `test_images.py::test_png_jpeg_and_webp_pass_by_their_magic_bytes_whatever_their_name`, `::test_a_bad_image_is_refused_and_named` (missing, not an image, over 10 MB), `::test_more_than_ten_images_are_refused`, `::test_ten_images_pass`, `::test_a_bad_image_among_good_ones_sends_nothing_and_records_nothing`, `::test_an_image_gone_after_the_check_sends_nothing_not_even_a_long_text`, `::test_an_image_no_longer_an_image_after_the_check_sends_nothing_not_even_a_long_text` |
| the text as caption when allowed, else first, then the images on the same thread | `::test_telegram_a_text_too_long_for_a_caption_goes_first_then_the_images_on_the_same_thread`, `::test_telegram_a_caption_of_astral_characters_too_long_in_utf16_goes_as_text_first`, `::test_telegram_a_caption_of_exactly_1024_utf16_units_with_its_mention_stays_a_caption` |
| `--awaits`, `--mention`, the one-question rule unchanged | `::test_awaits_with_images_waits_on_that_reply`, `::test_telegram_threads_and_mentions_through_the_caption`, `::test_slack_posts_the_images_in_the_reports_thread_with_the_mention`, `::test_a_question_that_would_be_queued_is_refused_with_its_images` (as the plan specifies: ask first, show after) |
| each sent image copied to `sent/<reply n>-<k>.<ext>` and listed on the reply | `::test_the_images_sent_are_copied_into_sent_named_by_reply_and_rank`, `::test_reply_with_images_threads_them_on_the_report_and_records_what_was_sent`; the bytes sent are the ones recorded: `tests/test_image_replies.py::test_a_source_image_deleted_once_sent_leaves_the_reply_recorded_with_its_image`, `::test_a_source_image_rewritten_once_sent_leaves_the_bytes_sent_in_sent`; end to end: `tests/e2e.sh` (`show` lists `sent/2-1.png`) |
| Telegram `sendPhoto` / `sendMediaGroup`, caption on the first | `::test_telegram_one_image_is_a_photo_captioned_with_the_text`, `::test_telegram_several_images_are_one_media_group_captioned_on_the_first`, `::test_a_multipart_body_reads_back_whole_with_a_filename_holding_spaces_and_quotes` |
| Slack `files.getUploadURLExternal`, the upload, `files.completeUploadExternal` with `channel_id`, `thread_ts`, `initial_comment` | `::test_slack_uploads_each_image_then_shares_them_all_in_one_message`, `::test_slack_a_failed_second_upload_shares_nothing`, `::test_slack_never_uploads_to_a_host_that_is_not_slack` |
| out of scope: editing an image already posted | refused: `test_image_replies.py::test_an_image_reply_is_never_edited`, `::test_a_slack_image_reply_is_never_edited` |

## End to end — `tests/e2e.sh`: already covering, not extended

The script already drives one Slack project on `tests/http_server_fake_slack_api.py` on loopback,
beside the two Telegram projects:

- **init**: `init --channel slack` registers `slack:C0GAMMA` beside `telegram:-1001` and
  `telegram:-1002`.
- **pull**: `pull` writes the report and puts `reactions.add` on it. The other projects are left
  alone.
- **reply**: `triage`, then `reply --mention --awaits` posts `<@U0ANA> which file?` with the
  report's `thread_ts`.
- **show**: the tester's answer in the thread is pulled as an answer, not a report. `wait` prints
  `answer <id>`, `show` prints it, and the next `wait` is empty.

The whole round trip (pull, reply, show) is already driven, so nothing was added.

## Defects fixed here

| Defect | Fix | Test (falls without it) |
| --- | --- | --- |
| For a Slack project, the instructions said things that are false or missing. The orchestrator ruled this an adjacent case of review p9 item 14. (1) `commands/doctor.md` had a remedy for `token` (`TELEGRAM_BOT_TOKEN`) only: nothing for `slack token` or for the `telegram bot` / `slack bot` checks. (2) `agent/AGENT.md` « the Telegram group ». (3) `commands/start.md` « the project's Telegram group ». (4) `skills/bugs-bot/SKILL.md`: the token rule named `TELEGRAM_BOT_TOKEN` only; errors carried « Telegram's description » and left « the offset »; `backfill-authors` « asks Telegram »; « Setup by the operator » had BotFather only and « post one message in the new group » | `42d7a3b` `fix(docs): say each channel's token and group, not Telegram's only` (text only, no code) | `tests/test_commands.py::test_doctor_tells_what_to_do_about_each_channels_token_and_bot_check[telegram]`, `[slack]`, `::test_no_instruction_says_a_projects_group_is_telegram_s_only` (4 cases), `::test_the_skill_names_both_tokens_and_sets_up_both_channels`: 7 failed before the text change, 7 pass after |

Also on this branch, by the operator's ruling « B »: `0388062` `docs: Slack edits are a known
limitation of 0.1.0` (`README.md` « Known limitations », `CHANGELOG.md`). The Slack
`message_changed` code is untouched (`git diff 915c072 -- bugs_bot` is empty).

Fixed on the operator's word (the S6 of an earlier draft of this document): `05981b8` `docs: the
readme and changelog say what the build does`. That commit:

- `README.md` « Tests » and the `CHANGELOG.md` end-to-end line name the Slack project and the fake
  Slack API beside the two Telegram projects. « Tests » also says the script starts and kills two
  fake servers.
- `README.md`'s command list gains `delete`, `unask` and `person-lang`.
- In the same family as `42d7a3b`, `skills/bugs-bot/SKILL.md` no longer says `delete` goes
  « through `deleteMessage` » only (Slack's is `chat.delete`). Nor does it say a person's language
  comes from Telegram's `language_code` only (Slack's is `locale`).

Text only, with no test: these are descriptions, not rules the agent or the operator acts on.

Fixed after the review of the amended work, in the same family: `edddd59` `fix(docs): say the edit
row and the reply notification per channel`. Two statements of `skills/bugs-bot/SKILL.md` read as
if every channel were Telegram:

- The `edit` row (line 32) said an edit goes « through `editMessageText` ». It now says « through
  the platform (Telegram's `editMessageText`, Slack's `chat.update`) », and « message is not
  modified » is said as Telegram's (`replies.py`, `telegram.py`). Slack's edit is `chat.update`
  (`slack.py`). `tests/test_commands.py::test_the_skill_names_both_tokens_and_sets_up_both_channels`
  now pins `chat.update`; it failed before the change and passes after.
- The advice of rule 6 (line 86) said « Telegram notifies the author of the message replied to »
  without its channel. It now says that on Telegram the author is notified, and claims nothing about
  Slack. No test pins this one.

## Scope items, for the operator (not built)

The first document's S1 (normalised inbound behind the channel), S2 (`fixed --note` in French) and
S3 (the uncapped note) are closed by the amendment: criterion 6, `test_fix_ref.py` and the note cap
above.

- **S4** A third channel still touches more than its own module and the factory: one row of
  `project.py` `CHAT_IDS`, the digits-are-an-integer convention of `parser.py` / `registry.py`, and
  its operator steps in `commands/init.md` / `commands/doctor.md`. The way out would be for each
  `Channel` class to carry its chat-id shape, read by `project.py` through the factory.
- **S5** Slack edit detection: the known limitation above. It means re-reading the open reports'
  messages, or adopting the Events API, which § 9 puts out of scope. It comes with the live Slack
  test.

## The gate, on `edddd59`

```
$ python3 -V
Python 3.12.4
$ python3 -m pytest -q
1022 passed in 13.43s
$ ~/.pyenv/versions/3.10.9/bin/python3 -V
Python 3.10.9
$ ~/.pyenv/versions/3.10.9/bin/python3 -m pytest -q
1022 passed in 14.97s
$ sh tests/e2e.sh
…
answer on 20261002-214109-1790977269-443784 in gamma
E2E OK
$ ps -eo pid,command | grep -c '[h]ttp.server'
0
$ python3 -m pytest -q tests/test_guard.py tests/test_wire_guard.py
16 passed in 0.17s
$ wc -l bugs_bot/*.py
       1 bugs_bot/__init__.py
     236 bugs_bot/agent.py
     100 bugs_bot/answers.py
     259 bugs_bot/channel.py
     138 bugs_bot/channels.py
     222 bugs_bot/cli.py
     242 bugs_bot/doctor.py
     125 bugs_bot/edits.py
      34 bugs_bot/envfile.py
      15 bugs_bot/errors.py
     130 bugs_bot/followup.py
     122 bugs_bot/gate.py
      91 bugs_bot/handover.py
     125 bugs_bot/images.py
     226 bugs_bot/init.py
      15 bugs_bot/jsonio.py
     127 bugs_bot/parser.py
     180 bugs_bot/people.py
     206 bugs_bot/project.py
     256 bugs_bot/pull.py
     114 bugs_bot/questions.py
     103 bugs_bot/reactions.py
     121 bugs_bot/registry.py
     116 bugs_bot/replies.py
     220 bugs_bot/reports.py
     190 bugs_bot/slack_inbound.py
     299 bugs_bot/slack.py
     280 bugs_bot/store.py
     109 bugs_bot/telegram_inbound.py
     256 bugs_bot/telegram.py
     200 bugs_bot/watch.py
    4858 total
```

Every module is at most 299 lines. Standard library only (the `ast` walk above).

## Migration rehearsal, on a copy

1. The legacy home was copied into a temporary tree. It holds `agent/`, `agent.json`, `inbox/`,
   `people/`, `settings.json` and `state.json`, and no `.env`.
2. A fake `.env` was written there: `TELEGRAM_BOT_TOKEN=123456:fake-token-for-rehearsal`.
3. A throwaway git repository was created. The project was registered under a temporary
   `BUGS_BOT_HOME` with `bin/bugs-bot init --project torrentmate --agent-title "Agent : TorrentMate
   Bugs" --chat-id <the legacy chat id> --title "TM Bugs" --gate-tokens 200000 --repo <tmp>/repo`.
   The gate value is the legacy `settings.json` `context_gate_tokens`.
4. `docs/migration/tm_bugs_to_bugs_bot.py --copy --env-file <tmp>/fake.env` was run into that home.

```
added /.bugs-bot.json to <tmp>/repo/.git/info/exclude
wrote <tmp>/repo/.bugs-bot.json
registered <chat> -> torrentmate <tmp>/repo
migrate exit=0
inbox/ (25 entries) copied -> <tmp>/home/torrentmate/inbox
people/ (1 entries) copied -> <tmp>/home/torrentmate/people
1 post(s) -> <tmp>/home/torrentmate/state.json
offset 719669563 -> <tmp>/home/state.json
token line -> <tmp>/home/.env (mode 0600)
legacy gate: 200000 tokens, not written: pass --gate-tokens 200000 to init

offset legacy 719669563 migrated 719669563
registry key is the legacy chat: True              # projects.json == ["telegram:<legacy chat_id>"]
gate in project file 200000
inbox legacy       25 migrated       25
people legacy        1 migrated        1
600                                                # stat -f '%Lp' <tmp>/home/.env
inbox identical                                    # diff -r of the two inboxes
gate_tokens=200000                                 # bugs-bot gate, from <tmp>/repo
```

`bugs-bot list --project torrentmate` printed 5 open reports, all `taken`. Then `rm -rf <tmp>`.
`ls -d <tmp>` gave `No such file or directory`, and so did `ls ~/.bugs-bot`: nothing was written
under the real home. The legacy Pull was not touched.
