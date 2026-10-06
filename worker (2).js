const TZ = "Asia/Bishkek";
const EARLY_MINUTES = 15;
const SESSION_TTL = 14400;
const SENT_TTL = 172800;

const DAY_NAMES = [
  "Dushanba", "Seshanba", "Chorshanba", "Payshanba",
  "Juma", "Shanba", "Yakshanba"
];

async function handleFetch(request, env) {
  const url = new URL(request.url);

  try {
    await rememberOrigin(env, url.origin);

    if (request.method === "GET" && url.pathname === "/") {
      return textResponse("Kegel Coach is running.");
    }

    if (request.method === "GET" && url.pathname === "/set-webhook") {
      return await setWebhook(url, env);
    }

    if (request.method === "POST" && url.pathname === "/webhook") {
      const expectedSecret = await webhookSecret(env);
      const gotSecret = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
      if (!timingSafeEqualHex(gotSecret, expectedSecret)) {
        return textResponse("Forbidden", 403);
      }
      try {
        await handleWebhook(request, env);
      } catch (error) {
        console.error("Webhook error:", error);
      }
      return textResponse("OK");
    }

    if (request.method === "GET" && url.pathname === "/app") {
      return new Response(APP_HTML, {
        status: 200,
        headers: {
          "content-type": "text/html; charset=UTF-8",
          "cache-control": "no-store"
        }
      });
    }

    if (request.method === "POST" && url.pathname === "/api/status") {
      return await apiStatus(request, env);
    }

    if (request.method === "POST" && url.pathname === "/api/start") {
      return await apiStart(request, env);
    }

    if (request.method === "POST" && url.pathname === "/api/complete") {
      return await apiComplete(request, env);
    }

    return textResponse("Not found", 404);
  } catch (error) {
    console.error("Worker error:", error);
    if (request.method === "POST" && url.pathname === "/webhook") {
      return textResponse("OK");
    }
    return jsonResponse({ ok: false, error: "Server xatosi." }, 500);
  }
}

async function handleScheduled(controller, env) {
  try {
    await runReminders(env);
  } catch (error) {
    console.error("Cron error:", error);
  }
}

function textResponse(text, status = 200) {
  return new Response(text, {
    status,
    headers: { "content-type": "text/plain; charset=UTF-8" }
  });
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=UTF-8",
      "cache-control": "no-store"
    }
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function rememberOrigin(env, origin) {
  if (!env.KEGEL_KV) throw new Error("KEGEL_KV binding missing");
  const current = await env.KEGEL_KV.get("config:origin");
  if (current !== origin) await env.KEGEL_KV.put("config:origin", origin);
}

async function setWebhook(url, env) {
  const origin = url.origin;
  await rememberOrigin(env, origin);
  const webhookUrl = `${origin}/webhook`;

  const result = await telegram(env, "setWebhook", {
    url: webhookUrl,
    secret_token: await webhookSecret(env),
    drop_pending_updates: true,
    allowed_updates: ["message", "callback_query"]
  });

  return jsonResponse({
    ok: Boolean(result.ok),
    webhook: webhookUrl,
    telegram: result
  });
}

async function handleWebhook(request, env) {
  let update;
  try {
    update = await request.json();
  } catch (error) {
    console.error("Invalid webhook JSON:", error);
    return;
  }

  if (update?.callback_query) {
    await handleCallback(update.callback_query, env);
    return;
  }

  if (update?.message) {
    await handleMessage(update.message, env);
  }
}

async function handleMessage(message, env) {
  if (!message?.from) return;

  const user = await getOrCreateUser(message.from, env);
  const text = String(message.text || "").trim();

  if (text.startsWith("/start")) {
    await showStartScreen(user, env);
    return;
  }

  if (text === "/schedule") {
    await showScheduleSettings(user, env);
    return;
  }

  if (text === "/today") {
    await showToday(user, env);
    return;
  }

  if (user.awaiting === "times") {
    await receiveTimes(user, text, env);
    return;
  }

  if (text) {
    await sendMessage(
      user.id,
      "Menyudan kerakli bo\u2018limni tanlang yoki /schedule orqali jadvalni sozlang.",
      env,
      await mainMenuKeyboard(env)
    );
  }
}

async function handleCallback(query, env) {
  const from = query?.from;
  if (!from) return;

  const user = await getOrCreateUser(from, env);
  const data = String(query.data || "");

  await answerCallback(query.id, env);

  if (data === "menu_today") return showToday(user, env);
  if (data === "menu_program") return showProgram(user, env);
  if (data === "menu_stats") return showStats(user, env);
  if (data === "menu_schedule") return showScheduleSettings(user, env);
  if (data === "menu_about") return showAbout(user, env);
  if (data === "start_program") return startProgram(user, env);
  if (data === "schedule_days") return showDayPicker(user, env);
  if (data === "schedule_sessions") return showSessionPicker(user, env);
  if (data === "schedule_times") return askForTimes(user, env);
  if (data === "cancel_schedule") return cancelSchedule(user, env);

  if (/^schedule_day_[1-7]$/.test(data)) {
    return toggleScheduleDay(user, Number(data.slice(-1)), env);
  }

  if (/^schedule_sessions_[2-5]$/.test(data)) {
    return setSessionsPerDay(user, Number(data.slice(-1)), env);
  }

  if (
    data === "begin" ||
    data === "rest" ||
    data === "done" ||
    data === "start_session" ||
    data === "finish_session"
  ) {
    await sendMessage(
      user.id,
      "Eski tugma bekor qilingan. Bugungi mashqni oching.",
      env,
      await mainMenuKeyboard(env)
    );
    return;
  }

  await sendMessage(
    user.id,
    "Bu tugma endi faol emas. Bugungi mashqni oching.",
    env,
    await mainMenuKeyboard(env)
  );
}

async function answerCallback(id, env) {
  try {
    await telegram(env, "answerCallbackQuery", { callback_query_id: id });
  } catch (error) {
    console.error("answerCallbackQuery error:", error);
  }
}

async function getOrCreateUser(from, env) {
  const id = String(from.id);
  let user = await loadUser(id, env);

  const name =
    [from.first_name, from.last_name].filter(Boolean).join(" ").trim() ||
    from.username ||
    "Foydalanuvchi";

  if (!user) {
    user = {
      id,
      name,
      day: 1,
      streak: 0,
      started: false,
      schedule: { days: [], sessionsPerDay: 3, times: [] },
      sessions: [],
      lastCompletedDate: null,
      reminderSlots: [],
      awaiting: null
    };
    await saveUser(user, env);
  } else if (user.name !== name) {
    user.name = name;
    await saveUser(user, env);
  }

  return user;
}

async function loadUser(id, env) {
  const raw = await env.KEGEL_KV.get(`user:${id}`);
  if (!raw) return null;

  try {
    return normalizeUser(JSON.parse(raw));
  } catch (error) {
    console.error("Invalid user data:", id, error);
    return null;
  }
}

function normalizeUser(user) {
  const schedule = user.schedule || {};

  return {
    id: String(user.id),
    name: String(user.name || "Foydalanuvchi"),
    day: Math.min(30, Math.max(1, Number(user.day || 1))),
    streak: Math.max(0, Number(user.streak || 0)),
    started: Boolean(user.started),
    schedule: {
      days: Array.isArray(schedule.days)
        ? schedule.days.map(Number).filter(v => v >= 1 && v <= 7).sort((a, b) => a - b)
        : [],
      sessionsPerDay: Math.min(5, Math.max(2, Number(schedule.sessionsPerDay || 3))),
      times: Array.isArray(schedule.times)
        ? schedule.times.map(String).filter(validTime).sort()
        : []
    },
    sessions: Array.isArray(user.sessions) ? user.sessions : [],
    lastCompletedDate: user.lastCompletedDate || null,
    finished: Boolean(user.finished),
    free: {
      count: Math.max(0, Number(user.free?.count || 0)),
      seconds: Math.max(0, Number(user.free?.seconds || 0)),
      lastDate: user.free?.lastDate || null
    },
    reminderSlots: Array.isArray(user.reminderSlots) ? user.reminderSlots : [],
    awaiting: user.awaiting || null
  };
}

async function saveUser(user, env) {
  await env.KEGEL_KV.put(`user:${user.id}`, JSON.stringify(user));
}

async function showStartScreen(user, env) {
  if (user.started) {
    await sendMessage(
      user.id,
      `Salom, <b>${escapeHtml(user.name)}</b>!\n\nSiz ${user.day}-kun dasturidasiz.`,
      env,
      await mainMenuKeyboard(env)
    );
    return;
  }

  await sendMessage(
    user.id,
    "<b>KEGEL COACH</b>\n\nTos tubi mushaklarini bosqichma-bosqich mashq qiling. Avval jadvalni sozlang, keyin 30 kunlik dastur boshlanadi.",
    env,
    [
      [{ text: "BOSHLASH", callback_data: "start_program" }],
      [{ text: "Jadvalni sozlash", callback_data: "menu_schedule" }],
      [{ text: "Kegel nima?", callback_data: "menu_about" }]
    ]
  );
}

