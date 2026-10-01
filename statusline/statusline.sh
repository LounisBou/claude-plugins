#!/bin/bash
# Two-line status line:
#   1. directory │ branch[*↑↓{n}] │ open PR │ model │ session name
#   2. context │ 5-hour quota │ 7-day quota │ lines +/-
#
# Every value comes from the JSON payload the host sends on stdin. No network
# calls, no state, no credentials. Git status is the only external command.
#
# The 5-hour and 7-day quotas are read from `.rate_limits` in that payload:
# the host exposes them natively, so no web session cookie is involved. See
# docs/design-v3.md and the "Migrating from a session-cookie install" section
# of the README.
#
# STATUSBAR_CONFIG points at an alternate settings file (the test
# suite uses it to isolate each case).

config_file="${STATUSBAR_CONFIG:-$HOME/.claude/statusline-config.txt}"
if [ -f "$config_file" ]; then
  source "$config_file"
fi
show_dir=${SHOW_DIRECTORY:-1}
show_branch=${SHOW_BRANCH:-1}
show_usage=${SHOW_USAGE:-1}
show_bar=${SHOW_PROGRESS_BAR:-1}
show_reset=${SHOW_RESET_TIME:-1}
show_seven=${SHOW_SEVEN_DAY:-1}
show_pr=${SHOW_PR:-1}
show_model=${SHOW_MODEL:-1}
show_ctx=${SHOW_CONTEXT:-1}
show_ctx_tokens=${SHOW_CONTEXT_TOKENS:-1}
show_gitst=${SHOW_GIT_STATUS:-1}
show_sname=${SHOW_SESSION_NAME:-1}
show_lines=${SHOW_LINES_CHANGED:-1}
countdown=${RESET_COUNTDOWN:-1}

input=$(cat)

BLUE=$'\033[0;34m'
GREEN=$'\033[0;32m'
GRAY=$'\033[0;90m'
YELLOW=$'\033[0;33m'
RED=$'\033[0;31m'
CYAN=$'\033[0;36m'
MAGENTA=$'\033[0;35m'
RESET=$'\033[0m'

# Ten-step gradient: deep green → deep red.
LEVEL_1=$'\033[38;5;22m'
LEVEL_2=$'\033[38;5;28m'
LEVEL_3=$'\033[38;5;34m'
LEVEL_4=$'\033[38;5;100m'
LEVEL_5=$'\033[38;5;142m'
LEVEL_6=$'\033[38;5;178m'
LEVEL_7=$'\033[38;5;172m'
LEVEL_8=$'\033[38;5;166m'
LEVEL_9=$'\033[38;5;160m'
LEVEL_10=$'\033[38;5;124m'

separator="${GRAY} │ ${RESET}"

# A single jq call: each fork costs ~5 ms and the status line is rendered
# continuously. The field separator is 0x1F (unit separator) and deliberately
# NOT a tab: tabs belong to IFS whitespace, so bash collapses consecutive tabs
# and two empty fields in a row would silently shift every field after them.
# cur_path stays LAST: read assigns the remainder of the line to its final
# variable, so a missing field elsewhere cannot corrupt it.
US=$'\037'
IFS="$US" read -r h5_pct h5_reset d7_pct d7_reset pr_num pr_state model_name \
  ctx_pct ctx_used ctx_size lines_add lines_del session_name cur_path <<<"$(
  printf '%s' "$input" | jq -r --arg us "$US" '[
    .rate_limits.five_hour.used_percentage  // "",
    .rate_limits.five_hour.resets_at        // "",
    .rate_limits.seven_day.used_percentage  // "",
    .rate_limits.seven_day.resets_at        // "",
    .pr.number                              // "",
    .pr.review_state                        // "",
    .model.display_name                     // "",
    .context_window.used_percentage         // "",
    (.context_window.current_usage
      | if type == "object"
        then ([.input_tokens, .cache_creation_input_tokens, .cache_read_input_tokens] | map(numbers)
              | if length == 0 then "" else add end)
        else "" end),
    .context_window.context_window_size     // "",
    .cost.total_lines_added                 // "",
    .cost.total_lines_removed               // "",
    .session_name                           // "",
    .workspace.current_dir // .cwd          // ""
  ] | map(tostring) | join($us)' 2>/dev/null
)"

# --- helpers ----------------------------------------------------------------

is_number() { case "$1" in ''|*[!0-9]*) return 1 ;; *) return 0 ;; esac; }

# Gradient color matching an integer percentage.
usage_color() {
  local p=$1
  if   [ "$p" -le 10 ]; then printf '%s' "$LEVEL_1"
  elif [ "$p" -le 20 ]; then printf '%s' "$LEVEL_2"
  elif [ "$p" -le 30 ]; then printf '%s' "$LEVEL_3"
  elif [ "$p" -le 40 ]; then printf '%s' "$LEVEL_4"
  elif [ "$p" -le 50 ]; then printf '%s' "$LEVEL_5"
  elif [ "$p" -le 60 ]; then printf '%s' "$LEVEL_6"
  elif [ "$p" -le 70 ]; then printf '%s' "$LEVEL_7"
  elif [ "$p" -le 80 ]; then printf '%s' "$LEVEL_8"
  elif [ "$p" -le 90 ]; then printf '%s' "$LEVEL_9"
  else printf '%s' "$LEVEL_10"
  fi
}

