"""Fixture transcripts for the conversation tail's cases: prints `key=value` lines that
run-tests.sh compares. argv[1] is the launcher's scripts directory, argv[2] a scratch directory."""
import datetime
import json
import os
import sys

sys.path.insert(0, sys.argv[1])
import conversation_tail as ct

WORK = sys.argv[2]
NOW = datetime.datetime(2026, 11, 20, 15, 0, 0, tzinfo=datetime.timezone.utc)
ENV = os.path.join(WORK, "env")
open(ENV, "w").write('# comment\nexport DEPLOY_KEY="s3cr3t-v4lue-0123"\nSHORT=abc\n')


def at(minutes):
    return (NOW - datetime.timedelta(minutes=minutes)).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def user(minutes, text, **extra):
    entry = {"type": "user", "timestamp": at(minutes), "origin": {"kind": "human"},
             "promptSource": "typed", "message": {"role": "user", "content": text}}
    entry.update(extra)
    return entry


def reply(minutes, text, **extra):
    entry = {"type": "assistant", "timestamp": at(minutes), "isSidechain": False,
             "message": {"role": "assistant", "model": "m", "content": [{"type": "text", "text": text}]}}
    entry.update(extra)
    return entry


def section(entries, name, pad=b""):
    path = os.path.join(WORK, name + ".jsonl")
    with open(path, "wb") as fh:
        fh.write(pad)
        for entry in entries:
            fh.write((json.dumps(entry) if isinstance(entry, dict) else entry).encode() + b"\n")
    return ct.section(path, NOW, ENV)


def out(key, value):
    print("%s=%s" % (key, str(value).replace("\n", "⏎")))


def has(text, *needles):
    return "|".join("1" if n in text else "0" for n in needles)


# The operator's messages: only the human origin, typed or not, counts.
others = [
    user(5, "FROM-PEER", origin={"kind": "peer", "name": "Orch: x"}),
    user(5, "FROM-PLUGIN", origin={"kind": "plugin", "name": "orchestrator"}),
    user(5, "FROM-TASK", origin={"kind": "task-notification", "producer": "session-task"}),
    user(5, "FROM-SYSTEM", promptSource="system"),
    user(5, "FROM-META", isMeta=True),
    user(5, "FROM-SIDECHAIN", isSidechain=True),
    user(5, [{"type": "tool_result", "tool_use_id": "t", "content": "FROM-TOOL-RESULT"}], origin=None),
    user(5, [{"type": "tool_result", "tool_use_id": "t", "content": "FROM-HUMAN-TOOL-RESULT"}]),
    user(4, "MINE-TYPED"),
    user(3, "MINE-QUEUED", promptSource="queued"),
    user(2, "<command-message>implement:phase</command-message>\n<command-name>/implement:phase</command-name>"),
]
text = section(others, "origins")
out("origins", has(text, "FROM-PEER", "FROM-PLUGIN", "FROM-TASK", "FROM-SYSTEM", "FROM-META",
                   "FROM-SIDECHAIN", "FROM-TOOL-RESULT", "FROM-HUMAN-TOOL-RESULT"))
out("mine", has(text, "MINE-TYPED", "MINE-QUEUED", "operator: /implement:phase", "command-message"))

# The replies: the text parts of the main thread, nothing synthetic, no API error, no sidechain.
replies = [
    user(8, "ASK"),
    reply(7, "REPLY-OK"),
    reply(7, "REPLY-SIDECHAIN", isSidechain=True),
    reply(7, "REPLY-ERROR", isApiErrorMessage=True),
    {"type": "assistant", "timestamp": at(7), "message": {"model": "<synthetic>",
                                                          "content": [{"type": "text", "text": "REPLY-SYNTHETIC"}]}},
    {"type": "assistant", "timestamp": at(6), "message": {"model": "m", "content": [
        {"type": "thinking", "thinking": "REPLY-THINKING"},
        {"type": "tool_use", "name": "Bash", "input": {"command": "REPLY-TOOL-USE"}},
        {"type": "text", "text": "REPLY-TEXT-PART"}]}},
    "not json at all",
]
text = section(replies, "replies")
out("replies", has(text, "REPLY-OK", "REPLY-TEXT-PART", "REPLY-SIDECHAIN", "REPLY-ERROR", "REPLY-SYNTHETIC",
                   "REPLY-THINKING", "REPLY-TOOL-USE"))