async function mainMenuKeyboard(env) {
  const origin = (await env.KEGEL_KV.get("config:origin")) || "";
  const appUrl = origin ? `${origin}/app` : "/app";

  return [
    [{ text: "\uD83C\uDFAF Bugungi mashq", web_app: { url: appUrl } }],
    [
      { text: "\uD83D\uDCC5 30 kunlik dastur", callback_data: "menu_program" },
      { text: "\uD83D\uDCCA Statistikam", callback_data: "menu_stats" }
    ],
    [
      { text: "\uD83D\uDD14 Eslatmalar", callback_data: "menu_schedule" },
      { text: "\u2139\uFE0F Kegel nima?", callback_data: "menu_about" }
    ]
  ];
}

async function sendMessage(chatId, text, env, keyboard = null) {
  const payload = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true
  };

  if (keyboard) payload.reply_markup = { inline_keyboard: keyboard };
  return telegram(env, "sendMessage", payload);
}

async function startProgram(user, env) {
  if (!validSchedule(user.schedule)) {
    await sendMessage(
      user.id,
      "Avval jadvalni sozlang: 3-5 ta kun va 2-5 ta mashg\u2018ulot vaqtini tanlang.",
      env,
      [[{ text: "Jadvalni sozlash", callback_data: "menu_schedule" }]]
    );
    return;
  }

  user.started = true;
  if (!Number.isInteger(user.day) || user.day < 1 || user.day > 30) user.day = 1;

  await saveUser(user, env);
  await rebuildReminderSlots(user, env);

  await sendMessage(
    user.id,
    "Dastur boshlandi. Bugungi mashqni Telegram Mini App orqali bajaring.",
    env,
    await mainMenuKeyboard(env)
  );
}

async function showToday(user, env) {
  if (!user.started) {
    await showStartScreen(user, env);
    return;
  }

  const date = getLocalDate();
  const weekday = getLocalWeekday();

  if (user.day >= 30 && allDaySessionsCompleted(user, user.day, date)) {
    await sendMessage(
      user.id,
      "30 kunlik dastur yakunlandi. Tabriklaymiz! Statistikada natijangizni ko\u2018rishingiz mumkin.",
      env,
      await mainMenuKeyboard(env)
    );
    return;
  }

  const config = getProgramDay(user.day);
  const done = user.lastCompletedDate === date
    ? user.schedule.times.length
    : completedCountForDay(user, user.day, date);
  const isTrainingDay = user.schedule.days.includes(weekday);

  const status = isTrainingDay
    ? `Bugun mashq kuni.\nBajarilgan: ${done}/${user.schedule.times.length} ta mashg\u2018ulot.\nMashqni istalgan vaqtda davom ettirishingiz mumkin.`
    : `Bugun dam olish kuni (${DAY_NAMES[weekday - 1]}).`;

  await sendMessage(
    user.id,
    `<b>${user.day}-kun</b>\n\n${programText(config)}\n\n${status}`,
    env,
    await mainMenuKeyboard(env)
  );
}

async function showProgram(user, env) {
  const day = Math.min(30, Math.max(1, user.day));
  const config = getProgramDay(day);

  await sendMessage(
    user.id,
    `<b>30 kunlik dastur</b>\n\nHozirgi bosqich: <b>${day}-kun</b>.\n\n${programText(config)}\n\nHar bir mashg\u2018ulot avval Sekin Kegel, keyin Tez Kegel blokidan iborat.`,
    env,
    await mainMenuKeyboard(env)
  );
}

async function showStats(user, env) {
  const completed = user.sessions.filter(s => s.completed).length;
  const uniqueDays = new Set(
    user.sessions.filter(s => s.completed).map(s => s.date)
  ).size;

  await sendMessage(
    user.id,
    `<b>Statistikam</b>\n\nJoriy kun: <b>${user.day}/30</b>\nStreak: <b>${user.streak}</b>\nBajarilgan mashg\u2018ulotlar: <b>${completed}</b>\nMashq qilingan sanalar: <b>${uniqueDays}</b>\nErkin mashqlar: <b>${user.free.count}</b>`,
    env,
    await mainMenuKeyboard(env)
  );
}

async function showAbout(user, env) {
  await sendMessage(
    user.id,
    "<b>Kegel nima?</b>\n\nKegel tos tubi mushaklarini mustahkamlaydi. U testosteronni bevosita oshirmaydi. Siydik chiqarishni to\u2018xtatib mashq qilmang. Og\u2018riq paydo bo\u2018lsa, mashqni to\u2018xtating.",
    env,
    await mainMenuKeyboard(env)
  );
}

async function showScheduleSettings(user, env) {
  const schedule = user.schedule;
  const days = schedule.days.length
    ? schedule.days.map(day => DAY_NAMES[day - 1]).join(", ")
    : "tanlanmagan";
  const times = schedule.times.length
    ? schedule.times.join(", ")
    : "tanlanmagan";

  const text =
    `<b>Eslatmalar jadvali</b>\n\n` +
    `Kunlar: ${escapeHtml(days)}\n` +
    `Kuniga mashg\u2018ulot: ${schedule.sessionsPerDay}\n` +
    `Vaqtlar: ${escapeHtml(times)}\n\n` +
    "3-5 ta kun va 2-5 ta vaqt tanlang.";

  await sendMessage(
    user.id,
    text,
    env,
    [
      [{ text: "Kunlarni tanlash", callback_data: "schedule_days" }],
      [{ text: "Mashg\u2018ulot soni", callback_data: "schedule_sessions" }],
      [{ text: "Aniq vaqtlarni kiritish", callback_data: "schedule_times" }],
      [{ text: "Bekor qilish", callback_data: "cancel_schedule" }]
    ]
  );
}

async function showDayPicker(user, env) {
  const selected = new Set(user.schedule.days);
  const rows = [[1, 2], [3, 4], [5, 6], [7]];

  const keyboard = rows.map(row =>
    row.map(day => ({
      text: `${selected.has(day) ? "\u2705 " : ""}${DAY_NAMES[day - 1]}`,
      callback_data: `schedule_day_${day}`
    }))
  );

  keyboard.push([{ text: "Saqlash", callback_data: "menu_schedule" }]);

  await sendMessage(
    user.id,
    "<b>Hafta kunlari</b>\n\n3-5 ta kunni tanlang.",
    env,
    keyboard
  );
}

async function toggleScheduleDay(user, day, env) {
  const selected = new Set(user.schedule.days);

  if (selected.has(day)) selected.delete(day);
  else selected.add(day);

  user.schedule.days = [...selected].sort((a, b) => a - b);
  await saveUser(user, env);
  await showDayPicker(user, env);
}

async function showSessionPicker(user, env) {
  const keyboard = [
    [2, 3, 4, 5].map(value => ({
      text: value === user.schedule.sessionsPerDay ? `\u2705 ${value}` : String(value),
      callback_data: `schedule_sessions_${value}`
    }))
  ];

  await sendMessage(user.id, "Kuniga nechta mashg\u2018ulot?", env, keyboard);
}

async function setSessionsPerDay(user, number, env) {
  user.schedule.sessionsPerDay = number;
  user.schedule.times = user.schedule.times.slice(0, number);
  await saveUser(user, env);
  await showScheduleSettings(user, env);
}

async function askForTimes(user, env) {
  user.awaiting = "times";
  await saveUser(user, env);

  await sendMessage(
    user.id,
    `Kuniga ${user.schedule.sessionsPerDay} ta vaqtni bitta xabarda yuboring.\n\nMasalan: <code>07:30 12:00 18:30</code>\n\nVaqtlar HH:MM bo\u2018lsin va takrorlanmasin.`,
    env,
    [[{ text: "Bekor qilish", callback_data: "cancel_schedule" }]]
  );
}

async function receiveTimes(user, text, env) {
  const parsed = parseTimes(text);

  if (!parsed.ok) {
    await sendMessage(
      user.id,
      "Vaqt formati noto\u2018g\u2018ri. Masalan: <code>07:30 12:00 18:30</code>. 2-5 ta vaqt yozing va takrorlamang.",
      env
    );
    return;
  }

  if (parsed.times.length !== Number(user.schedule.sessionsPerDay)) {
    await sendMessage(
      user.id,
      `Aynan ${user.schedule.sessionsPerDay} ta vaqt yuboring.`,
      env
    );
    return;
  }

  user.schedule.times = parsed.times;
  user.awaiting = null;

  await saveUser(user, env);
  if (user.started) await rebuildReminderSlots(user, env);

  await sendMessage(
    user.id,
    "Jadval saqlandi. Eslatmalar tanlagan kun va vaqtlaringizda keladi.",
    env,
    await mainMenuKeyboard(env)
  );
}

async function cancelSchedule(user, env) {
  user.awaiting = null;
  await saveUser(user, env);

  await sendMessage(
    user.id,
    "Sozlash bekor qilindi.",
    env,
    await mainMenuKeyboard(env)
  );
}

function parseTimes(input) {
  const parts = String(input).trim().split(/[ ,;]+/).filter(Boolean);
  if (parts.length < 2 || parts.length > 5) return { ok: false };

  const times = parts.map(value => value.trim());
  if (!times.every(validTime)) return { ok: false };

  const unique = [...new Set(times)].sort();
  if (unique.length !== times.length) return { ok: false };

  return { ok: true, times: unique };
}

