"""Load a script from a vendored day-trader skill folder (the folder names have hyphens).

The skills live in <repo>/.claude/skills/trader-*; the offline fixtures live next to this file.
"""

import importlib.util
import os

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
ROOT = os.path.join(REPO, ".claude", "skills")
FIX = os.path.join(HERE, "fixtures")


def load(folder, name):
    path = os.path.join(ROOT, folder, name + ".py")
    spec = importlib.util.spec_from_file_location("trader_" + name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod
