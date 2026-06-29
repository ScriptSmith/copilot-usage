#!/usr/bin/env python3
"""Drive an INTERACTIVE copilot session in a PTY and poll data.db to see whether
sessions.total_nano_aiu / is_running update LIVE (mid-session) or only at the end.

We don't parse the TUI at all -- we just send a prompt, then poll the DB row for
our known session id every 0.5s and record how the live usage evolves."""
import os, pty, sqlite3, subprocess, sys, time, uuid

SID = str(uuid.uuid4())
DB = os.path.expanduser("~/.copilot/data.db")
CWD = "/tmp/python-test"  # already in trustedFolders -> no trust prompt
os.makedirs(CWD, exist_ok=True)
PROMPT = ("Run these one at a time as separate shell commands, waiting for each: "
          "`echo step1`, then `sleep 4`, then `echo step2`, then `sleep 4`, then "
          "`echo step3`. After all five, reply DONE.\r")

print(f"session id: {SID}")

def snap():
    try:
        con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=1)
        r = con.execute(
            "SELECT is_running, total_nano_aiu, total_output_tokens, updated_at "
            "FROM sessions WHERE id=?", (SID,)).fetchone()
        con.close()
        return r
    except Exception as e:
        return ("err", str(e), "", "")

pid, fd = pty.fork()
if pid == 0:  # child: run interactive copilot in the PTY
    os.chdir(CWD)
    os.execvp("copilot", [
        "copilot", "--session-id", SID,
        "--allow-all-tools", "--no-color", "--model", "claude-sonnet-4.6",
    ])
    os._exit(127)

# parent: give it a moment to boot, send the prompt, then poll the DB
time.sleep(6)
os.write(fd, PROMPT.encode())

start = time.time()
last = None
timeline = []
while time.time() - start < 70:
    # drain child output so its pty buffer never blocks (we ignore the content)
    try:
        import select
        r, _, _ = select.select([fd], [], [], 0)
        if r:
            os.read(fd, 65536)
    except OSError:
        break
    row = snap()
    if row != last:
        t = round(time.time() - start, 1)
        timeline.append((t, row))
        print(f"  +{t:>4}s  is_running={row[0]}  nano_aiu={row[1]}  out_tok={row[2]}  updated_at={row[3]}")
        last = row
    time.sleep(0.5)

# stop the session
try:
    os.write(fd, b"\x03")      # Ctrl-C
    time.sleep(0.5)
    os.write(fd, b"/exit\r")
    time.sleep(1.5)
except OSError:
    pass
try:
    os.kill(pid, 9)
except ProcessLookupError:
    pass

print("\nFINAL row after exit:", snap())
print("transitions seen:", len(timeline))
