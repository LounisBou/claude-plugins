// Pull of the bug inboxes, one process per machine: `pm2 start pm2.config.js && pm2 save`.
// `pull --watch` long-polls Telegram: each getUpdates request is held open (50 s) until a message
// arrives, then the next round starts at once, so a report lands in the inbox within a second or
// two instead of up to 15 minutes later. The script loops by itself and exits only when PM2 stops
// it (its SIGINT/SIGTERM interrupt the held request). No `cron_restart`: PM2's cron fires twice
// around a boundary (10:59:59 then 11:00:00, measured 2026-10-02) and its second tick killed the
// run the first had just started.
// PM2 runs the version-independent launcher (`/bugs-bot:install` installs it, then starts this app), never a path inside the
// plugin's versioned cache directory: `pm2 save` records the script, and a plugin update removes the
// old version's directory. A restart then runs the newest installed version.
const path = require('path');
const os = require('os');

const launcherDir = process.env.BUGS_BOT_LAUNCHER_DIR || path.join(os.homedir(), '.local', 'bin');

module.exports = {
  apps: [{
    name: 'bugs-bot-pull',
    script: path.join(launcherDir, 'bugs-bot'),
    args: 'pull --watch',
    // The launcher is a shell script: run it as it is.
    interpreter: 'none',
    // PM2 otherwise records the directory of the shell that ran `pm2 start`, which may be deleted later.
    cwd: os.homedir(),
    // The launcher runs the interpreter `/bugs-bot:install` remembered in ~/.bugs-bot/python (found on
    // the machine, or installed with uv when none was), read at each start: no PM2 env is needed for it.
    // BUGS_BOT_PYTHON, when set at `pm2 start`, still wins: a pyenv interpreter itself, not its shim
    // (the shim needs a shell environment PM2 lacks).
    env: process.env.BUGS_BOT_PYTHON ? { BUGS_BOT_PYTHON: process.env.BUGS_BOT_PYTHON } : {},
    autorestart: true,
    // A loop that dies at start (a broken interpreter) must not spin: wait before each restart.
    restart_delay: 60000,
    // PM2 SIGKILLs after this: the stop signal ends the held request at once, so it is only a ceiling.
    kill_timeout: 5000,
  }],
};
