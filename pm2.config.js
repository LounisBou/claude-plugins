// Pull of the TM Bugs inbox: `pm2 start pm2.config.js && pm2 save`.
// `pull --watch` long-polls Telegram: each getUpdates request is held open (50 s) until a message
// arrives, then the next round starts at once, so a report lands in the inbox within a second or
// two instead of up to 15 minutes later. The script loops by itself and exits only when PM2 stops
// it (its SIGINT/SIGTERM interrupt the held request). No `cron_restart`: PM2's cron fires twice
// around a boundary (10:59:59 then 11:00:00, measured 2026-10-02) and its second tick killed the
// run the first had just started.
module.exports = {
  apps: [{
    name: 'tm-bugs-pull',
    script: __dirname + '/bin/bugs-bot',
    args: 'pull --watch',
    // The pyenv interpreter itself, not its shim: the shim needs a shell environment PM2 lacks.
    interpreter: '/Users/izno/.pyenv/versions/3.12.4/bin/python3',
    autorestart: true,
    // A loop that dies at start (a broken interpreter) must not spin: wait before each restart.
    restart_delay: 60000,
    // PM2 SIGKILLs after this: the stop signal ends the held request at once, so it is only a ceiling.
    kill_timeout: 5000,
  }],
};
