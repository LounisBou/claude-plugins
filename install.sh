#!/usr/bin/env bash
# /pr-review:install, and /pr-review:doctor with --check.
#
# Without --check it first gives the machine a GitHub login the skills can use,
# each step skipped when already satisfied:
#   1. GH_TOKEN set in the environment: nothing to do.
#   2. gh missing: install it. macOS uses Homebrew. Linux uses the official
#      release binary, unpacked into ~/.local/bin: it needs no root and no
#      package manager, and every distribution gets the current release.
#   3. gh holds no token: `gh auth login --web`, which opens the browser on
#      GitHub's device page and copies the one-time code to the clipboard.
# The token belongs to gh, which keeps it in the system credential store. This
# script never reads it into a variable, prints it or writes it anywhere: it
# only asks gh whether one exists.
#
# Then, and alone with --check, it runs the preflight every skill runs, which
# writes nothing. Removing the plugin is the uninstall; gh and its login stay,
# because they are the user's own tools.
set -u

ROOT=$(cd "$(dirname "$0")" && pwd)
LOCAL_BIN="$HOME/.local/bin"

die() {
  printf 'error: %s\n' "$1" >&2
  printf 'fix:   %s\n' "$2" >&2
  exit "$3"
}

# gh on PATH, or the copy a previous run unpacked into ~/.local/bin, which a
# fresh machine's PATH does not always include.
find_gh() {
  if command -v gh >/dev/null 2>&1; then
    command -v gh
  elif [ -x "$LOCAL_BIN/gh" ]; then
    printf '%s\n' "$LOCAL_BIN/gh"
  fi
}

install_gh_macos() {
  command -v brew >/dev/null 2>&1 \
    || die "gh is not installed and Homebrew is not on PATH" \
           "install Homebrew (https://brew.sh), then run /pr-review:install again" 11
  echo "pr-review: installing gh with Homebrew..."
  HOMEBREW_NO_AUTO_UPDATE=1 brew install gh >&2 \
    || die "brew install gh failed" "run: brew install gh   then /pr-review:install again" 11
}

install_gh_linux() {
  command -v curl >/dev/null 2>&1 || die "curl not found on PATH" "install curl" 11
  command -v tar >/dev/null 2>&1 || die "tar not found on PATH" "install tar" 11
  local arch latest tag version name tmp base expected actual
  case "$(uname -m)" in
    x86_64 | amd64) arch=amd64 ;;
    aarch64 | arm64) arch=arm64 ;;
    armv6l | armv7l) arch=armv6 ;;
    i386 | i686) arch=386 ;;
    *) die "no gh release for this machine: $(uname -m)" "install gh by hand: https://cli.github.com" 11 ;;
  esac
  # The latest release page redirects to its tag; the tag names the archive.
  latest=$(curl -fsSLI -o /dev/null -w '%{url_effective}' https://github.com/cli/cli/releases/latest) \
    || die "could not reach github.com to find the latest gh release" \
           "check the network, then run /pr-review:install again" 11
  tag=${latest##*/}
  case "$tag" in
    v[0-9]*) : ;;
    *) die "could not read the latest gh release from $latest" "install gh by hand: https://cli.github.com" 11 ;;
  esac
  version=${tag#v}
  name="gh_${version}_linux_${arch}"
  tmp=$(mktemp -d) || die "could not create a temporary directory" "check that TMPDIR is writable" 11
  echo "pr-review: installing gh $version into $LOCAL_BIN..."
  base="https://github.com/cli/cli/releases/download/$tag"
  if ! curl -fsSL -o "$tmp/gh.tar.gz" "$base/$name.tar.gz" \
    || ! curl -fsSL -o "$tmp/checksums.txt" "$base/gh_${version}_checksums.txt"; then
    rm -rf "$tmp"
    die "could not download gh $version" "check the network, then run /pr-review:install again" 11
  fi
  # A binary fetched over the network runs only once it matches the release's
  # own checksum list: a missing line is a refusal, like a wrong one.
  expected=$(grep "  $name.tar.gz\$" "$tmp/checksums.txt" | head -n 1)
  expected=${expected%% *}
  if command -v sha256sum >/dev/null 2>&1; then
    actual=$(sha256sum "$tmp/gh.tar.gz")
  elif command -v shasum >/dev/null 2>&1; then
    actual=$(shasum -a 256 "$tmp/gh.tar.gz")
  else
    rm -rf "$tmp"
    die "neither sha256sum nor shasum is on PATH, so the gh download cannot be checked" "install coreutils, then run /pr-review:install again" 11
  fi
  actual=${actual%% *}
  if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
    rm -rf "$tmp"
    die "the gh $version archive does not match its release checksum" "install gh by hand: https://cli.github.com" 11
  fi
  if ! tar -xzf "$tmp/gh.tar.gz" -C "$tmp" \
    || ! mkdir -p "$LOCAL_BIN" \
    || ! cp "$tmp/$name/bin/gh" "$LOCAL_BIN/gh" \
    || ! chmod 755 "$LOCAL_BIN/gh"; then
    rm -rf "$tmp"
    die "could not install gh $version into $LOCAL_BIN" "install gh by hand: https://cli.github.com" 11
  fi
  rm -rf "$tmp"
  case ":$PATH:" in
    *":$LOCAL_BIN:"*) : ;;
    *) echo "pr-review: add $LOCAL_BIN to PATH so your shell finds gh as well" ;;
  esac
}

