# Kegel Coach

Telegram uchun Kegel Coach bot.

## 1. GitHub

Repository ichiga `worker.js`, `wrangler.jsonc`, `README_UZ.md` va `.gitignore` fayllarini joylang.

## 2. BotFather

Telegramda `@BotFather` orqali `/newbot` bilan bot yarating va token oling. Tokenni GitHub kodiga yozmang.

## 3. Cloudflare KV

Cloudflare Dashboard → Workers & Pages → KV → Create namespace.

`wrangler.jsonc` ichidagi `SHU_YERGA_KV_ID_NI_YOZING` o‘rniga haqiqiy KV Namespace ID yozing.

Agar Cloudflare Dashboard orqali binding qo‘ysangiz, binding nomi aynan `KEGEL_KV` bo‘lishi kerak.

## 4. Cloudflare Workers Builds

GitHub repositoryni Cloudflare Workers & Pages bilan ulang. Main entry point `worker.js` bo‘ladi va deploy qiling.

## 5. BOT_TOKEN

Worker → Settings → Variables and Secrets → Add → Secret.

Name:

`BOT_TOKEN`

Value: BotFather tokeni.

## 6. Cron

`wrangler.jsonc` ichida `* * * * *` bor. Bu reminderlarni har daqiqada tekshiradi.

## 7. Webhook

Deploydan keyin Worker URL'ni brauzerda quyidagicha oching:

`https://YOUR-WORKER.workers.dev/set-webhook`

Bu webhookni avtomatik:

`https://YOUR-WORKER.workers.dev/webhook`

ga o‘rnatadi va Mini App originini KV'ga saqlaydi.

## 8. Telegram

Botga `/start` yuboring. Jadvalni sozlang:

- 3-5 ta hafta kuni
- 2-5 ta mashg‘ulot
- aniq vaqtlar, masalan `07:30 12:00 18:30`

Keyin `BOSHLASH` ni bosing.

Mini App mashg‘ulotni avtomatik boshlaydi.
