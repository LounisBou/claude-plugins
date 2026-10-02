"""The names the tool answers to: the program name and the prefix of every line it prints."""

from __future__ import annotations

from samples import FakeTelegram

from bugs_bot import cli


def test_the_program_is_called_bugs_bot():
    assert cli.build_parser().prog == "bugs-bot"


def test_a_refusal_is_prefixed_with_bugs_bot(run, capsys):
    assert run("show", "20261002-000000-1") == 1
    assert capsys.readouterr().err.startswith("bugs-bot: ")


def test_an_unexpected_error_is_prefixed_with_bugs_bot(run, bound, capsys):
    tg = FakeTelegram()
    tg.raise_on_call = RuntimeError("boom")
    assert run("pull", transport=tg) == 1
    assert capsys.readouterr().err.startswith("bugs-bot: RuntimeError")