# Ten-block bar, rounded to nearest.
make_bar() {
  local p=$1 filled i=0 bar=""
  if   [ "$p" -le 0 ];   then filled=0
  elif [ "$p" -ge 100 ]; then filled=10
  else filled=$(( (p * 10 + 50) / 100 ))
  fi
  while [ $i -lt $filled ]; do bar="${bar}▓"; i=$((i + 1)); done
  while [ $i -lt 10 ];     do bar="${bar}░"; i=$((i + 1)); done
  printf ' %s' "$bar"
}

# Local time, honouring the system 12h/24h preference.
# LC_ALL=C matters: under some locales %p renders empty and 20:30 would come
# out as 08:30.
fmt_time() {
  if [ "$(defaults read -g AppleICUForce24HourTime 2>/dev/null)" = "1" ]; then
    date -r "$1" "+%H:%M" 2>/dev/null
  else
    LC_ALL=C date -r "$1" "+%I:%M %p" 2>/dev/null
  fi
}

# The 7-day reset lands days away, so a date reads better than a clock time.
fmt_date() { date -r "$1" "+%d/%m" 2>/dev/null; }

# Time left before an epoch: "3d" (rounded to the day), "2h13", "47m".
fmt_countdown() {
  local rem=$(( $1 - $(date +%s) ))
  [ "$rem" -gt 0 ] || return 1
  if [ "$rem" -ge 86400 ]; then
    printf '%dd' $(( (rem + 43200) / 86400 ))
  elif [ "$rem" -ge 3600 ]; then
    printf '%dh%02d' $(( rem / 3600 )) $(( (rem % 3600) / 60 ))
  else
    printf '%dm' $(( rem / 60 ))
  fi
}

# Assembles "label: NN% [bar] → reset" for one quota window.
# $1 label, $2 percentage (float), $3 reset epoch,
# $4 time|date (format used when RESET_COUNTDOWN=0)
window_text() {
  local label=$1 pct=${2%%.*} epoch=$3 mode=$4 bar="" tail="" reset

  is_number "$pct" || return 1
  [ "$show_bar" = "1" ] && bar=$(make_bar "$pct")

  if [ "$show_reset" = "1" ] && is_number "$epoch"; then
    if [ "$countdown" = "1" ]; then reset=$(fmt_countdown "$epoch")
    elif [ "$mode" = "date" ]; then reset=$(fmt_date "$epoch")
    else reset=$(fmt_time "$epoch")
    fi
    [ -n "$reset" ] && tail=" → ${reset}"
  fi

  printf '%s%s: %s%%%s%s%s' "$(usage_color "$pct")" "$label" "$pct" "$bar" "$tail" "$RESET"
}

# Concatenates with the separator. No nameref: macOS ships bash 3.2.
# $1 accumulator, $2 segment; prints the new value.
join_sep() {
  if [ -n "$1" ]; then printf '%s%s%s' "$1" "$separator" "$2"; else printf '%s' "$2"; fi
}

# --- line 1: context --------------------------------------------------------

line1=""

if [ "$show_dir" = "1" ] && [ -n "$cur_path" ]; then
  line1=$(join_sep "$line1" "${BLUE}$(basename "$cur_path")${RESET}")
fi

# -C "$cur_path": the branch must describe the directory being displayed, not
# the process working directory, which can differ after a mid-session cd.
# One git call yields branch, dirty/clean, ahead/behind and stash count.
if [ "$show_branch" = "1" ] && [ -n "$cur_path" ]; then
  git_out=$(git -C "$cur_path" status --porcelain=v2 --branch --show-stash 2>/dev/null)
  if [ -n "$git_out" ]; then
    branch="" ahead=0 behind=0 stash=0 dirty=0
    while IFS= read -r gline; do
      case "$gline" in
        "# branch.head "*) branch=${gline#"# branch.head "} ;;
        "# branch.ab "*)   set -- ${gline#"# branch.ab "}; ahead=${1#+}; behind=${2#-} ;;
        "# stash "*)       stash=${gline#"# stash "} ;;
        "#"*)              : ;;
        ?*)                dirty=1 ;;
      esac
    done <<<"$git_out"
    if [ -n "$branch" ]; then
      seg="${GREEN}⎇ ${branch}${RESET}"
      if [ "$show_gitst" = "1" ]; then
        [ "$dirty" = "1" ] && seg="${seg}${YELLOW}*${RESET}"
        arrows=""
        is_number "$ahead"  && [ "$ahead"  -gt 0 ] && arrows="↑${ahead}"
        is_number "$behind" && [ "$behind" -gt 0 ] && arrows="${arrows}↓${behind}"
        [ -n "$arrows" ] && seg="${seg} ${CYAN}${arrows}${RESET}"
        is_number "$stash" && [ "$stash" -gt 0 ] && seg="${seg} ${GRAY}{${stash}}${RESET}"
      fi
      line1=$(join_sep "$line1" "$seg")
    fi
  fi
