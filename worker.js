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
  const done = completedCountForDay(user, user.day, date);
  const isTrainingDay = user.schedule.days.includes(weekday);

  const status = isTrainingDay
    ? `Bugun mashq kuni.\nBajarilgan: ${done}/${user.schedule.times.length} ta mashg\u2018ulot.`
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
    `<b>Statistikam</b>\n\nJoriy kun: <b>${user.day}/30</b>\nStreak: <b>${user.streak}</b>\nBajarilgan mashg\u2018ulotlar: <b>${completed}</b>\nMashq qilingan sanalar: <b>${uniqueDays}</b>`,
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
        `<b>Eslatma</b>\n\n${user.day}-kun, ${sessionNumber}-mashg\u2018ulot vaqti keldi.`,
        env,
        keyboard
      );

      await env.KEGEL_KV.put(sentKey, "1", { expirationTtl: SENT_TTL });
    } catch (error) {
      console.error("Reminder error:", id, error);
    }
  }
}

async function apiStart(request, env) {
  const auth = await authenticateInitData(request, env);

  if (!auth.ok) return jsonResponse({ ok: false, error: auth.error }, 401);

  const user = await loadUser(String(auth.user.id), env);

  if (!user) {
    return jsonResponse({
      ok: false,
      error: "Foydalanuvchi topilmadi. Telegram botda /start bosing."
    }, 400);
  }

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

  const now = new Date();
  const local = getLocalParts(now);

  if (!user.schedule.days.includes(local.weekday)) {
    return jsonResponse({ ok: false, error: "BUGUN MASHQ KUNI EMAS." }, 400);
  }

  if (user.day > 30) {
    return jsonResponse({ ok: false, error: "Dastur yakunlangan." }, 400);
  }

  if (allDaySessionsCompleted(user, user.day, local.date)) {
    return jsonResponse({
      ok: false,
      error: "BUGUNGI MASHG\u2018ULOTLAR TUGAGAN."
    }, 400);
  }

  const sessionNumber =
    completedCountForDay(user, user.day, local.date) + 1;

  if (sessionNumber > user.schedule.times.length) {
    return jsonResponse({
      ok: false,
      error: "BUGUNGI MASHG\u2018ULOTLAR TUGAGAN."
    }, 400);
  }

  const scheduledTime = user.schedule.times[sessionNumber - 1];
  const currentMinutes = localMinutes(now);
  const scheduledMinutes = parseTimeMinutes(scheduledTime);

  if (currentMinutes < scheduledMinutes - EARLY_MINUTES) {
    return jsonResponse({
      ok: false,
      error: `HALI VAQT BO\u2018LMADI. ${scheduledTime} dan ${EARLY_MINUTES} daqiqa oldin boshlash mumkin.`
    }, 400);
  }

  const config = getProgramDay(user.day);
  const segments = buildSegments(config);
  const total = segments.reduce((sum, segment) => sum + segment.seconds, 0);
  const startedAt = Date.now();

  const tokenData =
    `${user.id}|${user.day}|${sessionNumber}|${local.date}|${startedAt}|${total}`;

  const token = await hmacHex(
    `kegel-session:${env.BOT_TOKEN}`,
    tokenData
  );

  await env.KEGEL_KV.put(
    `session:${token}`,
    JSON.stringify({
      id: user.id,
      day: user.day,
      session: sessionNumber,
      date: local.date,
      startedAt,
      total
    }),
    { expirationTtl: SESSION_TTL }
  );

  return jsonResponse({
    ok: true,
    day: user.day,
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
    `${session.id}|${session.day}|${session.session}|${session.date}|${session.startedAt}|${session.total}`
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

  if (!user || !user.started) {
    return jsonResponse({ ok: false, error: "Foydalanuvchi faol emas." }, 400);
  }

  const now = new Date();
  const local = getLocalParts(now);

  if (local.date !== session.date) {
    return jsonResponse({ ok: false, error: "Session sanasi o\u2018zgargan." }, 400);
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
:root{font-family:Arial,sans-serif;color:#fff;background:#666}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:#666;display:flex;align-items:center;justify-content:center}
.wrap{width:min(100%,520px);min-height:100vh;padding:24px 18px 30px;display:flex;flex-direction:column;justify-content:center;gap:16px;transition:background .15s}
.card{background:rgba(0,0,0,.18);border-radius:24px;padding:22px;text-align:center;box-shadow:0 12px 35px rgba(0,0,0,.2)}
#phase{font-size:28px;font-weight:800;margin-bottom:10px}
.count{font-size:110px;line-height:1;font-weight:800}
.meta{font-size:18px;margin:8px 0}
.progress{height:12px;border-radius:20px;background:rgba(255,255,255,.3);overflow:hidden}
.bar{height:100%;width:0;background:#fff}
.row{display:flex;justify-content:space-between;font-size:15px;margin-top:10px}
.btn{border:0;border-radius:16px;padding:15px 20px;font-size:18px;font-weight:700;background:#fff;color:#222;width:100%}
.btn:disabled{opacity:.5}
.pause{background:rgba(255,255,255,.18);color:#fff;border:1px solid rgba(255,255,255,.4)}
.small{opacity:.9;font-size:14px}
</style>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
</head>
<body>
<main id="app" class="wrap">
<div class="card">
<div id="phase">TAYYORLANING</div>
<div id="count" class="count">5</div>
<div id="block" class="meta">Kegel Coach</div>
<div class="row"><span id="set">Podxod -</span><span id="rep">Takror -</span></div>
<div class="progress"><div id="bar" class="bar"></div></div>
<div class="row"><span id="remaining">Qolgan vaqt: -</span><span id="total">Jami: -</span></div>
</div>
<button id="pause" class="btn pause">PAUZA</button>
<div id="msg" class="card small">Telegram orqali yuklanmoqda...</div>
</main>
<script>
(function(){
"use strict";
const tg=window.Telegram&&window.Telegram.WebApp?window.Telegram.WebApp:null;
if(tg){tg.ready();tg.expand();}
const app=document.getElementById("app");
const phaseEl=document.getElementById("phase");
const countEl=document.getElementById("count");
const blockEl=document.getElementById("block");
const setEl=document.getElementById("set");
const repEl=document.getElementById("rep");
const barEl=document.getElementById("bar");
const remainingEl=document.getElementById("remaining");
const totalEl=document.getElementById("total");
const pauseBtn=document.getElementById("pause");
const msg=document.getElementById("msg");
const initData=tg?tg.initData:"";
let data=null,index=0,segmentStart=0,elapsedBefore=0,paused=false,pauseStarted=0,lastPhase="",raf=0,wakeLock=null;

function api(path,body){
return fetch(path,{method:"POST",headers:{"content-type":"application/json","X-Telegram-Init-Data":initData},body:JSON.stringify(body||{})}).then(function(response){
return response.json().then(function(json){
if(!response.ok||!json.ok)throw new Error(json.error||"Xatolik");
return json;
});
});
}

function beep(){
try{
const AudioContext=window.AudioContext||window.webkitAudioContext;
if(!AudioContext)return;
const context=new AudioContext();
const oscillator=context.createOscillator();
const gain=context.createGain();
oscillator.frequency.value=880;
gain.gain.value=.035;
oscillator.connect(gain);
gain.connect(context.destination);
oscillator.start();
oscillator.stop(context.currentTime+.09);
}catch(error){}
}

function haptic(){
try{
if(tg&&tg.HapticFeedback)tg.HapticFeedback.impactOccurred("light");
if(navigator.vibrate)navigator.vibrate(80);
}catch(error){}
}

function phaseInfo(type){
if(type==="s")return["QISING!","#b3261e"];
if(type==="r")return["BO'SHATING","#238b45"];
if(type==="b")return["DAM OLING","#2475c8"];
return["TAYYORLANING","#666666"];
}

function render(now){
if(!data)return;
const segment=data.segments[index];
const info=phaseInfo(segment.type);
if(info[0]!==lastPhase){beep();haptic();lastPhase=info[0];}
app.style.background=info[1];
phaseEl.textContent=info[0];
const elapsed=(now-segmentStart)/1000;
const left=Math.max(0,segment.seconds-elapsed);
countEl.textContent=Math.ceil(left);
blockEl.textContent=segment.blockName;
if(segment.type==="p"){setEl.textContent="Tayyorlanish";repEl.textContent="";}
else if(segment.type==="b"){setEl.textContent="Dam";repEl.textContent="Podxod "+segment.setNo+"/"+segment.setsTotal;}
else{setEl.textContent="Podxod "+segment.setNo+"/"+segment.setsTotal;repEl.textContent="Takror "+segment.repNo+"/"+segment.repsTotal;}
barEl.style.width=Math.min(100,(elapsed/segment.seconds)*100)+"%";
const totalRemaining=data.total-elapsedBefore-elapsed;
remainingEl.textContent="Qolgan vaqt: "+Math.max(0,Math.ceil(totalRemaining))+"s";
totalEl.textContent="Jami: "+data.total+"s";
}

function finish(){
cancelAnimationFrame(raf);
pauseBtn.disabled=true;
msg.textContent="Yakunlanmoqda...";
api("/api/complete",{token:data.token}).then(function(result){
msg.textContent="Mashq tugadi. "+result.progress;
pauseBtn.textContent="TUGADI";
}).catch(function(error){
msg.textContent=error.message;
pauseBtn.disabled=false;
});
}

function tick(now){
if(!paused){
render(now);
const segment=data.segments[index];
if(now-segmentStart>=segment.seconds*1000){
elapsedBefore+=segment.seconds;
index++;
if(index>=data.segments.length){finish();return;}
segmentStart=now;
}
}
raf=requestAnimationFrame(tick);
}

function start(){
if(!initData){
msg.textContent="Telegram Mini App ichida oching.";
pauseBtn.disabled=true;
return;
}
api("/api/start").then(function(result){
data=result;index=0;elapsedBefore=0;segmentStart=performance.now();
msg.textContent="Mashq boshlandi.";
if(navigator.wakeLock&&navigator.wakeLock.request){
navigator.wakeLock.request("screen").then(function(lock){wakeLock=lock;}).catch(function(){});
}
raf=requestAnimationFrame(tick);
}).catch(function(error){
msg.textContent=error.message;
pauseBtn.disabled=true;
app.style.background="#666666";
});
}

pauseBtn.addEventListener("click",function(){
if(!data)return;
if(!paused){
paused=true;
pauseStarted=performance.now();
pauseBtn.textContent="DAVOM ETISH";
msg.textContent="Pauza.";
}else{
const now=performance.now();
const pauseDuration=now-pauseStarted;
paused=false;
segmentStart+=pauseDuration;
pauseBtn.textContent="PAUZA";
msg.textContent="Mashq davom etdi.";
}
});
start();
})();
</script>
</body>
</html>`;

export default {
  fetch: handleFetch,
  scheduled: handleScheduled
};
