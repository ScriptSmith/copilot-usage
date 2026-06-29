#!/usr/bin/env python3
"""Real-data proof of the live path: run a copilot -p session in the background
and poll the systemd collector while it runs, showing that the session's AIC is
visible live BEFORE its session.shutdown event is written to disk."""
import json, os, subprocess, time, urllib.request, uuid

SID = str(uuid.uuid4())
ENDPOINT = "http://127.0.0.1:4318"
SHUTDOWN_FILE = os.path.expanduser(f"~/.copilot/session-state/{SID}/events.jsonl")

def collector_aic():
    try:
        with urllib.request.urlopen(f"{ENDPOINT}/sessions", timeout=1) as r:
            for s in json.load(r)["sessions"]:
                if s["id"] == SID:
                    return s["aic"], s["running"]
    except Exception:
        pass
    return None, None

def has_shutdown():
    try:
        return '"session.shutdown"' in open(SHUTDOWN_FILE).read()
    except Exception:
        return False

print(f"session {SID}")
env = dict(os.environ, OTEL_EXPORTER_OTLP_ENDPOINT=ENDPOINT)
proc = subprocess.Popen(
    ["copilot", "-p",
     "Do these as separate shell commands, one at a time, waiting for each: "
     "'echo a', 'sleep 12', 'echo b', 'sleep 12', 'echo c', 'sleep 12'. Then reply DONE.",
     "--session-id", SID, "--allow-all", "--no-color"],
    env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

saw_live_before_shutdown = False
start = time.time()
while time.time() - start < 60:
    aic, running = collector_aic()
    sd = has_shutdown()
    if aic is not None:
        tag = "LIVE (no shutdown on disk yet)" if not sd else "shutdown written"
        print(f"  +{time.time()-start:4.1f}s  collector_aic={aic:<10} running={running}  on-disk shutdown={sd}  <- {tag}")
        if aic > 0 and not sd:
            saw_live_before_shutdown = True
    if proc.poll() is not None and sd:
        break
    time.sleep(0.75)

proc.wait()
print()
print("RESULT:", "live AIC was visible BEFORE the shutdown event existed on disk ✓"
      if saw_live_before_shutdown else "did not catch a live-before-shutdown window")
