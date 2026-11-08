# Commits

## Commit messages

Conventional Commits in every repository: `<type>[(<scope>)]: <description>`. Write in
the imperative mood ("add", not "added" or "adds"). Add a body only when the why is not
obvious from the diff itself. No trailer of any kind: no `Co-Authored-By`, no
`Claude-Session`, no attribution of any form, no semicolon. A trailer is a line that
opens with a `<word>-by:` label (`Co-Authored-By`, `Signed-off-by`, `Reviewed-by`, and
`Drive-by` or `Stand-by` as well), `Claude-Session:` or `Change-Id:`, and the plugin
refuses it in a description and a review comment. Other labelled lines (`Note:`,
`Follow-up work:`) are none. No reference to a plan
`phase`, an `agent`, an `AI`, an `orchestrator`, a `session`, a `brief` or any other
workflow mechanics in any durable artifact (code, comment, doc, commit, PR) — the
history must read as a developer's own work, in business and technical terms only. In
the Claude plugins themselves, the `claude-*` repositories, these words name the
plugin's object and are allowed. No information specific to GeoNative in a public
repository (code, commit, title, description).

Types: `feat`, `fix`, `chore`, `refactor`, `style`, `docs`, `test`, `perf`, `build`,
`ci`. Examples: `feat(scraper): create TvShow nfo file`, `chore: add json5 dependency`,
`refactor(dispatch): extract folder_for to resolver`, `fix(conf): add missing Config
import`. Never a version prefix (`vX.Y.Z: …`): the version belongs to the release notes.