# Fewer than 3 messages in 10 minutes: the 3 last, whatever their age.
old = [user(90, "M1"), reply(89, "R1"), user(60, "M2"), reply(59, "R2"), user(50, "M3"), reply(49, "R3"),
       user(40, "M4"), reply(39, "R4")]
text = section(old, "few")
out("few", has(text, "M1", "R1", "M2", "R2", "M3", "R3", "M4", "R4"))

# 3 messages inside the 10 minutes: those minutes, the 4th and 5th messages included.
recent = [user(30, "N1"), reply(29, "S1"), user(9, "N2"), reply(9, "S2"), user(8, "N3"), user(2, "N4"),
          user(1, "N5"), reply(0, "S5")]
text = section(recent, "many")
out("many", has(text, "N1", "S1", "N2", "S2", "N3", "N4", "N5", "S5"))

# Two messages in all: both are kept, however old.
text = section([user(500, "ONLY1"), reply(499, "ONLYR"), user(400, "ONLY2")], "two")
out("two", has(text, "ONLY1", "ONLYR", "ONLY2"))

# No message of the operator: the heading says so.
text = section([reply(3, "ALONE")], "none")
out("none", has(text, "ALONE", "no message of the operator"))

# Paris time: winter UTC+1, summer UTC+2.
winter = ct.paris(datetime.datetime(2026, 11, 20, 15, 39, tzinfo=datetime.timezone.utc))
summer = ct.paris(datetime.datetime(2026, 7, 1, 10, 0, tzinfo=datetime.timezone.utc))
out("paris", "%s|%s" % (winter, summer))
text = section([user(1, "TIME")], "time")
out("time", has(text, "[15:59] operator: TIME"))

# Size: a long reply keeps its head and its tail, a fenced command stays whole, the section is capped.
long = "HEAD-MARK " + "word " * 1200 + " TAIL-MARK"
text = section([user(2, "Q"), reply(1, long)], "long")
body = text.split("\n", 1)[1].split("orchestrator: ", 1)[1]
out("long", "%s|%d" % (has(text, "HEAD-MARK", "TAIL-MARK"), 1 if len(body) <= ct.REPLY_CAP + 100 else 0))
command = "```bash\n" + "echo " + "x" * 1300 + " END-OF-COMMAND\n```"
fenced = "PROSE-START " + "word " * 600 + command + " " + "word " * 600 + " PROSE-END"
text = section([user(2, "Q"), reply(1, fenced)], "fenced")
out("fenced", has(text, command, "PROSE-START", "PROSE-END"))
big = []
for i in range(40):
    big += [user(9 - i * 0.2, "ASK-%02d" % i), reply(9.1 - i * 0.2 - 0.1, "ANSWER-%02d " % i + "filler " * 190)]
text = section(big, "capped")
out("capped", "%d|%s" % (1 if len(text) <= ct.SECTION_CAP + 200 else 0, has(text, "ASK-39", "ANSWER-39", "ASK-00")))
# The oldest exchange goes first: what stays is a whole, recent run.
kept = [i for i in range(40) if "ASK-%02d" % i in text]
out("capped_run", 1 if kept and kept == list(range(kept[0], 40)) and len(kept) > 1 else 0)

# Secrets are masked before they are printed, each pattern on a line of its own.
lines = [
    "token ghp_abcdefghijklmnopqrstuvwxyz0123456789 and SHORT=abc",
    "ant sk-ant-abcdefghijklmnopqrstuvwx",
    "Authorization: Token abcdefgh12345678",
    "curl -H 'X: Bearer zzzzzzzz9999yyyy'",
    "jwt eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2Q",
    "-----BEGIN RSA PRIVATE KEY-----\nPRIVATEBODY\n-----END RSA PRIVATE KEY-----",
    "aws AKIAIOSFODNN7EXAMPLE",
    "slack xoxb-1234567890-abcdefghij",
    "GET https://example.org/x?api_key=tttt1111&b=1",
    "with DEPLOY_KEY=whatever and s3cr3t-v4lue-0123 and --password hunter2hunter2",
    "and https://user:pw123@host.example/x",
    "curl -u admin:hunter22 x",
    "mysql -pSuperSecret1 db",
    'password="a b c secret"',
    "password: plain-text-pass",
    "random AbCdEfGhIjKlMnOpQrStUvWxYz012345",
]
secret = "\n".join(lines)
text = section([user(2, "Q"), reply(1, secret)], "secret")
out("secret_gone", has(text, "ghp_abcdef", "abcdefghijklmnopqrstuvwx", "abcdefgh12345678", "zzzzzzzz9999yyyy",
                       "SflKxwRJSMeKKF2Q", "PRIVATEBODY", "AKIAIOSFODNN7EXAMPLE", "abcdefghij", "tttt1111", "whatever",
                       "s3cr3t-v4lue-0123", "hunter2hunter2", "pw123", "hunter22", "SuperSecret1", "a b c secret",
                       "c secret", "plain-text-pass", "AbCdEfGhIjKlMnOpQrStUvWxYz012345"))
