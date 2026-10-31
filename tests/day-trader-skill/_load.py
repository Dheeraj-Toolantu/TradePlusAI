"""Load a script from a vendored day-trader skill folder (the folder names have hyphens).

The skills live in <repo>/.claude/skills/trader-*; the offline fixtures live next to this file.

The tools default to the Indian market (NSE, IST, INR). The upstream suites replay real US data,
so this process defaults TRADER_MARKET to US; India suites load with load(..., market="IN") or
pass --market IN / "market": "IN" explicitly.
"""

import importlib.util
import os

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
ROOT = os.path.join(REPO, ".claude", "skills")
FIX = os.path.join(HERE, "fixtures")

os.environ.setdefault("TRADER_MARKET", "US")


def load(folder, name, market=None):
    """Import ROOT/folder/name.py as a fresh module. market="IN" imports it with TRADER_MARKET=IN
    (and under its own module name, so a US copy and an India copy can live side by side)."""
    path = os.path.join(ROOT, folder, name + ".py")
    modname = "trader_" + name + ("_" + market.lower() if market else "")
    old = os.environ.get("TRADER_MARKET")
    if market:
        os.environ["TRADER_MARKET"] = market
    try:
        spec = importlib.util.spec_from_file_location(modname, path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
    finally:
        if market:
            if old is None:
                os.environ.pop("TRADER_MARKET", None)
            else:
                os.environ["TRADER_MARKET"] = old
    return mod
