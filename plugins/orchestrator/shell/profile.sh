# orchestrator shell file: sourced from the profile of zsh or bash by one line that
# `/orchestrator-install` adds. The plugin keeps the copy current: edit the plugin's file, never the copy.
#
# A tab opened by hand is the child of no host session. An app that a session started carries
# that session's identity and nesting marks, and a host command typed there took itself for the
# session's child and wrote no transcript. An interactive login shell on a terminal drops them,
# any other shell keeps them. The launcher unsets the same names in its own tabs (`NESTING_ENV`
# in iterm_agent.py), and a test holds the two lists equal.
if [ -n "${ZSH_VERSION-}" ]; then
  [[ -o interactive && -o login && -t 0 ]] && __orchestrator_tab=1
elif [ -n "${BASH_VERSION-}" ]; then
  case $- in *i*) shopt -q login_shell && [ -t 0 ] && __orchestrator_tab=1 ;; esac
fi
if [ -n "${__orchestrator_tab-}" ]; then
  unset CLAUDECODE CLAUDE_PID CLAUDE_CODE_SESSION_ID CLAUDE_CODE_CHILD_SESSION CLAUDE_CODE_CHILD_NOTES_DIR CLAUDE_CODE_BRIDGE_SESSION_ID CLAUDE_CODE_MESSAGING_SOCKET CLAUDE_CODE_MESSAGING_TOKEN CLAUDE_CODE_SESSION_ATTENDED
fi
unset __orchestrator_tab
