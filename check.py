#!/usr/bin/env python3
"""Alert when Paris metro line 1 or 7 changes status. Quiet outside commute hours."""

import json
import os
import re
from datetime import datetime, time
from pathlib import Path
from zoneinfo import ZoneInfo

import requests

PARIS = ZoneInfo("Europe/Paris")
STATE_FILE = Path(__file__).resolve().parent / "state.json"
LINES = {
    "1": "line:IDFM:C01371",
    "7": "line:IDFM:C01377",
}
# Mon–Fri, Paris time. GitHub cron is UTC, so the window stays in Python.
WINDOWS = ((time(7, 30), time(10, 0)), (time(17, 0), time(20, 0)))
EQUIPMENT = re.compile(r"ascenseur|escalator|escalier m[ée]canique|trottoir roulant", re.I)
SERVICE = re.compile(r"trafic|perturb|interromp|ralenti|incident|travaux|stationnent", re.I)
TIMEOUT = 15


def in_commute_window(now):
    # weekday(): Monday is 0, Sunday is 6.
    clock = now.time()
    return now.weekday() <= 4 and any(start <= clock < end for start, end in WINDOWS)


def parse_prim_time(value):
    # PRIM writes Paris local time as 20261019T073000, with no timezone.
    try:
        return datetime.strptime(value or "", "%Y%m%dT%H%M%S").replace(tzinfo=PARIS)
    except ValueError:
        return None


def disruption_is_live(item, now):
    if (item.get("status") or "").lower() in {"past", "future"}:
        return False
    periods = item.get("application_periods") or []
    if not periods:
        return (item.get("status") or "").lower() == "active"
    for period in periods:
        begin, end = parse_prim_time(period.get("begin")), parse_prim_time(period.get("end"))
        if (begin is None or begin <= now) and (end is None or now <= end):
            return True
    return False


def plain_text(value):
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", value or "")).strip()


def equipment_only(text):
    return bool(EQUIPMENT.search(text)) and not SERVICE.search(text)


def status_clock(value, now):
    # PRIM's stamp is already Paris local time.
    parsed = parse_prim_time(value)
    if parsed is None:
        return now.strftime("%H:%M")
    clock = parsed.strftime("%H:%M")
    if parsed.date() != now.date():
        return f"{parsed.day} {parsed.strftime('%b')} {clock}"
    return clock


def prim_status(line_id, now):
    """('issue'|'ok', message), or None when PRIM cannot be reached."""
    key = os.environ.get("PRIM_API_KEY", "").strip()
    if not key:
        print("prim: PRIM_API_KEY is not set")
        return None
    quoted = requests.utils.quote(line_id, safe="")
    url = (
        "https://prim.iledefrance-mobilites.fr/marketplace/v2/navitia/"
        f"line_reports/lines/{quoted}/line_reports"
    )
    try:
        response = requests.get(url, headers={"apikey": key}, timeout=TIMEOUT)
        response.raise_for_status()
        disruptions = response.json().get("disruptions") or []
    except Exception as exc:
        print(f"prim {line_id}: {exc}")
        return None

    for item in disruptions:
        if not disruption_is_live(item, now):
            continue
        tags = " ".join(item.get("tags") or [])
        text = " — ".join(
            part for part in (plain_text(m.get("text")) for m in item.get("messages") or []) if part
        )[:300]
        if equipment_only(f"{tags} {text}"):
            continue
        return "issue", text or "Disruption reported", status_clock(item.get("updated_at"), now)
    return "ok", "Normal service", now.strftime("%H:%M")


def load_state():
    if not STATE_FILE.exists():
        return {}
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except Exception as exc:
        print(f"state: {exc}")
        return {}


def notify(text):
    """True when ntfy or Telegram accepted the message."""
    sent = False
    topic = os.environ.get("NTFY_TOPIC", "").strip()
    token = os.environ.get("TELEGRAM_TOKEN", "").strip()
    chat_id = os.environ.get("TELEGRAM_CHAT_ID", "").strip()
    try:
        if topic:
            requests.post(f"https://ntfy.sh/{topic}", data=text.encode(), headers={"Title": "Metro"}, timeout=TIMEOUT).raise_for_status()
            sent = True
        else:
            print("ntfy: NTFY_TOPIC is not set")
    except Exception as exc:
        print(f"ntfy: {exc}")
    try:
        if token and chat_id:
            requests.post(
                f"https://api.telegram.org/bot{token}/sendMessage",
                json={"chat_id": chat_id, "text": text},
                timeout=TIMEOUT,
            ).raise_for_status()
            sent = True
        else:
            print("telegram: TELEGRAM_TOKEN or TELEGRAM_CHAT_ID is not set")
    except Exception as exc:
        print(f"telegram: {exc}")
    return sent


def main():
    now = datetime.now(PARIS)
    if not in_commute_window(now):
        return

    state = load_state()
    for line, line_id in LINES.items():
        current = prim_status(line_id, now)
        if current is None:
            print(f"line {line}: PRIM failed, state left unchanged")
            continue

        status, message, status_at = current
        previous = (state.get(line) or {}).get("status")
        checked = now.strftime("%H:%M")
        row = {"status": status, "message": message, "status_at": status_at}
        if previous == status or (status == "ok" and previous != "issue"):
            # Same status, or the first time we see a healthy line: store it, stay quiet.
            state[line] = row
            continue

        if status == "issue":
            text = f"Metro {line} · status {status_at} · checked {checked} · {message}"
        else:
            text = f"✅ line {line} back to normal · status {checked} · checked {checked}"
        if notify(text):
            state[line] = row
            print(text)
        else:
            print(f"line {line}: notification failed, will retry next run")

    STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"check failed: {exc}")
