"""Replay the TradePlusAI India day-trade pipeline on every session of a saved Yahoo 5m chart.
python3 -I replay.py CHART.json[.gz] SYMBOL OUTDIR [--days N]
For each day: entry (ORB, as of 14:45) -> exit plan -> time machine (as of the entry) -> size -> risk
(as of the entry), then the actual outcome from the bars after the entry: stop or target first (both in
one bar counts as the stop), else out at the 15:05 bar's close (flat by 15:10). P&L net of charges."""
import datetime, gzip, json, os, shutil, subprocess, sys
REPO = __import__("os").path.dirname(__import__("os").path.dirname(__import__("os").path.dirname(__import__("os").path.abspath(__file__))))
S = REPO + "/.claude/skills"
sys.path.insert(0, REPO + "/tests/day-trader-skill")
from _load import load
IN = load("trader-market", "market").get("IN")
chart, sym, out = os.path.abspath(sys.argv[1]), sys.argv[2], os.path.abspath(sys.argv[3])
ndays = int(sys.argv[sys.argv.index("--days") + 1]) if "--days" in sys.argv else 0
doc = json.load(gzip.open(chart, "rt") if chart.endswith(".gz") else open(chart))
r = doc["chart"]["result"][0]; q = r["indicators"]["quote"][0]
E = datetime.datetime(1970, 1, 1)
bars = {}
for i, ts in enumerate(r["timestamp"]):
    if None in (q["open"][i], q["high"][i], q["low"][i], q["close"][i]): continue
    t = IN.to_local(E + datetime.timedelta(seconds=ts))
    bars.setdefault(t.date(), []).append((t, q["open"][i], q["high"][i], q["low"][i], q["close"][i]))
days = sorted(d for d in bars if IN.session(d) and len(bars[d]) >= 70)
if ndays: days = days[-ndays:]

def run(args, cwd):
    p = subprocess.run([sys.executable] + args + ["--market", "IN"], cwd=cwd, capture_output=True, text=True)
    return p.returncode, p.stdout + p.stderr

def hhmm(s):  # "9:50 AM" -> "09:50"
    return datetime.datetime.strptime(s, "%I:%M %p").strftime("%H:%M")

os.makedirs(out, exist_ok=True); rows = []
for d in days:
    w = os.path.join(out, d.isoformat()); shutil.rmtree(w, ignore_errors=True); os.makedirs(os.path.join(w, "trader"))
    shutil.copy(S + "/trader-budget/config.example.json", w + "/trader/config.json")
    log = []
    def step(name, args):
        rc, o = run(args, w); log.append("$ " + " ".join(a.replace(S + "/", ".claude/skills/") for a in [args[0].split("/")[-1]] + args[1:]) + "\n" + o)
        return rc, o
    D = d.isoformat()
    step("entry", [S + "/trader-entry/entry.py", "check", sym, "--setup", "orb", "--offline", chart, "--now", D + " 14:45", "--write"])
    ent = json.load(open(w + "/trader/entry.json")) if os.path.exists(w + "/trader/entry.json") else {}
    row = {"date": D, "status": ent.get("status", "error")}
    if ent.get("status") == "triggered":
        rc, o = step("exit", [S + "/trader-exit/exit.py", "plan", "--target", "2R", "--now", D + " 14:45", "--write"])
        if rc == 0:
            plan = json.load(open(w + "/trader/plan.json")); t_entry = hhmm(plan["entry_time"])
            row.update(entry=plan["entry"], stop=plan["stop"], target=plan["target"], time=t_entry)
            step("tm", [S + "/trader-timemachine/timemachine.py", "run", "--seed", "19", "--offline", chart, "--now", D + " " + t_entry, "--write"])
            tm = json.load(open(w + "/trader/timemachine.json")) if os.path.exists(w + "/trader/timemachine.json") else {}
            row["tm_target"] = (tm.get("mc") or {}).get("p_target"); row["tm_stop"] = (tm.get("mc") or {}).get("p_stop")
            rc, o = step("size", [S + "/trader-budget/size.py", "--now", D + " " + t_entry, "--write"])
            if not os.path.exists(w + "/trader/orders.json") or "No order" in o:
                row["verdict"] = "NO ORDER (budget)"; row["why"] = [l for l in o.splitlines() if l.startswith("No order")][:1]
            else:
                rc, o = step("risk", [S + "/trader-risk/check.py", "--now", D + " " + t_entry])
                row["verdict"] = "PASS" if "\nPASS" in "\n" + o else "BLOCK"
                orders = json.load(open(w + "/trader/orders.json"))["orders"]; qty = int(orders[0]["qty"]); row["qty"] = qty
                if row["verdict"] == "PASS":
                    after = [b for b in bars[d] if b[0].strftime("%H:%M") >= t_entry and b[0].time() < datetime.time(15, 10)]
                    exit_px, how = None, None
                    for t, o_, h, l, c in after:
                        if l <= plan["stop"]: exit_px, how = plan["stop"], "stop " + t.strftime("%H:%M"); break
                        if h >= plan["target"]: exit_px, how = plan["target"], "target " + t.strftime("%H:%M"); break
                    if exit_px is None and after: exit_px, how = round(after[-1][4], 2), "flat 15:10"
                    ch = IN.charges(qty, plan["entry"], exit_px)["total"]
                    row.update(exit=exit_px, outcome=how, gross=round(qty * (exit_px - plan["entry"]), 2), charges=ch,
                               net=round(qty * (exit_px - plan["entry"]) - ch, 2))
    open(w + "/log.txt", "w").write("\n".join(log)); rows.append(row)
json.dump(rows, open(os.path.join(out, "summary.json"), "w"), indent=1)
traded = [x for x in rows if "net" in x]
print("%-10s %-9s %-6s %9s %9s %9s %4s %-13s %9s %8s %9s  %s" % ("date", "signal", "time", "entry", "stop", "target", "qty", "outcome", "gross", "charges", "net", "TM tgt/stop"))
for x in rows:
    if "net" in x:
        print("%-10s %-9s %-6s %9.2f %9.2f %9.2f %4d %-13s %9.2f %8.2f %9.2f  %s/%s" % (x["date"], "trade", x["time"], x["entry"], x["stop"], x["target"], x["qty"], x["outcome"], x["gross"], x["charges"], x["net"], x.get("tm_target"), x.get("tm_stop")))
    elif x["status"] == "triggered":
        print("%-10s %-9s %-6s %9s %9s %9s %4s %s" % (x["date"], "skipped", x.get("time", ""), x.get("entry", ""), x.get("stop", ""), x.get("target", ""), x.get("qty", ""), x.get("verdict", "plan refused")))
    else:
        print("%-10s %-9s" % (x["date"], "no-signal" if x["status"] in ("expired", "waiting") else x["status"]))
net = sum(x["net"] for x in traded); wins = sum(1 for x in traded if x["net"] > 0)
print("\n%d sessions, %d signals, %d trades taken, %d winners, net P&L after charges %s (gross %s, charges %s)" % (
    len(rows), sum(1 for x in rows if x["status"] == "triggered"), len(traded), wins, IN.money(net),
    IN.money(sum(x["gross"] for x in traded)), IN.money(sum(x["charges"] for x in traded))))
