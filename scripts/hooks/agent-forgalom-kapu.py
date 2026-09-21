#!/usr/bin/env python3
"""Traffic gate for inter-agent chatter.

Counts agent-to-agent messages in the last 60 minutes. Agent work is supposed to
be driven by kanban cards; a self-sustaining round between agents produces a high
message rate with zero card movement. That combination is the failure signature
(measured 2026-09-20: 541 messages in one day, 0 card movement).

Exit 0 = quiet, exit 1 = over threshold (the PM must stop the round and report).
"""
import sqlite3, time, sys, collections, os

DB = os.path.join(os.path.dirname(__file__), '..', '..', 'store', 'claudeclaw.db')
KUSZOB = 30          # messages / 60 min between agents
ABLAK = 3600

def main():
    now = time.time()
    db = sqlite3.connect(os.path.abspath(DB))
    rows = db.execute(
        "select from_agent, to_agent from agent_messages "
        "where created_at >= ? and from_agent != 'system'", (now - ABLAK,)).fetchall()
    # only agent-to-agent traffic counts; a card-driven single message does not
    n = len(rows)
    kartya = db.execute(
        "select count(*) from kanban_cards where status='in_progress' "
        "and (archived_at is null or archived_at='')").fetchone()[0]
    if n <= KUSZOB:
        print(f"forgalom-kapu OK: {n} uzenet/60 perc (kuszob {KUSZOB}), in_progress kartya: {kartya}")
        return 0
    par = collections.Counter(rows).most_common(5)
    print(f"FORGALOM-KAPU BUKAS: {n} uzenet/60 perc (kuszob {KUSZOB}), in_progress kartya: {kartya}")
    for (a, b), v in par:
        print(f"  {a} -> {b}: {v}")
    print("Teendo: a kort le kell allitani, es Balintnak egy sorban jelenteni. "
          "Uj korre csak Balint kartyaja ad okot.")
    return 1

if __name__ == '__main__':
    sys.exit(main())