fi

# pr is only present while an open PR exists for the current branch.
if [ "$show_pr" = "1" ] && is_number "$pr_num"; then
  case "$pr_state" in
    approved)          pr_color="$GREEN";  pr_mark="✓" ;;
    changes_requested) pr_color="$RED";    pr_mark="✗" ;;
    draft)             pr_color="$GRAY";   pr_mark="✎" ;;
    pending)           pr_color="$YELLOW"; pr_mark="⋯" ;;
    *)                 pr_color="$CYAN";   pr_mark=""  ;;
  esac
  [ -n "$pr_mark" ] && pr_mark=" ${pr_mark}"
  line1=$(join_sep "$line1" "${pr_color}PR #${pr_num}${pr_mark}${RESET}")
fi

if [ "$show_model" = "1" ] && [ -n "$model_name" ]; then
  line1=$(join_sep "$line1" "${MAGENTA}${model_name}${RESET}")
fi

if [ "$show_sname" = "1" ] && [ -n "$session_name" ]; then
  sname=$session_name
  [ "${#sname}" -gt 24 ] && sname="${sname:0:24}…"
  line1=$(join_sep "$line1" "${GRAY}${sname}${RESET}")
fi

# --- line 2: metrics --------------------------------------------------------

line2=""

# 296603 -> 296k, rounded down; under 1,000 printed as is.
fmt_tokens() {
  if [ "$1" -ge 1000 ]; then printf '%dk' $(( $1 / 1000 )); else printf '%d' "$1"; fi
}

# The session's context gate, in tokens, resolved exactly as the orchestrator's
# context gate hook does (same variables, same defaults) so the bar and the
# gate never disagree: a fixed token count on a large window, a percentage of
# the window otherwise. Prints nothing when the window size is unknown.
# The gate only applies to orchestration sessions: they are named "Orch : …",
# "Agent : …", "Audit : …" or "Coord : …".
ctx_gate_tokens() {
  local name=${session_name#\"}
  case "$name" in
    "Orch :"*|"Agent :"*|"Audit :"*|"Coord :"*) ;;
    *) return 0 ;;
  esac
  is_number "$ctx_size" || return 0
  if [ "$ctx_size" -ge "${ORCHESTRATOR_LARGE_WINDOW:-1000000}" ]; then
    printf '%s' "${ORCHESTRATOR_CONTEXT_GATE_TOKENS:-300000}"
  else
    printf '%d' $(( ctx_size * ${ORCHESTRATOR_CONTEXT_GATE:-80} / 100 ))
  fi
}

# >= 80% is roughly the auto-compaction threshold: context loss is close.
if [ "$show_ctx" = "1" ]; then
  cpct=${ctx_pct%%.*}
  if is_number "$cpct"; then
    ctx_text="ctx: ${cpct}%"
    if [ "$show_ctx_tokens" = "1" ] && is_number "$ctx_used"; then
      ctx_text="${ctx_text} · $(fmt_tokens "$ctx_used")"
      gate=$(ctx_gate_tokens)
      is_number "$gate" && ctx_text="${ctx_text}/$(fmt_tokens "$gate")"
    fi
    if [ "$cpct" -ge 80 ]; then
      line2=$(join_sep "$line2" "${RED}⚠ ${ctx_text}${RESET}")
    else
      line2=$(join_sep "$line2" "$(usage_color "$cpct")${ctx_text}${RESET}")
    fi
  fi
fi

if [ "$show_usage" = "1" ]; then
  quota_shown=0
  if text=$(window_text "5h" "$h5_pct" "$h5_reset" time); then
    line2=$(join_sep "$line2" "$text"); quota_shown=1
  fi
  if [ "$show_seven" = "1" ] && text=$(window_text "7d" "$d7_pct" "$d7_reset" date); then
    line2=$(join_sep "$line2" "$text"); quota_shown=1
  fi
  # rate_limits only shows up after the session's first API response.
  [ "$quota_shown" = "0" ] && line2=$(join_sep "$line2" "${YELLOW}Usage: ~${RESET}")
fi

if [ "$show_lines" = "1" ] && is_number "$lines_add" && is_number "$lines_del" &&
   [ $(( lines_add + lines_del )) -gt 0 ]; then
  line2=$(join_sep "$line2" "${GREEN}+${lines_add}${RESET}/${RED}-${lines_del}${RESET}")
fi

[ -n "$line1" ] && printf '%s\n' "$line1"
[ -n "$line2" ] && printf '%s\n' "$line2"