function validTime(value) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value));
}

function validSchedule(schedule) {
  if (!schedule) return false;
  if (!Array.isArray(schedule.days) || schedule.days.length < 3 || schedule.days.length > 5) return false;
  if (!Array.isArray(schedule.times) || schedule.times.length < 2 || schedule.times.length > 5) return false;
  if (schedule.times.length !== Number(schedule.sessionsPerDay)) return false;
  if (new Set(schedule.times).size !== schedule.times.length) return false;
  return schedule.times.every(validTime);
}

async function rebuildReminderSlots(user, env) {
  for (const oldSlot of user.reminderSlots || []) {
    await removeUserFromSlot(oldSlot, user.id, env);
  }

  user.reminderSlots = [];

  if (user.started && validSchedule(user.schedule)) {
    for (const weekday of user.schedule.days) {
      for (const time of user.schedule.times) {
        const slot = `${weekday}:${time}`;
        const key = `slot:${slot}`;
        const ids = await readJsonArray(key, env);

        if (!ids.includes(user.id)) ids.push(user.id);

        await env.KEGEL_KV.put(key, JSON.stringify(ids));
        user.reminderSlots.push(slot);
      }
    }
  }

  await saveUser(user, env);
}

async function removeUserFromSlot(slot, id, env) {
  const key = `slot:${slot}`;
  const ids = await readJsonArray(key, env);
  const filtered = ids.filter(value => String(value) !== String(id));

  if (filtered.length) await env.KEGEL_KV.put(key, JSON.stringify(filtered));
  else await env.KEGEL_KV.delete(key);
}

async function readJsonArray(key, env) {
  const raw = await env.KEGEL_KV.get(key);
  if (!raw) return [];

  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

async function runReminders(env) {
  const local = getLocalParts(new Date());
  const slot = `${local.weekday}:${local.hhmm}`;
  const ids = await readJsonArray(`slot:${slot}`, env);

  if (!ids.length) return;

  for (const id of ids) {
    try {
      const user = await loadUser(String(id), env);

      if (!user || !user.started || !validSchedule(user.schedule)) continue;
      if (!user.schedule.days.includes(local.weekday)) continue;
      if (!user.schedule.times.includes(local.hhmm)) continue;

      const sentKey = `sent:${id}:${local.date}:${local.hhmm}`;
      if (await env.KEGEL_KV.get(sentKey)) continue;

      const completed = completedCountForDay(user, user.day, local.date);
      if (completed >= user.schedule.times.length) continue;

      const sessionNumber = user.schedule.times.indexOf(local.hhmm) + 1;
      const origin = (await env.KEGEL_KV.get("config:origin")) || "";

      const keyboard = origin
        ? [[{
            text: "\uD83C\uDFAF Mashqni boshlash",
            web_app: { url: `${origin}/app` }
          }]]
        : null;

      await sendMessage(
        user.id,
        `<b>Eslatma</b>\n\n${user.day}-kun, ${sessionNumber}-mashg\u2018ulot vaqti keldi. Qulay payt bo\u2018lganda boshlashingiz mumkin.`,
        env,
        keyboard
      );

      await env.KEGEL_KV.put(sentKey, "1", { expirationTtl: SENT_TTL });
    } catch (error) {
      console.error("Reminder error:", id, error);
    }
  }
}

async function apiStatus(request, env) {
  const auth = await authenticateInitData(request, env);
  if (!auth.ok) return jsonResponse({ ok: false, error: auth.error }, 401);

  const user = await loadUser(String(auth.user.id), env);
  if (!user) {
    return jsonResponse({
      ok: false,
      error: "Foydalanuvchi topilmadi. Telegram botda /start bosing."
    }, 400);
  }

  const local = getLocalParts(new Date());
  const scheduleOk = validSchedule(user.schedule);
  const total = scheduleOk ? user.schedule.times.length : 0;
  const doneToday = user.lastCompletedDate === local.date;
  const done = !scheduleOk ? 0 : doneToday ? total : completedCountForDay(user, user.day, local.date);
  const isTrainingDay = scheduleOk && user.schedule.days.includes(local.weekday);
  const allDone = scheduleOk && done >= total;

  let note = "";
  let planAvailable = false;

  if (!user.started) {
    note = "Reja hali boshlanmagan. Botda BOSHLASH tugmasini bosing. Hozircha erkin mashq qilishingiz mumkin.";
  } else if (!scheduleOk) {
    note = "Jadval sozlanmagan. Botda Eslatmalar orqali jadvalni sozlang.";
  } else if (user.finished) {
    note = "30 kunlik dastur yakunlangan. Tabriklaymiz! Erkin mashq qilishda davom eting.";
  } else if (!isTrainingDay) {
    note = "Bugun dam olish kuni. Xohlasangiz erkin mashq qilishingiz mumkin.";
  } else if (allDone) {
    note = "Bugungi reja to\u2018liq bajarildi. Ajoyib! Ertaga davom etasiz.";
  } else {
    planAvailable = true;
    note = "Mashqni istalgan vaqtda boshlashingiz mumkin. Eslatma vaqti faqat tavsiya.";
  }

  return jsonResponse({
    ok: true,
    name: user.name,
    day: user.day,
    streak: user.streak,
    started: user.started,
    scheduleOk,
    isTrainingDay,
    done,
    total,
    allDone,
    finished: user.finished,
    planAvailable,
    note,
    program: programText(getProgramDay(Math.min(30, Math.max(1, user.day)))),
    freeCount: user.free.count
  });
}

async function apiStart(request, env) {
  const auth = await authenticateInitData(request, env);

  if (!auth.ok) return jsonResponse({ ok: false, error: auth.error }, 401);

  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const mode = body && body.mode === "free" ? "free" : "plan";

  const user = await loadUser(String(auth.user.id), env);

  if (!user) {
    return jsonResponse({
      ok: false,
      error: "Foydalanuvchi topilmadi. Telegram botda /start bosing."
    }, 400);
  }

  const now = new Date();
  const local = getLocalParts(now);
  let sessionNumber = 0;
  let scheduledTime = null;

  if (mode === "plan") {
    if (!user.started) {
      return jsonResponse({
        ok: false,
        error: "Avval botda BOSHLASH tugmasini bosing."
      }, 400);
    }

    if (!validSchedule(user.schedule)) {
      return jsonResponse({
        ok: false,
        error: "Avval jadvalni sozlang."
      }, 400);
    }

    if (user.finished) {
      return jsonResponse({ ok: false, error: "Dastur yakunlangan." }, 400);
    }

    if (!user.schedule.days.includes(local.weekday)) {
      return jsonResponse({
        ok: false,
        error: "Bugun dam olish kuni. Erkin mashq qilishingiz mumkin."
      }, 400);
    }

    if (
      user.lastCompletedDate === local.date ||
      allDaySessionsCompleted(user, user.day, local.date)
    ) {
      return jsonResponse({
        ok: false,
        error: "Bugungi mashg\u2018ulotlar tugagan."
      }, 400);
    }

    sessionNumber = completedCountForDay(user, user.day, local.date) + 1;

    if (sessionNumber > user.schedule.times.length) {
      return jsonResponse({
        ok: false,
        error: "Bugungi mashg\u2018ulotlar tugagan."
      }, 400);
    }

    scheduledTime = user.schedule.times[sessionNumber - 1];
  }

  const programDay = Math.min(30, Math.max(1, Number(user.day || 1)));
  const config = getProgramDay(programDay);
  const segments = buildSegments(config);
  const total = segments.reduce((sum, segment) => sum + segment.seconds, 0);
  const startedAt = Date.now();

  const tokenData =
    `${user.id}|${programDay}|${sessionNumber}|${local.date}|${startedAt}|${total}|${mode}`;

  const token = await hmacHex(
    `kegel-session:${env.BOT_TOKEN}`,
    tokenData
  );

  await env.KEGEL_KV.put(
    `session:${token}`,
    JSON.stringify({
      id: user.id,
      day: programDay,
      session: sessionNumber,
      date: local.date,
      startedAt,
      total,
      mode
    }),
    { expirationTtl: SESSION_TTL }
  );

  return jsonResponse({
    ok: true,
    mode,
    day: programDay,
    session: sessionNumber,
    date: local.date,
    scheduledTime,
    startedAt,
    total,
    segments,
    token
  });
}

async function apiComplete(request, env) {
  const auth = await authenticateInitData(request, env);

  if (!auth.ok) return jsonResponse({ ok: false, error: auth.error }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ ok: false, error: "JSON noto\u2018g\u2018ri." }, 400);
  }

  const token = String(body.token || "");
  if (!token) return jsonResponse({ ok: false, error: "Session token yo\u2018q." }, 400);

  const raw = await env.KEGEL_KV.get(`session:${token}`);
  if (!raw) {
    return jsonResponse({
      ok: false,
      error: "Session token yaroqsiz yoki muddati tugagan."
    }, 400);
  }

  let session;
  try {
    session = JSON.parse(raw);
  } catch {
    return jsonResponse({ ok: false, error: "Session token buzilgan." }, 400);
  }

  if (String(session.id) !== String(auth.user.id)) {
    return jsonResponse({ ok: false, error: "Ruxsat yo\u2018q." }, 403);
  }

  const expected = await hmacHex(
    `kegel-session:${env.BOT_TOKEN}`,
    `${session.id}|${session.day}|${session.session}|${session.date}|${session.startedAt}|${session.total}|${session.mode || "plan"}`
  );

  if (!timingSafeEqualHex(token, expected)) {
    return jsonResponse({ ok: false, error: "Session token noto\u2018g\u2018ri." }, 400);
  }

  const elapsed = Math.floor((Date.now() - Number(session.startedAt)) / 1000);

  if (elapsed < Number(session.total) - 3) {
    return jsonResponse({ ok: false, error: "Mashq juda tez tugatildi." }, 400);
  }

  if (elapsed > 4 * 60 * 60) {
    return jsonResponse({ ok: false, error: "Session muddati tugagan." }, 400);
  }

  const user = await loadUser(String(auth.user.id), env);

  const isFree = session.mode === "free";

  if (!user || (!user.started && !isFree)) {
    return jsonResponse({ ok: false, error: "Foydalanuvchi faol emas." }, 400);
  }

  const now = new Date();
  const local = getLocalParts(now);

  if (local.date !== session.date) {
    return jsonResponse({ ok: false, error: "Session sanasi o\u2018zgargan." }, 400);
  }

  if (isFree) {
    user.free = {
      count: Number(user.free?.count || 0) + 1,
      seconds: Number(user.free?.seconds || 0) + elapsed,
      lastDate: local.date
    };

    await saveUser(user, env);
    await env.KEGEL_KV.delete(`session:${token}`);

    const freeProgress = `Erkin mashqlar soni: ${user.free.count}.`;

    await sendMessage(
      user.id,
      `<b>Erkin mashq yakunlandi!</b>\n\n${freeProgress}\nBu mashq 30 kunlik reja hisobiga kirmaydi.`,
      env,
      await mainMenuKeyboard(env)
    );

    return jsonResponse({
      ok: true,
      mode: "free",
      day: user.day,
      streak: user.streak,
      allDaySessionsDone: false,
      progress: freeProgress
    });
  }

  if (!user.schedule.days.includes(local.weekday)) {
    return jsonResponse({ ok: false, error: "BUGUN MASHQ KUNI EMAS." }, 400);
  }

  if (Number(user.day) !== Number(session.day)) {
    return jsonResponse({
      ok: false,
      error: "Bu dastur kuni allaqachon o\u2018zgargan."
    }, 400);
  }

  if (user.lastCompletedDate === local.date) {
    return jsonResponse({
      ok: false,
      error: "Bugungi mashg\u2018ulotlar tugagan."
    }, 400);
  }

  const completed = completedCountForDay(user, user.day, local.date);

  if (completed >= user.schedule.times.length) {
    return jsonResponse({
      ok: false,
      error: "BUGUNGI MASHG\u2018ULOTLAR TUGAGAN."
    }, 400);
  }

  const expectedSession = completed + 1;

  if (Number(session.session) !== expectedSession) {
    return jsonResponse({
      ok: false,
      error: "Mashg\u2018ulot tartibi noto\u2018g\u2018ri."
    }, 400);
  }

  const duplicate = user.sessions.some(
    item =>
      Number(item.day) === Number(session.day) &&
      Number(item.session) === Number(session.session) &&
      item.date === local.date &&
      item.completed
  );

  if (duplicate) {
    return jsonResponse({
      ok: false,
      error: "Bu mashg\u2018ulot allaqachon bajarilgan."
    }, 409);
  }

  user.sessions.push({
    day: Number(session.day),
    session: Number(session.session),
    seconds: elapsed,
    completed: true,
    date: local.date,
    at: new Date().toISOString()
  });

  const allDone =
    completedCountForDay(user, session.day, local.date) >=
    user.schedule.times.length;

  if (allDone) {
    user.streak += 1;
    user.lastCompletedDate = local.date;
    if (user.day < 30) user.day += 1;
    else user.finished = true;
  }

  await saveUser(user, env);
  await env.KEGEL_KV.delete(`session:${token}`);

  const progress = allDone
    ? `Keyingi kun: ${user.day}/30.`
    : `Bugun: ${completedCountForDay(user, session.day, local.date)}/${user.schedule.times.length} ta mashg\u2018ulot.`;

  await sendMessage(
    user.id,
    `<b>Mashg\u2018ulot yakunlandi!</b>\n\n${progress}\nStreak: ${user.streak}`,
    env,
    await mainMenuKeyboard(env)
  );

  return jsonResponse({
    ok: true,
    day: user.day,
    streak: user.streak,
    allDaySessionsDone: allDone,
    progress
  });
}