out("secret_marks", has(text, "[REDACTED:github-token]", "[REDACTED:anthropic-key]", "[REDACTED:authorization]",
                        "[REDACTED:bearer]", "[REDACTED:jwt]", "[REDACTED:private-key]", "[REDACTED:aws-key]",
                        "[REDACTED:slack-token]", "[REDACTED:url-secret]", "[REDACTED:env]", "[REDACTED:secret-flag]",
                        "[REDACTED:url-credentials]", "[REDACTED:user-password]", "[REDACTED:password-flag]",
                        "[REDACTED:secret-assignment]", "[REDACTED:entropy]", "SHORT=abc"))
text = section([user(2, "my key is s3cr3t-v4lue-0123")], "secret-operator")
out("secret_operator", has(text, "s3cr3t-v4lue-0123", "[REDACTED:env]"))
# A secret that straddles the cap is masked whole, never cut in half.
straddle = "a " * 445 + "ghp_abcdefghijklmnopqrstuvwxyz0123456789 " + "b " * 800
text = section([user(2, "Q"), reply(1, straddle)], "straddle")
out("straddle", has(text, "ghp_", "[REDACTED"))

# One exchange alone over the section's cap: the newest lines stay, the last reply whole.
fat = [user(3, "FAT-ASK"), reply(2.5, "FAT-ONE\n```\n" + "x" * 6000 + "\n```"),
       reply(2, "FAT-TWO\n```\n" + "y" * 6000 + "\n```"), reply(1, "FAT-THREE\n```\n" + "z" * 6000 + "\nFAT-END\n```")]
text = section(fat, "fat")
out("fat", "%s|%d" % (has(text, "FAT-ASK", "FAT-ONE", "FAT-TWO", "FAT-THREE", "FAT-END"),
                      1 if len(text) <= ct.SECTION_CAP + 200 else 0))
text = section([user(2, "Q"), reply(1, "```\n" + "w" * 20000 + "\nLAST-WORD\n```")], "fatter")
out("fatter", "%s|%d" % (has(text, "LAST-WORD", "orchestrator: "), 1 if len(text) <= ct.SECTION_CAP + 200 else 0))

# Only the last MiB of a huge transcript are read, and the line cut where the read began is dropped.
pad = b"x" * (ct.TAIL_BYTES + 1000) + b"\n"
path = os.path.join(WORK, "huge.jsonl")
with open(path, "wb") as fh:
    fh.write(pad)
    fh.write(json.dumps(user(2, "HUGE-ASK")).encode() + b"\n")
lines = ct.read_tail(path)
out("huge", "%d|%s" % (len(lines), has(ct.section(path, NOW, ENV), "HUGE-ASK")))
cut = os.path.join(WORK, "cut.jsonl")
with open(cut, "wb") as fh:
    fh.write(b'{"type":"user","timestamp":"' + b"y" * ct.TAIL_BYTES + b'"}\n')
    fh.write(json.dumps(user(2, "CUT-ASK")).encode() + b"\n")
out("cut", len(ct.read_tail(cut)))

# A transcript that cannot be read is said, never raised.
out("missing", has(ct.section(os.path.join(WORK, "absent.jsonl"), NOW, ENV), "cannot be read"))

# A long text of the words a pattern looks for is read in linear time, never a hang before the kill.
import time
began = time.time()
ct.redact("pass." * 20000 + "mysql " * 20000 + "secret-" * 20000 + "a:b " * 20000, ENV)
out("fast", 1 if time.time() - began < 10 else 0)

# The operator's own words are never cut, whatever their length; a reply's are.
words = "OP-START " + "word " * 1000 + "OP-END"
text = section([user(2, words)], "operator-long")
out("operator_long", has(text, "OP-START", "OP-END", "[…]"))
