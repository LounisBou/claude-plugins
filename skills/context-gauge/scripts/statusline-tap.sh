#!/bin/bash
# statusline-tap.sh — records the host's context payload for this session, then hands it on.
#
# Meant to be the status line command:
#   statusline-tap.sh [wrapped command...]
#
# Reads the JSON payload on stdin, writes <state>/ctx/<session_id>.json, then feeds the
# untouched payload to the wrapped command and exits with its status. Without a wrapped
# command it prints a one-line summary, so a user with no status bar still sees something.
#
# Never crashes the status line: every failure path returns quietly.
# ORCHESTRATOR_STATE_DIR overrides the state directory (the test suite uses it).

STATE_DIR="${ORCHESTRATOR_STATE_DIR:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/claude-orchestrator}"
CTX_DIR="$STATE_DIR/ctx"
input=$(cat)

record() {
  local fields sid ctx used total h5 h5r d7 d7r tp tpj mid midj file tmp
  # Field names as the host sends them: context_window.used_percentage,
  # context_window.context_window_size, and current_usage broken down by
  # input / cache-creation / cache-read tokens (their sum is the context sent).
  fields=$(printf '%s' "$input" | jq -r '
    [ (.session_id // ""),
      (.context_window.used_percentage // null),
      (.context_window.current_usage
        | if type == "object"
          then ((.input_tokens // 0) + (.cache_creation_input_tokens // 0) + (.cache_read_input_tokens // 0))
          else null end),
      (.context_window.context_window_size // null),
      (.rate_limits.five_hour.used_percentage // null),
      (.rate_limits.five_hour.resets_at // null),
      (.rate_limits.seven_day.used_percentage // null),
      (.rate_limits.seven_day.resets_at // null),
      (.transcript_path // ""),
      (.model.id // "") ]
    | map(tostring) | join("\u001f")' 2>/dev/null) || return 0
  # The separator is 0x1F rather than a tab: tabs are IFS whitespace, and two
  # empty fields in a row would collapse and shift every field after them.
  IFS=$'\x1f' read -r sid ctx used total h5 h5r d7 d7r tp mid <<<"$fields"
  [ -n "$sid" ] || return 0
  if [ -n "$tp" ]; then tpj="\"$tp\""; else tpj=null; fi
  if [ -n "$mid" ]; then midj="\"$mid\""; else midj=null; fi
  mkdir -p "$CTX_DIR" 2>/dev/null || return 0
  file="$CTX_DIR/$sid.json"
  # First render of a session: prune what sessions that ended left behind. Both kinds —
  # the context files, and the gate's one-shot "already said unmeasured" markers. Sweeping
  # only the first meant the plugin pruned half of what it makes, and the markers came to
  # outnumber the files they sit beside.
  if [ ! -f "$file" ]; then
    find "$CTX_DIR" -name '*.json' -mtime +1 -delete 2>/dev/null
    find "$CTX_DIR" -name '*.gate-unmeasured' -mtime +1 -delete 2>/dev/null
    find "$CTX_DIR" -name '*.model' -mtime +1 -delete 2>/dev/null
  fi
  tmp="$file.tmp.$$"
  printf '{"session_id":"%s","context_percent":%s,"context_used":%s,"context_total":%s,"five_hour_percent":%s,"five_hour_resets_at":%s,"seven_day_percent":%s,"seven_day_resets_at":%s,"transcript_path":%s,"model_id":%s,"updated_epoch":%s}\n' \
    "$sid" "$ctx" "$used" "$total" "$h5" "$h5r" "$d7" "$d7r" "$tpj" "$midj" "$(date +%s)" > "$tmp" 2>/dev/null \
    && mv -f "$tmp" "$file" 2>/dev/null
  return 0
}
record

if [ $# -gt 0 ]; then
  printf '%s' "$input" | "$@"
  exit $?
fi

summary=$(printf '%s' "$input" | jq -r '
  def pct(v): if (v | type) == "number" then ((v | floor | tostring) + "%") else "~" end;
  "ctx: \(pct(.context_window.used_percentage)) │ 5h: \(pct(.rate_limits.five_hour.used_percentage)) │ 7d: \(pct(.rate_limits.seven_day.used_percentage))"' 2>/dev/null)
printf '%s\n' "${summary:-ctx: ~ │ 5h: ~ │ 7d: ~}"
exit 0
