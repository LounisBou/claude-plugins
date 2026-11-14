"""The hooks module, in the host: the host validates it and runs its own tests (``hooks/tests``).

The host refuses a whole hooks module for one defect and then registers none of its tools, and the
module's tests run only in the host's kit. Without ``claude`` on PATH these fail: they do not skip.
"""

from __future__ import annotations

import shutil
import subprocess

from conftest import REPO_ROOT


def host(*args: str) -> subprocess.CompletedProcess[str]:
    """Run ``claude <args>`` on the plugin; ``claude`` itself must be installed."""
    claude = shutil.which("claude")
    assert claude, "claude is not on PATH, to run the module's checks"
    return subprocess.run([claude, *args, str(REPO_ROOT)], capture_output=True, text=True, stdin=subprocess.DEVNULL, timeout=300, check=False)


def test_the_host_validates_the_plugin():
    done = host("plugin", "validate")

    assert done.returncode == 0, done.stdout + done.stderr


def test_the_modules_tests_pass_in_the_hosts_kit():
    done = host("plugin", "test")

    assert done.returncode == 0, done.stdout + done.stderr