github_login() {
  if [ -n "${GH_TOKEN:-}" ]; then
    echo "pr-review: GitHub token: from GH_TOKEN"
    return 0
  fi

  local gh_bin flags
  gh_bin=$(find_gh)
  if [ -z "$gh_bin" ]; then
    case "$(uname -s)" in
      Darwin) install_gh_macos ;;
      Linux) install_gh_linux ;;
      *) die "gh is not installed" "install gh (https://cli.github.com), then run /pr-review:install again" 11 ;;
    esac
    gh_bin=$(find_gh)
    [ -n "$gh_bin" ] || die "gh was installed but cannot be found" "open a new shell, then run /pr-review:install again" 11
  fi

  # Only the exit code is read: the token itself goes to /dev/null.
  if "$gh_bin" auth token --hostname github.com >/dev/null 2>&1; then
    echo "pr-review: GitHub login: found in gh"
    return 0
  fi

  # Without a terminal gh skips its "press Enter" prompt and opens the browser
  # at once. The one-time code it prints is copied to the clipboard as well,
  # where this gh supports it, because a caller that captures the output shows
  # it only once the login is over.
  flags="--hostname github.com --git-protocol https --web"
  if "$gh_bin" auth login --help 2>/dev/null | grep -q -- '--clipboard'; then
    flags="$flags --clipboard"
  fi
  echo "pr-review: no GitHub login found. A browser page opens: paste the one-time code (it is on the clipboard) and approve."
  # shellcheck disable=SC2086
  "$gh_bin" auth login $flags </dev/null >&2
  "$gh_bin" auth token --hostname github.com >/dev/null 2>&1 \
    || die "the GitHub login did not complete" "/pr-review:install" 12
  echo "pr-review: GitHub login: done"
}

check_only=0
[ "${1:-}" = "--check" ] && check_only=1

code=0
if [ "$check_only" -eq 0 ] && [ "${PR_REVIEW_SKIP_AUTH:-0}" != "1" ]; then
  # A subshell, so a die in the login stops the login and not the report.
  ( github_login )
  code=$?
fi

# Capture the preflight's own exit code. `if cmd; then ...; fi` with no else
# branch leaves $? at 0 when the condition fails, so reading it after the fi
# would report success for a failed check — in the one script whose whole job
# is to report that failure.
if [ "$code" -eq 0 ]; then
  bash "$ROOT/scripts/preflight.sh"
  code=$?
fi

if [ "$code" -eq 0 ]; then
  echo "pr-review: all dependencies satisfied."
  echo
  echo "Skills available:"
  echo "  /pr-review:start-review       walk through review feedback one item at a time"
  echo "  /pr-review:process-comments   work through a PR's comments interactively"
  echo "  /pr-review:auto-fix-loop      review, fix and re-review until clean"
  echo
  echo "GitHub tool: provided by the github plugin dependency"
  exit 0
fi

echo "pr-review: not ready. Fix the item above, then run /pr-review:install again." >&2
exit "$code"
