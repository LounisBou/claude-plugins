"""The operations files: the PM2 process definition and the Bot API root."""

from __future__ import annotations

import json
import os
import shutil
import subprocess

import pytest

from bugs_bot.errors import BugsError
from bugs_bot.telegram import TelegramChannel, api_root
from conftest import REPO_ROOT
from samples import FakeTelegram


def _pm2_app(python: str | None, launcher_dir: str | None = None) -> dict:
    """Evaluate ``pm2.config.js`` with node, with or without ``BUGS_BOT_PYTHON`` and the launcher dir; return its one app."""
    env = {k: v for k, v in os.environ.items() if k not in ("BUGS_BOT_PYTHON", "BUGS_BOT_LAUNCHER_DIR")}
    if python is not None:
        env["BUGS_BOT_PYTHON"] = python
    if launcher_dir is not None:
        env["BUGS_BOT_LAUNCHER_DIR"] = launcher_dir
    out = subprocess.run(
        ["node", "-e", "console.log(JSON.stringify(require(process.argv[1])))", str(REPO_ROOT / "pm2.config.js")],
        env=env, capture_output=True, text=True, check=True,
    )
    (app,) = json.loads(out.stdout)["apps"]
    return app


needs_node = pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")


@needs_node
@pytest.mark.parametrize("python", [None, "/opt/py/bin/python3"])
def test_pm2_app_runs_the_pull_loop_with_the_restart_policy(python):
    app = _pm2_app(python)

    assert app["name"] == "bugs-bot-pull"
    assert app["args"] == "pull --watch"
    assert app["autorestart"] is True
    assert app["restart_delay"] == 60000
    assert app["kill_timeout"] == 5000
    assert "cron_restart" not in app


@needs_node
def test_pm2_runs_the_launcher_directly_so_no_plugin_update_moves_its_path():
    app = _pm2_app(None)

    assert app["script"] == os.path.join(os.path.expanduser("~"), ".local", "bin", "bugs-bot")
    assert "plugins/cache" not in app["script"]
    assert app["interpreter"] == "none"


@needs_node
def test_pm2_launcher_dir_comes_from_the_environment():
    assert _pm2_app(None, "/opt/launch")["script"] == "/opt/launch/bugs-bot"


@needs_node
def test_pm2_hands_the_chosen_interpreter_to_the_launcher_through_env():
    assert _pm2_app("/opt/py/bin/python3")["env"]["BUGS_BOT_PYTHON"] == "/opt/py/bin/python3"
    assert "BUGS_BOT_PYTHON" not in (_pm2_app(None).get("env") or {})


def test_api_root_defaults_to_telegram():
    assert api_root({}) == "https://api.telegram.org"


@pytest.mark.parametrize(
    "root",
    ["https://bot.example.org", "http://127.0.0.1:9", "http://127.0.0.1", "http://localhost:8081", "http://localhost"],
)
def test_api_root_accepts_https_and_loopback_http(root):
    assert api_root({"BUGS_BOT_API_ROOT": root}) == root


def test_an_empty_api_root_falls_back_to_telegram():
    assert api_root({"BUGS_BOT_API_ROOT": ""}) == "https://api.telegram.org"


@pytest.mark.parametrize(
    "root",
    [
        "http://evil.example",
        "http://127.0.0.1.evil.example",
        "http://localhost.evil.example:80",
        "http://user@127.0.0.1:9",
        "ftp://127.0.0.1",
        "file:///tmp/x",
        "evil.example",
    ],
)
def test_api_root_refuses_any_other_url_and_names_the_variable(root):
    with pytest.raises(BugsError, match="BUGS_BOT_API_ROOT"):
        api_root({"BUGS_BOT_API_ROOT": root})


def test_the_refusal_does_not_hold_a_token():
    with pytest.raises(BugsError) as caught:
        api_root({"BUGS_BOT_API_ROOT": "http://evil.example/bot123456:SECRETSECRETSECRET"})
    assert "SECRETSECRETSECRET" not in str(caught.value)


def test_api_and_file_urls_are_built_from_the_same_root():
    tg = FakeTelegram()
    channel = TelegramChannel("123456789:AAFakeTokenFakeTokenFake", tg, "http://127.0.0.1:9")

    channel.get_updates(None, 0)
    channel.get_file("abc")

    assert [url for url, _ in tg.calls] == [
        "http://127.0.0.1:9/bot123456789:AAFakeTokenFakeTokenFake/getUpdates",
        "http://127.0.0.1:9/bot123456789:AAFakeTokenFakeTokenFake/getFile",
        "http://127.0.0.1:9/file/bot123456789:AAFakeTokenFakeTokenFake/photos/abc.jpg",
    ]
