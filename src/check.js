// IDFM line check. The cron clock is UTC, so the commute window stays in Europe/Paris.
export const LINES = {
  "1": "line:IDFM:C01371",
  "7": "line:IDFM:C01377",
};

const EQUIPMENT = /ascenseur|escalator|escalier m[ée]canique|trottoir roulant/i;
const SERVICE = /trafic|perturb|interromp|ralenti|incident|travaux|stationnent/i;
const PRIM_CLOCK = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function parisParts(date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Paris",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

export function inCommuteWindow(date) {
  const parts = parisParts(date);
  if (!["Mon", "Tue", "Wed", "Thu", "Fri"].includes(parts.weekday)) return false;
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  const inside = (start, end) => minutes >= start && minutes < end;
  return inside(7 * 60 + 30, 10 * 60) || inside(17 * 60, 20 * 60);
}

export function checkedClock(date) {
  const parts = parisParts(date);
  return `${parts.hour}:${parts.minute}`;
}

export function statusClock(primValue, now) {
  const match = PRIM_CLOCK.exec(primValue || "");
  if (!match) return checkedClock(now);
  const clock = `${match[4]}:${match[5]}`;
  const today = `${parisParts(now).year}-${parisParts(now).month}-${parisParts(now).day}`;
  const day = `${match[1]}-${match[2]}-${match[3]}`;
  if (day === today) return clock;
  return `${Number(match[3])} ${MONTHS[Number(match[2]) - 1]} ${clock}`;
}

function parsePrim(value) {
  const match = PRIM_CLOCK.exec(value || "");
  if (!match) return null;
  // PRIM writes Paris local time with no timezone. Compare the numbers, not a UTC instant.
  return match.slice(1).map(Number);
}

export function disruptionIsLive(item, now) {
  const status = String(item.status || "").toLowerCase();
  if (status === "past" || status === "future") return false;
  const periods = item.application_periods || [];
  if (periods.length === 0) return status === "active";
  const parts = parisParts(now);
  const current = [
    Number(parts.year),
    Number(parts.month),
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    0,
  ];
  const compare = (left, right) => {
    for (let i = 0; i < 6; i += 1) {
      const a = left[i] ?? 0;
      const b = right[i] ?? 0;
      if (a !== b) return a - b;
    }
    return 0;
  };
  return periods.some((period) => {
    const begin = parsePrim(period.begin);
    const end = parsePrim(period.end);
    return (begin === null || compare(begin, current) <= 0) && (end === null || compare(current, end) <= 0);
  });
}

export function plainText(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function equipmentOnly(text) {
  return EQUIPMENT.test(text) && !SERVICE.test(text);
}

function contains(haystack, needle) {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

function clipAtWord(text, limit) {
  if (text.length <= limit) return text;
  const budget = limit - 1;
  let cut = text.slice(0, budget);
  if (text[budget] !== " ") {
    const space = cut.lastIndexOf(" ");
    if (space > 0) cut = cut.slice(0, space);
  }
  return `${cut.trimEnd()}…`;
}

export function disruptionMessage(messages, limit = 300) {
  let texts = [];
  for (const message of messages || []) {
    const text = plainText(message.text);
    if (!text) continue;
    if (texts.some((kept) => contains(kept, text))) continue;
    texts = texts.filter((kept) => !contains(text, kept));
    texts.push(text);
  }
  return clipAtWord(texts.join(" — "), limit);
}

export function alertText(line, status, message, statusAt, checkedAt) {
  if (status === "issue") {
    return `Metro ${line} · status ${statusAt} · checked ${checkedAt} · ${message}`;
  }
  return `✅ line ${line} back to normal · status ${statusAt} · checked ${checkedAt}`;
}

export async function primStatus(lineId, now, apiKey, fetchImpl = fetch) {
  if (!apiKey) return null;
  const url =
    "https://prim.iledefrance-mobilites.fr/marketplace/v2/navitia/line_reports/lines/" +
    `${encodeURIComponent(lineId)}/line_reports`;
  let disruptions;
  try {
    const response = await fetchImpl(url, {
      headers: { apikey: apiKey },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return null;
    disruptions = (await response.json()).disruptions || [];
  } catch {
    return null;
  }

  for (const item of disruptions) {
    if (!disruptionIsLive(item, now)) continue;
    const tags = (item.tags || []).join(" ");
    const text = disruptionMessage(item.messages);
    if (equipmentOnly(`${tags} ${text}`)) continue;
    return {
      status: "issue",
      message: text || "Disruption reported",
      statusAt: statusClock(item.updated_at, now),
    };
  }
  return { status: "ok", message: "Normal service", statusAt: checkedClock(now) };
}

async function postOk(url, init) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(15000) });
  return response.ok;
}

export async function notify(text, env) {
  let sent = false;
  const topic = (env.NTFY_TOPIC || "").trim();
  const token = (env.TELEGRAM_TOKEN || "").trim();
  const chatId = (env.TELEGRAM_CHAT_ID || "").trim();
  if (topic) {
    try {
      if (await postOk(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
        method: "POST",
        body: text,
        headers: { Title: "Metro" },
      })) sent = true;
    } catch {
      console.log("ntfy: request failed");
    }
  } else {
    console.log("ntfy: NTFY_TOPIC is not set");
  }
  if (token && chatId) {
    try {
      if (await postOk(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text }),
      })) sent = true;
    } catch {
      console.log("telegram: request failed");
    }
  } else {
    console.log("telegram: TELEGRAM_TOKEN or TELEGRAM_CHAT_ID is not set");
  }
  return sent;
}

async function saveLine(db, line, status, message, statusAt) {
  await db
    .prepare(
      `INSERT INTO line_state (line, status, message, status_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(line) DO UPDATE SET
         status = excluded.status,
         message = excluded.message,
         status_at = excluded.status_at`,
    )
    .bind(line, status, message, statusAt)
    .run();
}

export async function runCheck(env, options = {}) {
  const now = options.now || new Date();
  const logs = [];
  if (!options.force && !inCommuteWindow(now)) {
    logs.push("outside commute window");
    console.log(logs[0]);
    return logs;
  }

  const checkedAt = checkedClock(now);
  for (const [line, lineId] of Object.entries(LINES)) {
    const current = await primStatus(lineId, now, (env.PRIM_API_KEY || "").trim());
    if (!current) {
      logs.push(`line ${line}: PRIM failed, state left unchanged`);
      console.log(logs.at(-1));
      continue;
    }

    const row = await env.DB.prepare(
      "SELECT status, message, status_at FROM line_state WHERE line = ?",
    )
      .bind(line)
      .first();
    const previous = row?.status;
    const quiet = previous === current.status || (current.status === "ok" && previous !== "issue");
    const sameRow =
      row &&
      row.status === current.status &&
      row.message === current.message &&
      row.status_at === current.statusAt;

    if (quiet) {
      if (!sameRow) await saveLine(env.DB, line, current.status, current.message, current.statusAt);
      logs.push(`line ${line}: ${current.status}, no alert`);
      console.log(logs.at(-1));
      continue;
    }

    const text = alertText(line, current.status, current.message, current.statusAt, checkedAt);
    if (await notify(text, env)) {
      await saveLine(env.DB, line, current.status, current.message, current.statusAt);
      logs.push(text);
      console.log(text);
    } else {
      logs.push(`line ${line}: notification failed, will retry next run`);
      console.log(logs.at(-1));
    }
  }
  return logs;
}
