#!/bin/sh
# hooks/log-append.sh <log> <line> <cap>
# One line appended to the hooks module's log, shared by every session on the machine.
# The host's file API has no append and refuses a read past 4 MiB, so a read-then-write
# of the whole log lost the lines another session wrote in between, and wiped the history
# the day the log crossed the read limit. An O_APPEND write of one short line is never
# interleaved with another's; past the cap the log is moved to <log>.1 (the one previous
# generation kept) under a directory lock, so two sessions rotating at once never move
# the fresh file over the old one.
log=$1
line=$2
cap=${3:-2097152}
mkdir -p "${log%/*}" 2>/dev/null
size() { if [ -f "$log" ]; then echo $(( $(wc -c < "$log") )); else echo 0; fi; }
if [ "$(size)" -gt "$cap" ]; then
    # A lock its holder died with is older than a minute: it is taken back.
    find "$log.lock" -maxdepth 0 -mmin +1 -exec rmdir {} \; 2>/dev/null
    if mkdir "$log.lock" 2>/dev/null; then
        [ "$(size)" -gt "$cap" ] && mv -f "$log" "$log.1"
        rmdir "$log.lock" 2>/dev/null
    fi
fi
printf '%s\n' "$line" >> "$log"
