import * as tauri from "@tauri-apps/plugin-notification";
import { isTauri } from "./fs";
import { behindPace, getDays, getGoals, msSinceLastEdit, periodTotal, type Period } from "./stats";

const FIRED_KEY = "joyce:reminder-fired";
const CHECK_EVERY_MS = 30_000;
/** Someone who typed this recently is already writing; don't nag them. */
const RECENTLY_ACTIVE_MS = 15 * 60_000;
/** A reminder missed by more than this (Mac asleep, Joyce closed) is skipped rather than shown late. */
const LATE_WINDOW_MIN = 120;

export async function ensureNotificationPermission(): Promise<boolean> {
  if (isTauri) {
    if (await tauri.isPermissionGranted()) return true;
    return (await tauri.requestPermission()) === "granted";
  }
  if (!("Notification" in window)) return false;
  if (Notification.permission === "granted") return true;
  return (await Notification.requestPermission()) === "granted";
}

function notify(title: string, body: string) {
  if (isTauri) tauri.sendNotification({ title, body });
  else if ("Notification" in window && Notification.permission === "granted") new Notification(title, { body });
}

const PERIOD_NAME: Record<Period, string> = { day: "today", week: "this week", month: "this month" };
const fmt = (n: number) => n.toLocaleString();

export function reminderMessage(): { body: string; behind: boolean } {
  const days = getDays();
  const goals = getGoals();
  const behind = behindPace(days, goals);
  if (behind.length === 0) {
    const today = periodTotal(days, goals, "day").words;
    // With no goals set, not having written yet today is what counts as behind.
    const noGoals = !goals.daily && !goals.weekly && !goals.monthly;
    return {
      body: today ? `${fmt(today)} words so far today. Keep going.` : "A few minutes of writing goes a long way.",
      behind: noGoals && today === 0,
    };
  }
  // Lead with the most pressing goal: the shortest period is the most immediate.
  const { period, short } = behind[0];
  const done = periodTotal(days, goals, period).words;
  const body =
    period === "day"
      ? `${fmt(done)} of ${fmt(goals.daily!)} words today.`
      : `${fmt(short)} words behind pace for ${PERIOD_NAME[period]}.`;
  return { body, behind: true };
}

function check() {
  const { reminder } = getGoals();
  if (!reminder.enabled) return;
  const now = new Date();
  const today = now.toDateString();
  if (!reminder.days.includes(now.getDay()) || localStorage.getItem(FIRED_KEY) === today) return;

  const [h, m] = reminder.time.split(":").map(Number);
  const late = now.getHours() * 60 + now.getMinutes() - (h * 60 + m);
  if (late < 0 || late > LATE_WINDOW_MIN) return;

  // From here on, today's reminder is spent whether or not it's shown.
  localStorage.setItem(FIRED_KEY, today);
  if (msSinceLastEdit() < RECENTLY_ACTIVE_MS) return;
  const { body, behind } = reminderMessage();
  if (reminder.onlyIfBehind && !behind) return;
  notify("Time to write", body);
}

/** Reminders fire while Joyce is running, including in the background. */
export function startReminders() {
  check();
  const id = window.setInterval(check, CHECK_EVERY_MS);
  return () => clearInterval(id);
}