async function authenticateInitData(request, env) {
  const initData =
    request.headers.get("X-Telegram-Init-Data") ||
    request.headers.get("x-telegram-init-data") ||
    "";

  if (!initData) {
    return { ok: false, error: "Telegram initData topilmadi." };
  }

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  const authDate = Number(params.get("auth_date"));

  if (!hash || !authDate) {
    return {
      ok: false,
      error: "Telegram autentifikatsiyasi noto\u2018g\u2018ri."
    };
  }

  const nowSeconds = Math.floor(Date.now() / 1000);

  if (
    !Number.isFinite(authDate) ||
    nowSeconds - authDate > 86400 ||
    authDate > nowSeconds + 60
  ) {
    return {
      ok: false,
      error: "Telegram sessiyasi eskirgan."
    };
  }

  const entries = [];
  for (const [key, value] of params.entries()) {
    if (key !== "hash") entries.push([key, value]);
  }

  entries.sort((a, b) => a[0].localeCompare(b[0]));

  const dataCheckString =
    entries.map(([key, value]) => `${key}=${value}`).join("\n");

  const secret = await hmacRaw("WebAppData", env.BOT_TOKEN);
  const calculated = await hmacHexRaw(secret, dataCheckString);

  if (!timingSafeEqualHex(hash, calculated)) {
    return {
      ok: false,
      error: "Telegram autentifikatsiyasi noto\u2018g\u2018ri."
    };
  }

  let telegramUser;
  try {
    telegramUser = JSON.parse(params.get("user") || "{}");
  } catch {
    return {
      ok: false,
      error: "Telegram user ma\u2019lumotlari noto\u2018g\u2018ri."
    };
  }

  if (!telegramUser.id) {
    return {
      ok: false,
      error: "Telegram user ID topilmadi."
    };
  }

  return { ok: true, user: telegramUser };
}

async function hmacRaw(keyText, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(keyText),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  return new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(message)
    )
  );
}

async function hmacHex(keyText, message) {
  return hmacHexRaw(await importHmacKey(keyText), message);
}

async function hmacHexRaw(keyBytes, message) {
  const key =
    keyBytes instanceof CryptoKey
      ? keyBytes
      : await crypto.subtle.importKey(
          "raw",
          keyBytes,
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign"]
        );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message)
  );

  return bytesToHex(new Uint8Array(signature));
}

async function importHmacKey(keyText) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(keyText),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

function bytesToHex(bytes) {
  return Array.from(bytes)
    .map(value => value.toString(16).padStart(2, "0"))
    .join("");
}

