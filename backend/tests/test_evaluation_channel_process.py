import json
import shutil
import subprocess
import sys
from pathlib import Path


def test_node_python_inherited_channel_generation_and_cancellation():
    root = Path(__file__).resolve().parents[2]
    node = shutil.which("node")
    assert node is not None
    result = subprocess.run(
        [
            node,
            str(root / "backend/tests/evaluation-channel-consumer.mjs"),
            sys.executable,
        ],
        cwd=root,
        capture_output=True,
        text=True,
        timeout=15,
    )
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == {"ok": True}
