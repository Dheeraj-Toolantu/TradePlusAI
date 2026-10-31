"""Integrity checks for the day-trader skill pack vendored into .claude/skills/.

Adapted from the upstream test_repo.py: the upstream checks on the plugin manifest and README are
dropped (the pack is installed here as project-local skills, not as a plugin), the rest are kept.
"""

import json
import os
import re
import unittest

from _load import ROOT, REPO, load

MARKET = load("trader-market", "market")

SKILLS = ["trader-scanner", "trader-news", "trader-entry", "trader-exit", "trader-timemachine",
          "trader-risk", "trader-budget", "trader-broker", "trader-alerts", "trader-analyst",
          "trader-pelosi",
          # added for TradePulse (Indian markets): the shared market profile and the bulk/block deals tracker
          "trader-market", "trader-deals"]
# skills on the way to an order carry the safety block
ORDER_PATH = ["trader-scanner", "trader-entry", "trader-exit", "trader-timemachine", "trader-budget",
              "trader-pelosi", "trader-risk", "trader-broker", "trader-alerts", "trader-deals"]


def frontmatter(path):
    with open(path, encoding="utf-8") as fh:
        text = fh.read()
    m = re.match(r"^---\n(.*?)\n---\n", text, re.S)
    return (m.group(1) if m else ""), text


class VendoredSkills(unittest.TestCase):
    def test_all_trader_skills_are_installed(self):
        found = sorted(d for d in os.listdir(ROOT)
                       if d.startswith("trader-") and os.path.isfile(os.path.join(ROOT, d, "SKILL.md")))
        self.assertEqual(found, sorted(SKILLS))

    def test_mit_license_ships_with_the_skills(self):
        with open(os.path.join(ROOT, "LICENSE.day-trader-skill"), encoding="utf-8") as fh:
            text = fh.read()
        self.assertIn("MIT License", text)
        self.assertIn("Jake Schincariol", text)

    def test_frontmatter_name_and_description(self):
        for s in SKILLS:
            fm, text = frontmatter(os.path.join(ROOT, s, "SKILL.md"))
            self.assertIn("name: %s\n" % s, fm + "\n", s)
            self.assertRegex(fm, r"description: ", s)
            self.assertGreater(len(fm), 200, "%s description is too thin" % s)
            self.assertGreater(len(text.splitlines()), 60, s)

    def test_order_path_skills_carry_the_safety_rule(self):
        for s in ORDER_PATH:
            _, text = frontmatter(os.path.join(ROOT, s, "SKILL.md"))
            low = " ".join(text.lower().split())
            self.assertIn("not financial advice", low, s)
            self.assertIn("yes", low, s)

    def test_every_tool_runs_on_python_3_8(self):
        for s in SKILLS:
            folder = os.path.join(ROOT, s)
            for f in os.listdir(folder):
                if not f.endswith(".py"):
                    continue
                with open(os.path.join(folder, f), encoding="utf-8") as fh:
                    src = fh.read()
                for bad in ("import zoneinfo", "from zoneinfo", ".removeprefix(", ".removesuffix("):
                    self.assertNotIn(bad, src, "%s/%s" % (s, f))
                self.assertNotRegex(src, r"(?m)^\s+match \w+.*:$", "%s/%s" % (s, f))
                for bad in ("list[", "dict[", "tuple["):
                    self.assertNotRegex(src, r"(?<![\w.])%s" % re.escape(bad), "%s/%s" % (s, f))

    def _configs(self):
        for name in ("config.example.json", "config.us.example.json"):
            with open(os.path.join(ROOT, "trader-budget", name)) as fh:
                yield name, json.load(fh)

    def test_india_is_the_default_example_config(self):
        with open(os.path.join(ROOT, "trader-budget", "config.example.json")) as fh:
            cfg = json.load(fh)
        self.assertEqual(MARKET.resolve(None, cfg).code, "IN")
        self.assertIn("max_loss_per_trade_inr", cfg)
        with open(os.path.join(ROOT, "trader-budget", "config.us.example.json")) as fh:
            self.assertEqual(MARKET.resolve(None, json.load(fh)).code, "US")

    def test_day_trading_limits_ship_in_the_example_configs(self):
        for name, raw in self._configs():
            cfg = MARKET.normalize_config(raw)
            for k in ("max_loss_per_trade_usd", "max_daily_loss_usd", "max_trades_per_day",
                      "min_reward_risk", "require_stop", "no_entries_after", "flat_by"):
                self.assertIn(k, cfg, "%s: %s" % (name, k))
            self.assertIs(cfg["require_stop"], True, name)
            self.assertIs(cfg.get("allow_short", False), False, name)
            self.assertIs(cfg.get("allow_margin", False), False, name)

    def test_paper_trading_is_the_default(self):
        for name, cfg in self._configs():
            self.assertIs(cfg["paper"], True, name)
            self.assertIs(cfg.get("allow_options", False), False, name)

    def test_no_em_dashes_outside_fixtures(self):
        for base, dirs, files in os.walk(ROOT):
            dirs[:] = [d for d in dirs if d != "__pycache__"]
            for f in files:
                if f.endswith((".md", ".py", ".json", ".txt")):
                    with open(os.path.join(base, f), encoding="utf-8", errors="replace") as fh:
                        self.assertNotIn("\u2014", fh.read(), os.path.join(base, f))

    def test_trader_workspace_is_git_ignored(self):
        # trader/ holds the user's budget, positions, state and SEC contact: never commit it
        with open(os.path.join(REPO, ".gitignore"), encoding="utf-8") as fh:
            lines = [ln.strip() for ln in fh]
        self.assertIn("/trader/", lines)


if __name__ == "__main__":
    unittest.main()
