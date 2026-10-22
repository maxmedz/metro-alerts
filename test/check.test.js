import assert from "node:assert/strict";
import test from "node:test";
import {
  alertText,
  disruptionIsLive,
  disruptionMessage,
  equipmentOnly,
  inCommuteWindow,
  statusClock,
} from "../src/check.js";

test("commute window uses Paris time and excludes the end minute", () => {
  assert.equal(inCommuteWindow(new Date("2026-10-21T05:30:00Z")), true);
  assert.equal(inCommuteWindow(new Date("2026-10-21T08:00:00Z")), false);
  assert.equal(inCommuteWindow(new Date("2026-10-21T15:00:00Z")), true);
  assert.equal(inCommuteWindow(new Date("2026-10-21T18:00:00Z")), false);
  assert.equal(inCommuteWindow(new Date("2026-10-18T06:00:00Z")), false);
});

test("winter clock still lands in the Paris window", () => {
  assert.equal(inCommuteWindow(new Date("2026-11-02T06:30:00Z")), true);
  assert.equal(inCommuteWindow(new Date("2026-11-02T19:00:00Z")), false);
});

test("status clock keeps the IDFM Paris time", () => {
  const now = new Date("2026-10-21T20:08:00Z");
  assert.equal(statusClock("20261021T220326", now), "22:03");
  assert.equal(statusClock("20261020T183000", now), "20 Oct 18:30");
  assert.equal(statusClock("", now), "22:08");
});

test("a past disruption and a lift notice do not alert", () => {
  const now = new Date("2026-10-21T20:08:00Z");
  assert.equal(disruptionIsLive({ status: "past", application_periods: [] }, now), false);
  assert.equal(
    disruptionIsLive(
      { status: "active", application_periods: [{ begin: "20261021T210000", end: "20261021T230000" }] },
      now,
    ),
    true,
  );
  assert.equal(equipmentOnly("ascenseur en panne"), true);
  assert.equal(equipmentOnly("ascenseur et trafic perturbé"), false);
});

test("alert message shows each text once and clips on a word", () => {
  assert.equal(
    disruptionMessage([
      { text: "Station fermée (sans correspondances)" },
      { text: "<p>Châtelet : Mesures de sécurité - Station fermée (sans correspondances)</p>" },
      { text: "Châtelet : Mesures de sécurité - Station fermée (sans correspondances)" },
      { text: "Les trains ne marquent pas l'arrêt à Châtelet" },
    ]),
    "Châtelet : Mesures de sécurité - Station fermée (sans correspondances) — Les trains ne marquent pas l'arrêt à Châtelet",
  );
  assert.equal(disruptionMessage([{ text: "aaaa bbbb cccc" }], 8), "aaaa…");
  assert.equal(disruptionMessage([{ text: "aaaa bbbb cccc" }], 10), "aaaa bbbb…");
});

test("alert text always carries both times", () => {
  assert.equal(
    alertText("1", "issue", "Châtelet closed", "22:03", "22:08"),
    "Metro 1 · status 22:03 · checked 22:08 · Châtelet closed",
  );
  assert.equal(
    alertText("7", "ok", "Normal service", "08:12", "08:12"),
    "✅ line 7 back to normal · status 08:12 · checked 08:12",
  );
});