function timingSafeEqualHex(a, b) {
  const left = String(a).toLowerCase();
  const right = String(b).toLowerCase();

  if (left.length !== right.length) return false;

  let difference = 0;
  for (let i = 0; i < left.length; i++) {
    difference |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return difference === 0;
}

async function webhookSecret(env) {
  if (!env.BOT_TOKEN) throw new Error("BOT_TOKEN secret missing");
  return await hmacHex(`kegel-webhook:${env.BOT_TOKEN}`, "telegram-webhook-secret");
}

async function telegram(env, method, payload) {
  if (!env.BOT_TOKEN) throw new Error("BOT_TOKEN secret missing");

  const response = await fetch(
    `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    }
  );

  const data = await response.json();

  if (!data.ok) console.error("Telegram API error:", method, data);
  return data;
}

function getLocalParts(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);

  const values = Object.fromEntries(
    parts.map(part => [part.type, part.value])
  );

  const year = Number(values.year);
  const month = Number(values.month);
  const day = Number(values.day);

  const utcWeekday = new Date(
    Date.UTC(year, month - 1, day)
  ).getUTCDay();

  const weekday = utcWeekday === 0 ? 7 : utcWeekday;

  return {
    date: `${values.year}-${values.month}-${values.day}`,
    hhmm: `${values.hour}:${values.minute}`,
    weekday
  };
}

function getLocalDate(date = new Date()) {
  return getLocalParts(date).date;
}

function getLocalWeekday(date = new Date()) {
  return getLocalParts(date).weekday;
}

function localMinutes(date = new Date()) {
  const hhmm = getLocalParts(date).hhmm;
  return Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
}

function parseTimeMinutes(time) {
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
}

function getProgramDay(day) {
  if (day <= 7) {
    return {
      slowSets: 2,
      slowReps: 8,
      slowSqueeze: 3,
      slowRelease: 3,
      fastSets: 2,
      fastReps: 10,
      fastSqueeze: 1,
      fastRelease: 1,
      breakSeconds: 20
    };
  }

  if (day <= 14) {
    return {
      slowSets: 3,
      slowReps: 10,
      slowSqueeze: 4,
      slowRelease: 4,
      fastSets: 2,
      fastReps: 15,
      fastSqueeze: 1,
      fastRelease: 1,
      breakSeconds: 20
    };
  }

  if (day <= 21) {
    return {
      slowSets: 3,
      slowReps: 10,
      slowSqueeze: 5,
      slowRelease: 5,
      fastSets: 3,
      fastReps: 15,
      fastSqueeze: 1,
      fastRelease: 1,
      breakSeconds: 25
    };
  }

  return {
    slowSets: 3,
    slowReps: 10,
    slowSqueeze: 6,
    slowRelease: 6,
    fastSets: 3,
    fastReps: 20,
    fastSqueeze: 1,
    fastRelease: 1,
    breakSeconds: 30
  };
}

function programText(config) {
  return (
    `Sekin Kegel: ${config.slowSets} podxod x ${config.slowReps} takror (${config.slowSqueeze}s qisish / ${config.slowRelease}s bo\u2018shatish).\n` +
    `Tez Kegel: ${config.fastSets} podxod x ${config.fastReps} takror (1s / 1s).\n` +
    `Podxodlar orasida: ${config.breakSeconds}s dam.`
  );
}

function buildSegments(config) {
  const segments = [];

  segments.push({
    type: "p",
    seconds: 5,
    blockName: "Tayyorlanish",
    setNo: 0,
    setsTotal: config.slowSets + config.fastSets,
    repNo: 0,
    repsTotal: 0
  });

  for (let set = 1; set <= config.slowSets; set++) {
    for (let rep = 1; rep <= config.slowReps; rep++) {
      segments.push({
        type: "s",
        seconds: config.slowSqueeze,
        blockName: "Sekin Kegel",
        setNo: set,
        setsTotal: config.slowSets,
        repNo: rep,
        repsTotal: config.slowReps
      });

      if (rep < config.slowReps) {
        segments.push({
          type: "r",
          seconds: config.slowRelease,
          blockName: "Sekin Kegel",
          setNo: set,
          setsTotal: config.slowSets,
          repNo: rep,
          repsTotal: config.slowReps
        });
      }
    }

    if (set < config.slowSets) {
      segments.push({
        type: "b",
        seconds: config.breakSeconds,
        blockName: "Sekin Kegel",
        setNo: set,
        setsTotal: config.slowSets,
        repNo: config.slowReps,
        repsTotal: config.slowReps
      });
    }
  }

  for (let set = 1; set <= config.fastSets; set++) {
    for (let rep = 1; rep <= config.fastReps; rep++) {
      segments.push({
        type: "s",
        seconds: config.fastSqueeze,
        blockName: "Tez Kegel",
        setNo: set,
        setsTotal: config.fastSets,
        repNo: rep,
        repsTotal: config.fastReps
      });

      if (rep < config.fastReps) {
        segments.push({
          type: "r",
          seconds: config.fastRelease,
          blockName: "Tez Kegel",
          setNo: set,
          setsTotal: config.fastSets,
          repNo: rep,
          repsTotal: config.fastReps
        });
      }
    }

    if (set < config.fastSets) {
      segments.push({
        type: "b",
        seconds: config.breakSeconds,
        blockName: "Tez Kegel",
        setNo: set,
        setsTotal: config.fastSets,
        repNo: config.fastReps,
        repsTotal: config.fastReps
      });
    }
  }

  return segments;
}

function completedCountForDay(user, day, date) {
  return user.sessions.filter(
    session =>
      Number(session.day) === Number(day) &&
      session.date === date &&
      session.completed
  ).length;
}

function allDaySessionsCompleted(user, day, date) {
  if (!validSchedule(user.schedule)) return false;

  return (
    completedCountForDay(user, day, date) >=
    user.schedule.times.length
  );
}

const APP_HTML = `<!doctype html>
<html lang="uz">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,user-scalable=no">
<title>Kegel Coach</title>
<style>
:root{font-family:Arial,sans-serif;color:#f7f3e8;background:#061b13}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:radial-gradient(circle at 50% 0,#123b2a 0,#061b13 48%,#03100b 100%);display:flex;align-items:center;justify-content:center}
.wrap{width:min(100%,560px);min-height:100vh;padding:18px 16px 24px;display:flex;flex-direction:column;justify-content:center;gap:12px}
.top{display:flex;align-items:center;justify-content:space-between;padding:4px 4px 2px}
.brand{font-size:15px;letter-spacing:2px;font-weight:800;color:#e7c86a}.day{font-size:12px;color:#c9d5cd;background:rgba(255,255,255,.06);border:1px solid rgba(231,200,106,.25);border-radius:999px;padding:8px 11px}
.intro{font-size:14px;line-height:1.5;color:#cbd8d0;margin:0 2px 2px}
.guide{background:linear-gradient(180deg,rgba(13,48,35,.96),rgba(5,27,19,.98));border:1px solid rgba(231,200,106,.24);border-radius:28px;padding:18px;box-shadow:0 18px 50px rgba(0,0,0,.3);min-height:560px;display:flex;flex-direction:column}
.page{display:none;flex:1;flex-direction:column}.page.active{display:flex}
.kicker{display:flex;align-items:center;gap:10px;color:#e7c86a;font-weight:800;font-size:13px;letter-spacing:.4px}.num{width:34px;height:34px;border-radius:50%;display:grid;place-items:center;background:linear-gradient(145deg,#f2d985,#b88927);color:#142218;font-size:17px}
h1{font-size:28px;line-height:1.08;margin:14px 0 8px;color:#f4e4ad}h2{font-size:19px;margin:0 0 8px;color:#f4e4ad}.sub{font-size:14px;line-height:1.45;color:#cbd8d0;margin:0 0 14px}
.illustration{height:auto;aspect-ratio:520/330;border-radius:22px;background:linear-gradient(145deg,#102f24,#071912);border:1px solid rgba(255,255,255,.08);display:grid;place-items:center;overflow:hidden;margin-bottom:14px}.illustration svg{width:100%;height:100%}
.points{display:grid;gap:9px}.point{display:flex;gap:9px;align-items:flex-start;font-size:14px;line-height:1.35;color:#eef4ef}.check{flex:0 0 23px;width:23px;height:23px;border-radius:50%;display:grid;place-items:center;background:#4bc477;color:#062113;font-weight:900;font-size:14px}.cross{background:#e96565;color:#240808}
.tip{margin-top:auto;padding:11px 12px;border-radius:14px;background:rgba(231,200,106,.08);border:1px solid rgba(231,200,106,.18);font-size:12px;line-height:1.4;color:#d9e4dd}.tip b{color:#e7c86a}
.routine{display:grid;gap:10px;margin-top:4px}.routineCard{border:1px solid rgba(231,200,106,.22);border-radius:17px;padding:14px;background:rgba(0,0,0,.12);display:flex;gap:12px;align-items:center}.routineIcon{width:42px;height:42px;border-radius:50%;display:grid;place-items:center;background:rgba(231,200,106,.14);font-size:20px}.routineCard b{display:block;font-size:15px;margin-bottom:4px;color:#fff}.routineCard span{font-size:12px;color:#c5d2ca}
.nav{display:flex;gap:10px;margin-top:14px}.btn{border:0;border-radius:16px;padding:15px 16px;font-size:16px;font-weight:800;width:100%;cursor:pointer}.prev{background:rgba(255,255,255,.07);color:#d8e0db;border:1px solid rgba(255,255,255,.13)}.next{background:linear-gradient(145deg,#f3dc8d,#c29332);color:#152117}.next:disabled,.prev:disabled{opacity:.35;cursor:not-allowed}.start{font-size:17px;padding:17px 12px}.dots{display:flex;justify-content:center;gap:7px;margin-top:11px}.dot{width:7px;height:7px;border-radius:50%;background:#53645b}.dot.on{width:22px;border-radius:8px;background:#e7c86a}
.slots{display:flex;gap:10px;justify-content:center;margin:8px 0 14px;flex-wrap:wrap}.slot{width:48px;height:48px;border-radius:50%;display:grid;place-items:center;border:2px solid #53645b;color:#9fb8aa;font-weight:800;font-size:18px}.slot.done{background:#4bc477;border-color:#4bc477;color:#062113}.slot.next{border-color:#e7c86a;color:#e7c86a}
.home .btn{margin-top:10px}.home .tip{margin-top:6px}.homeProg{font-size:13px;line-height:1.45;color:#cbd8d0;white-space:pre-line;margin:16px 2px 0}.back{background:transparent;border:0;color:#e7c86a;font-size:14px;font-weight:700;padding:4px 2px;cursor:pointer;align-self:flex-start}
#workout{display:none}.workoutCard{background:rgba(0,0,0,.18);border-radius:24px;padding:22px;text-align:center;box-shadow:0 12px 35px rgba(0,0,0,.2)}
#phase{font-size:28px;font-weight:800;margin-bottom:10px}.count{font-size:110px;line-height:1;font-weight:800}.meta{font-size:18px;margin:8px 0}.progress{height:12px;border-radius:20px;background:rgba(255,255,255,.3);overflow:hidden}.bar{height:100%;width:0;background:#fff}.row{display:flex;justify-content:space-between;font-size:15px;margin-top:10px}.pause{background:rgba(255,255,255,.18);color:#fff;border:1px solid rgba(255,255,255,.4)}.small{opacity:.9;font-size:14px}
</style>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
</head>
<body>
<main id="homeApp" class="wrap" style="display:none">
<div class="top"><div class="brand">◈ KEGEL COACH</div><div class="day" id="homeDay">...</div></div>
<section class="guide home">
<div class="kicker"><span class="num">◷</span> BUGUNGI REJA</div>
<h1 id="homeTitle">Yuklanmoqda...</h1>
<p class="sub" id="homeSub"></p>
<div class="slots" id="slots"></div>
<div class="tip" id="homeNote"></div>
<button id="planBtn" class="btn next start" disabled>▶ REJADAGI MASHQNI BOSHLASH</button>
<button id="freeBtn" class="btn prev">Erkin mashq (reja hisobiga kirmaydi)</button>
<button id="guideBtn" class="btn prev">Yo‘riqnomani ko‘rish</button>
<p class="homeProg" id="homeProg"></p>
</section>
</main>

<main id="guideApp" class="wrap" style="display:none">
<div class="top"><button id="toHome" class="back">← Bosh sahifa</button><div class="day" id="guideDay">Yo‘riqnoma</div></div>
<p class="intro">Mashqni boshlashdan oldin 4 ta qisqa ko‘rsatmani ko‘rib chiqing. To‘g‘ri holat va texnika mashqni xavfsizroq va samaraliroq bajarishga yordam beradi.</p>
<section class="guide">
<div class="page active" data-page="0">
<div class="kicker"><span class="num">1</span> HOLAT</div><h1>Qanday holatda bo‘lish kerak?</h1><p class="sub">Yangi boshlovchi uchun yotgan holat eng qulay. Keyinchalik o‘tirib ham bajarish mumkin.</p>
<div class="illustration">
<svg viewBox="0 0 520 330" xmlns="http://www.w3.org/2000/svg" aria-label="Chalqancha yotish holati">
<rect width="520" height="330" rx="22" fill="#071b13"/>
<text x="260" y="40" text-anchor="middle" fill="#f4e4ad" font-size="25" font-family="Arial, Helvetica, sans-serif" font-weight="800">CHALQANCHA YOTING</text>
<rect x="28" y="236" width="464" height="16" rx="8" fill="#315c49"/>
<rect x="44" y="214" width="76" height="24" rx="12" fill="#567965"/>
<circle cx="86" cy="199" r="21" fill="#e5aa82"/>
<path d="M70 190 Q86 174 104 188" fill="#3b2a22"/>
<rect x="114" y="206" width="170" height="30" rx="15" fill="#2f7f9a"/>
<rect x="268" y="205" width="62" height="31" rx="15" fill="#243449"/>
<path d="M130 224 L250 227" stroke="#e5aa82" stroke-width="13" stroke-linecap="round"/>
<path d="M308 218 L372 152" stroke="#243449" stroke-width="28" stroke-linecap="round"/>
<path d="M372 152 L432 224" stroke="#243449" stroke-width="24" stroke-linecap="round"/>
<ellipse cx="450" cy="229" rx="25" ry="9" fill="#e5aa82"/>
<circle cx="112" cy="96" r="16" fill="#e7c86a"/><text x="112" y="103" text-anchor="middle" fill="#142218" font-size="20" font-family="Arial, Helvetica, sans-serif" font-weight="800">1</text>
<path d="M120 112 L136 200" stroke="#e7c86a" stroke-width="3" stroke-dasharray="5 5"/>
<text x="136" y="103" fill="#ffffff" font-size="22" font-family="Arial, Helvetica, sans-serif" font-weight="700">Yelka bo‘sh</text>
<circle cx="292" cy="96" r="16" fill="#e7c86a"/><text x="292" y="103" text-anchor="middle" fill="#142218" font-size="20" font-family="Arial, Helvetica, sans-serif" font-weight="800">2</text>
<path d="M298 111 L362 142" stroke="#e7c86a" stroke-width="3" stroke-dasharray="5 5"/>
<text x="314" y="103" fill="#ffffff" font-size="22" font-family="Arial, Helvetica, sans-serif" font-weight="700">Tizza bukilgan</text>
<circle cx="456" cy="292" r="16" fill="#e7c86a"/><text x="456" y="299" text-anchor="middle" fill="#142218" font-size="20" font-family="Arial, Helvetica, sans-serif" font-weight="800">3</text>
<path d="M452 276 L450 244" stroke="#e7c86a" stroke-width="3" stroke-dasharray="5 5"/>
<text x="432" y="299" text-anchor="end" fill="#ffffff" font-size="22" font-family="Arial, Helvetica, sans-serif" font-weight="700">Oyoq tekis</text>
<text x="40" y="299" fill="#9fb8aa" font-size="19" font-family="Arial, Helvetica, sans-serif">Qulay va bo‘sh holat</text>
</svg>
</div>
<div class="points"><div class="point"><span class="check">✓</span><span>Yoting yoki qulay holatda o‘tiring.</span></div><div class="point"><span class="check">✓</span><span>Tana va yelkalaringiz bo‘sh bo‘lsin.</span></div><div class="point"><span class="check">✓</span><span>Qorin, dumba va sonlarni keraksiz taranglashtirmang.</span></div></div>
<div class="tip"><b>Eng oson boshlanish:</b> chalqancha yoting, tizzalarni biroz buking va oyoqlarni qulay qo‘ying.</div>
</div>
<div class="page" data-page="1">
<div class="kicker"><span class="num">2</span> TO‘G‘RI MUSHAK</div><h1>Qaysi mushak ishlaydi?</h1><p class="sub">Asosiy maqsad — tos tubi mushaklarini yengil qisish. Boshqa mushaklar imkon qadar bo‘sh qoladi.</p>
<div class="illustration">
<svg viewBox="0 0 520 330" xmlns="http://www.w3.org/2000/svg" aria-label="Tos tubi mushaklari: bo‘shatish va qisish">
<rect width="520" height="330" rx="22" fill="#071b13"/>
<text x="260" y="38" text-anchor="middle" fill="#f4e4ad" font-size="24" font-family="Arial, Helvetica, sans-serif" font-weight="800">TOS TUBI — MUSHAK ‘HAMAKI’</text>
<rect x="20" y="58" width="230" height="196" rx="18" fill="#0d2a1e" stroke="#345b49" stroke-width="2"/><text x="135" y="90" text-anchor="middle" fill="#9fc7f2" font-size="24" font-family="Arial, Helvetica, sans-serif" font-weight="800">BO‘SHATING</text>
<path d="M50 112 Q50 196 135 210 Q220 196 220 112" fill="none" stroke="#8aa89a" stroke-width="8" stroke-linecap="round"/>
<path d="M52 140 Q135 222 218 140" fill="none" stroke="#ffbd52" stroke-width="11" stroke-linecap="round"/>
<text x="135" y="240" text-anchor="middle" fill="#cbd8d0" font-size="20" font-family="Arial, Helvetica, sans-serif">yengil bo‘shaydi</text>
<rect x="270" y="58" width="230" height="196" rx="18" fill="#0d2a1e" stroke="#345b49" stroke-width="2"/><text x="385" y="90" text-anchor="middle" fill="#6ee29b" font-size="24" font-family="Arial, Helvetica, sans-serif" font-weight="800">QISING</text>
<path d="M300 112 Q300 196 385 210 Q470 196 470 112" fill="none" stroke="#8aa89a" stroke-width="8" stroke-linecap="round"/>
<path d="M302 140 Q385 160 468 140" fill="none" stroke="#ffbd52" stroke-width="11" stroke-linecap="round"/>
<path d="M385 208 V172" stroke="#6ee29b" stroke-width="7" stroke-linecap="round"/>
<path d="M371 184 L385 170 L399 184" fill="none" stroke="#6ee29b" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
<text x="385" y="240" text-anchor="middle" fill="#cbd8d0" font-size="20" font-family="Arial, Helvetica, sans-serif">ichkariga + yuqoriga</text>
<rect x="30" y="270" width="460" height="46" rx="23" fill="#321818" stroke="#e96565" stroke-width="2"/>
<circle cx="62" cy="293" r="13" fill="#e96565"/>
<path d="M56 287 L68 299 M68 287 L56 299" stroke="#fff" stroke-width="3.5" stroke-linecap="round"/>
<text x="86" y="300" fill="#f6d0d0" font-size="21" font-family="Arial, Helvetica, sans-serif" font-weight="700">Qorin, dumba, son — qisilmaydi</text>
</svg>
</div>
<div class="points"><div class="point"><span class="check">✓</span><span><b>QISING:</b> mushaklarni ichkariga va yuqoriga yengil torting.</span></div><div class="point"><span class="check">✓</span><span><b>BO‘SHATING:</b> mushaklarni to‘liq bo‘shating, zo‘riqtirmang.</span></div><div class="point"><span class="cross">×</span><span>Qorin, dumba va sonlarni qattiq qisish kerak emas.</span></div></div>
<div class="tip"><b>Muhim:</b> Kegelni bajarish uchun siyish vaqtida siydik oqimini to‘xtatib mashq qilmang.</div>
</div>
<div class="page" data-page="2">
<div class="kicker"><span class="num">3</span> NAFAS VA TEXNIKA</div><h1>Qanday bajarish kerak?</h1><p class="sub">Har bir takror bir xil, sokin ritmda bajariladi. Nafasni ushlab qolmang.</p>
<div class="illustration">
<svg viewBox="0 0 520 330" xmlns="http://www.w3.org/2000/svg" aria-label="Nafas va Kegel texnikasi">
<rect width="520" height="330" rx="22" fill="#071b13"/>
<text x="260" y="40" text-anchor="middle" fill="#f4e4ad" font-size="25" font-family="Arial, Helvetica, sans-serif" font-weight="800">NAFASNI USHLAMANG</text>
<path d="M30 112 Q80 42 130 112 T230 112 T330 112 T430 112 T490 112" fill="none" stroke="#6aa5e7" stroke-width="7" stroke-linecap="round"/>
<text x="260" y="178" text-anchor="middle" fill="#bcd5ee" font-size="21" font-family="Arial, Helvetica, sans-serif" font-weight="700">nafas bir tekis davom etadi</text>
<rect x="25" y="196" width="150" height="62" rx="16" fill="#e7c86a"/>
<text x="100" y="235" text-anchor="middle" fill="#142218" font-size="23" font-family="Arial, Helvetica, sans-serif" font-weight="800">QISING</text>
<rect x="185" y="196" width="150" height="62" rx="16" fill="#1d4a36" stroke="#6ee29b" stroke-width="3"/>
<text x="260" y="235" text-anchor="middle" fill="#ffffff" font-size="20" font-family="Arial, Helvetica, sans-serif" font-weight="800">BO‘SHATING</text>
<rect x="345" y="196" width="150" height="62" rx="16" fill="#e7c86a"/>
<text x="420" y="235" text-anchor="middle" fill="#142218" font-size="23" font-family="Arial, Helvetica, sans-serif" font-weight="800">QISING</text>
<path d="M100 270 L100 278 M260 270 L260 278 M420 270 L420 278" stroke="#53645b" stroke-width="3"/>
<text x="260" y="310" text-anchor="middle" fill="#dbe9e0" font-size="21" font-family="Arial, Helvetica, sans-serif">qisish → bo‘shatish → qisish ...</text>
</svg>
</div>
<div class="points"><div class="point"><span class="check">1</span><span>Qulay nafas oling — nafasni ushlab qolmang.</span></div><div class="point"><span class="check">2</span><span>Qisish paytida faqat kerakli mushaklarni ishlating.</span></div><div class="point"><span class="check">3</span><span>Bo‘shatish vaqtida mushakni qayta taranglashtirmang.</span></div></div>
<div class="tip"><b>Og‘riq bo‘lsa:</b> mashqni to‘xtating. Kuch bilan emas, nazorat bilan bajaring.</div>
</div>
<div class="page" data-page="3">
<div class="kicker"><span class="num">4</span> BUGUNGI MASHQ</div><h1>Bugungi mashq</h1><p class="sub">Ko‘rsatmalarni ko‘rib bo‘ldingiz. Endi avtomatik taymer sizni har bir bosqichdan olib o‘tadi.</p>
<div class="illustration">
<svg viewBox="0 0 520 330" xmlns="http://www.w3.org/2000/svg" aria-label="Bugungi Kegel mashqi bosqichlari">
<rect width="520" height="330" rx="22" fill="#071b13"/>
<text x="260" y="38" text-anchor="middle" fill="#f4e4ad" font-size="24" font-family="Arial, Helvetica, sans-serif" font-weight="800">BUGUNGI MASHQ</text>
<rect x="25" y="56" width="470" height="116" rx="20" fill="#0d2a1e" stroke="#e7c86a" stroke-width="2"/>
<text x="45" y="94" fill="#ffffff" font-size="27" font-family="Arial, Helvetica, sans-serif" font-weight="800">SEKIN × 8</text>
<text x="475" y="94" text-anchor="end" fill="#cbd8d0" font-size="20" font-family="Arial, Helvetica, sans-serif">3s qisish · 3s bo‘sh</text>
<rect x="45" y="138" width="46" height="24" rx="5" fill="#e7c86a"/><rect x="91" y="138" width="46" height="24" rx="5" fill="#1d4a36" stroke="#3f7a5d"/><rect x="141" y="138" width="46" height="24" rx="5" fill="#e7c86a"/><rect x="187" y="138" width="46" height="24" rx="5" fill="#1d4a36" stroke="#3f7a5d"/><rect x="237" y="138" width="46" height="24" rx="5" fill="#e7c86a"/><rect x="283" y="138" width="46" height="24" rx="5" fill="#1d4a36" stroke="#3f7a5d"/><rect x="333" y="138" width="46" height="24" rx="5" fill="#e7c86a"/><rect x="379" y="138" width="46" height="24" rx="5" fill="#1d4a36" stroke="#3f7a5d"/>
<text x="437" y="158" fill="#cbd8d0" font-size="24" font-family="Arial, Helvetica, sans-serif" font-weight="800">...</text>
<rect x="25" y="184" width="470" height="116" rx="20" fill="#0d2a1e" stroke="#4bc477" stroke-width="2"/>
<text x="45" y="222" fill="#ffffff" font-size="27" font-family="Arial, Helvetica, sans-serif" font-weight="800">TEZ × 10</text>
<text x="475" y="222" text-anchor="end" fill="#cbd8d0" font-size="20" font-family="Arial, Helvetica, sans-serif">1s qisish · 1s bo‘sh</text>
<rect x="45" y="266" width="18" height="24" rx="5" fill="#e7c86a"/><rect x="63" y="266" width="18" height="24" rx="5" fill="#1d4a36" stroke="#3f7a5d"/><rect x="85" y="266" width="18" height="24" rx="5" fill="#e7c86a"/><rect x="103" y="266" width="18" height="24" rx="5" fill="#1d4a36" stroke="#3f7a5d"/><rect x="125" y="266" width="18" height="24" rx="5" fill="#e7c86a"/><rect x="143" y="266" width="18" height="24" rx="5" fill="#1d4a36" stroke="#3f7a5d"/><rect x="165" y="266" width="18" height="24" rx="5" fill="#e7c86a"/><rect x="183" y="266" width="18" height="24" rx="5" fill="#1d4a36" stroke="#3f7a5d"/><rect x="205" y="266" width="18" height="24" rx="5" fill="#e7c86a"/><rect x="223" y="266" width="18" height="24" rx="5" fill="#1d4a36" stroke="#3f7a5d"/><rect x="245" y="266" width="18" height="24" rx="5" fill="#e7c86a"/><rect x="263" y="266" width="18" height="24" rx="5" fill="#1d4a36" stroke="#3f7a5d"/><rect x="285" y="266" width="18" height="24" rx="5" fill="#e7c86a"/><rect x="303" y="266" width="18" height="24" rx="5" fill="#1d4a36" stroke="#3f7a5d"/><rect x="325" y="266" width="18" height="24" rx="5" fill="#e7c86a"/><rect x="343" y="266" width="18" height="24" rx="5" fill="#1d4a36" stroke="#3f7a5d"/><rect x="365" y="266" width="18" height="24" rx="5" fill="#e7c86a"/><rect x="383" y="266" width="18" height="24" rx="5" fill="#1d4a36" stroke="#3f7a5d"/><rect x="405" y="266" width="18" height="24" rx="5" fill="#e7c86a"/><rect x="423" y="266" width="18" height="24" rx="5" fill="#1d4a36" stroke="#3f7a5d"/>
<rect x="150" y="312" width="14" height="14" rx="3" fill="#e7c86a"/>
<text x="172" y="324" fill="#dbe9e0" font-size="18" font-family="Arial, Helvetica, sans-serif">qisish</text>
<rect x="268" y="312" width="14" height="14" rx="3" fill="#1d4a36" stroke="#3f7a5d"/>
<text x="290" y="324" fill="#dbe9e0" font-size="18" font-family="Arial, Helvetica, sans-serif">bo‘shatish</text>
</svg>
</div>
<div class="routine"><div class="routineCard"><div class="routineIcon">◷</div><div><b>8 marta sekin Kegel</b><span>3 soniya QISING → 3 soniya BO‘SHATING</span></div></div><div class="routineCard"><div class="routineIcon">⚡</div><div><b>10 marta tez Kegel</b><span>1 soniya QISING → 1 soniya BO‘SHATING</span></div></div></div>
<div class="tip"><b>Tayyor bo‘lsangiz</b>, pastdagi tugmani bosing. Keyin mashq avtomatik boshlanadi.</div>
</div>
<div class="dots"><span class="dot on"></span><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>
<div class="nav"><button id="prev" class="btn prev" disabled>← Oldingi</button><button id="next" class="btn next">Keyingi →</button></div>
<button id="startGuide" class="btn next start" style="display:none">▶ TAYYOR BO‘LDIM — MASHQNI BOSHLASH</button>
</section>
</main>

<main id="workout" class="wrap">
<div class="workoutCard"><div id="phase">TAYYORLANING</div><div id="count" class="count">5</div><div id="block" class="meta">Kegel Coach</div><div class="row"><span id="set">Podxod -</span><span id="rep">Takror -</span></div><div class="progress"><div id="bar" class="bar"></div></div><div class="row"><span id="remaining">Qolgan vaqt: -</span><span id="total">Jami: -</span></div></div>
<button id="pause" class="btn pause">PAUZA</button><div id="msg" class="workoutCard small">Mashqga tayyorlaning...</div>
</main>
<script>
(function(){"use strict";
const tg=window.Telegram&&window.Telegram.WebApp?window.Telegram.WebApp:null;if(tg){tg.ready();tg.expand();}
const guideApp=document.getElementById("guideApp"),workout=document.getElementById("workout"),pages=[...document.querySelectorAll(".page")],dots=[...document.querySelectorAll(".dot")],prev=document.getElementById("prev"),next=document.getElementById("next"),startGuide=document.getElementById("startGuide");
const homeApp=document.getElementById("homeApp"),homeDay=document.getElementById("homeDay"),homeTitle=document.getElementById("homeTitle"),homeSub=document.getElementById("homeSub"),slotsEl=document.getElementById("slots"),homeNote=document.getElementById("homeNote"),homeProg=document.getElementById("homeProg"),planBtn=document.getElementById("planBtn"),freeBtn=document.getElementById("freeBtn"),guideBtn=document.getElementById("guideBtn"),toHome=document.getElementById("toHome");
let page=0,mode="plan",status=null,finished=false;
function showPage(n){page=Math.max(0,Math.min(pages.length-1,n));pages.forEach((p,i)=>p.classList.toggle("active",i===page));dots.forEach((d,i)=>d.classList.toggle("on",i===page));prev.disabled=page===0;next.style.display=page===pages.length-1?"none":"block";startGuide.style.display=page===pages.length-1?"block":"none";}
prev.addEventListener("click",()=>showPage(page-1));next.addEventListener("click",()=>showPage(page+1));
function api(path,body){return fetch(path,{method:"POST",headers:{"content-type":"application/json","X-Telegram-Init-Data":tg?tg.initData:""},body:JSON.stringify(body||{})}).then(r=>r.json().then(j=>{if(!r.ok||!j.ok)throw new Error(j.error||"Xatolik");return j;}));}
const phaseEl=document.getElementById("phase"),countEl=document.getElementById("count"),blockEl=document.getElementById("block"),setEl=document.getElementById("set"),repEl=document.getElementById("rep"),barEl=document.getElementById("bar"),remainingEl=document.getElementById("remaining"),totalEl=document.getElementById("total"),pauseBtn=document.getElementById("pause"),msg=document.getElementById("msg");
let data=null,index=0,segmentStart=0,elapsedBefore=0,paused=false,pauseStarted=0,lastPhase="",raf=0,wakeLock=null;
function beep(){try{const AC=window.AudioContext||window.webkitAudioContext;if(!AC)return;const c=new AC(),o=c.createOscillator(),g=c.createGain();o.frequency.value=880;g.gain.value=.035;o.connect(g);g.connect(c.destination);o.start();o.stop(c.currentTime+.09);}catch(e){}}
function haptic(){try{if(tg&&tg.HapticFeedback)tg.HapticFeedback.impactOccurred("light");if(navigator.vibrate)navigator.vibrate(80);}catch(e){}}
function phaseInfo(type){if(type==="s")return["QISING!","#b3261e"];if(type==="r")return["BO'SHATING","#238b45"];if(type==="b")return["DAM OLING","#2475c8"];return["TAYYORLANING","#666666"];}
function render(now){if(!data)return;const seg=data.segments[index],info=phaseInfo(seg.type);if(info[0]!==lastPhase){beep();haptic();lastPhase=info[0];}workout.style.background=info[1];phaseEl.textContent=info[0];const elapsed=(now-segmentStart)/1000,left=Math.max(0,seg.seconds-elapsed);countEl.textContent=Math.ceil(left);blockEl.textContent=seg.blockName;if(seg.type==="p"){setEl.textContent="Tayyorlanish";repEl.textContent="";}else if(seg.type==="b"){setEl.textContent="Dam";repEl.textContent="Podxod "+seg.setNo+"/"+seg.setsTotal;}else{setEl.textContent="Podxod "+seg.setNo+"/"+seg.setsTotal;repEl.textContent="Takror "+seg.repNo+"/"+seg.repsTotal;}barEl.style.width=Math.min(100,elapsed/seg.seconds*100)+"%";remainingEl.textContent="Qolgan vaqt: "+Math.max(0,Math.ceil(data.total-elapsedBefore-elapsed))+"s";totalEl.textContent="Jami: "+data.total+"s";}
function finish(){cancelAnimationFrame(raf);pauseBtn.disabled=true;msg.textContent="Yakunlanmoqda...";api("/api/complete",{token:data.token}).then(r=>{msg.textContent="Mashq tugadi. "+r.progress;finished=true;pauseBtn.disabled=false;pauseBtn.textContent="BOSH SAHIFAGA QAYTISH";}).catch(e=>{msg.textContent=e.message;pauseBtn.disabled=false;});}
function tick(now){if(!paused){render(now);const seg=data.segments[index];if(now-segmentStart>=seg.seconds*1000){elapsedBefore+=seg.seconds;index++;if(index>=data.segments.length){finish();return;}segmentStart=now;}}raf=requestAnimationFrame(tick);}
function startWorkout(m){m=m||mode;if(!tg||!tg.initData){msg.textContent="Telegram Mini App ichida oching.";return;}homeApp.style.display="none";guideApp.style.display="none";workout.style.display="flex";api("/api/start",{mode:m}).then(r=>{data=r;index=0;elapsedBefore=0;segmentStart=performance.now();msg.textContent="Mashq boshlandi.";if(navigator.wakeLock&&navigator.wakeLock.request)navigator.wakeLock.request("screen").then(l=>wakeLock=l).catch(()=>{});raf=requestAnimationFrame(tick);}).catch(e=>{msg.textContent=e.message;finished=true;pauseBtn.disabled=false;pauseBtn.textContent="ORQAGA";workout.style.background="#666";});}
startGuide.addEventListener("click",function(){startWorkout(mode);});
pauseBtn.addEventListener("click",function(){if(finished){location.reload();return;}if(!data)return;if(!paused){paused=true;pauseStarted=performance.now();pauseBtn.textContent="DAVOM ETISH";msg.textContent="Pauza.";}else{const now=performance.now();segmentStart+=now-pauseStarted;paused=false;pauseBtn.textContent="PAUZA";msg.textContent="Mashq davom etdi.";}});
function showHome(){workout.style.display="none";guideApp.style.display="none";homeApp.style.display="flex";loadStatus();}
function loadStatus(){
if(!tg||!tg.initData){homeTitle.textContent="Telegram ichida oching";homeNote.textContent="Bu sahifa faqat Telegram Mini App sifatida ishlaydi.";planBtn.disabled=true;freeBtn.disabled=true;return;}
api("/api/status").then(r=>{status=r;homeDay.textContent=r.day+"-kun · seriya "+r.streak;
homeTitle.textContent=r.scheduleOk&&r.started?(r.allDone?"Bugungi reja bajarildi":"Bugun: "+r.done+"/"+r.total+" mashg‘ulot"):"Xush kelibsiz";
homeSub.textContent=r.scheduleOk&&r.started?"Mashg‘ulotlarni kun davomida istalgan vaqtda bajaring.":"";
slotsEl.innerHTML="";for(let i=0;i<r.total;i++){const d=document.createElement("div");d.className="slot"+(i<r.done?" done":(i===r.done&&!r.allDone&&r.planAvailable?" next":""));d.textContent=i<r.done?"✓":String(i+1);slotsEl.appendChild(d);}
homeNote.textContent=r.note;homeProg.textContent=r.program?("Bugungi dastur:\\n"+r.program):"";
planBtn.disabled=!r.planAvailable;planBtn.textContent=r.planAvailable?"▶ "+(r.done+1)+"-MASHG‘ULOTNI BOSHLASH":(r.allDone?"REJA BAJARILDI ✓":"REJA HOZIR MAVJUD EMAS");
freeBtn.disabled=false;}).catch(e=>{homeTitle.textContent="Xatolik";homeNote.textContent=e.message;planBtn.disabled=true;freeBtn.disabled=true;});}
planBtn.addEventListener("click",function(){mode="plan";startWorkout("plan");});
freeBtn.addEventListener("click",function(){mode="free";startWorkout("free");});
guideBtn.addEventListener("click",function(){mode=(status&&status.planAvailable)?"plan":"free";homeApp.style.display="none";guideApp.style.display="flex";showPage(0);});
toHome.addEventListener("click",showHome);
showPage(0);showHome();
})();
</script>
</body>
</html>`;

export default {
  async fetch(request, env) { return handleFetch(request, env); },
  async scheduled(controller, env) { return handleScheduled(controller, env); }
};
