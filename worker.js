export default {
  async fetch(request, env, ctx) {
    // سریع جواب برای متدهای غیر POST
    if (request.method !== "POST") return new Response("ok")

    // بررسی secret (اختیاری)
    const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token")
    if (env.SECRET_TOKEN && secret !== env.SECRET_TOKEN) {
      console.warn("Forbidden: secret mismatch")
      return new Response("forbidden", { status: 403 })
    }

    // پایهٔ API تلگرام (نیاز به BOT_TOKEN)
    const apiBase = `https://api.telegram.org/bot${env.BOT_TOKEN}`

    // helper برای فراخوانی API تلگرام
    const tgFetch = (path, body) =>
      fetch(`${apiBase}/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      }).catch((e) => {
        // خود fetch خطا می‌زند؛ لاگ می‌کنیم اما خطا را پروپاگیت نمی‌کنیم
        console.error("tgFetch error:", e)
      })

    // تابع لاگ داخلی: هم console.log و هم (در صورت تنظیم) ارسال به یک چت لاگ تلگرامی
    const sendLog = (level, ...parts) => {
      try {
        const time = new Date().toISOString()
        const msg = `[${level}] ${time} ${parts.map(p => (typeof p === "string" ? p : JSON.stringify(p))).join(" ")}`
        // لاگ در console (Cloudflare Logs)
        if (level === "error") console.error(msg); else console.log(msg)

        // ارسال لاگ به یک چت تلگرامی در صورت تنظیم LOG_CHAT_ID
        if (env.LOG_CHAT_ID) {
          // از ctx.waitUntil استفاده می‌کنیم تا لاگ فرستادن در پس‌زمینه انجام شود
          ctx.waitUntil(tgFetch("sendMessage", { chat_id: env.LOG_CHAT_ID, text: msg }))
        }
      } catch (e) {
        console.error("sendLog failed:", e)
      }
    }

    let update
    try {
      update = await request.json()
    } catch (err) {
      sendLog("error", "Invalid JSON body", err.toString())
      return new Response("ok")
    }

    sendLog("info", "Received update", { type: update && (update.message ? "message" : update.callback_query ? "callback_query" : "other") })

    try {
      // پردازش پیام متنی
      if (update.message) {
        const message = update.message
        const chatId = message.chat.id
        const text = message.text || ""

        sendLog("info", "Message", { chatId, text: text && text.slice(0, 300) })

        if (text === "/start") {
          const reply = "سلام 👋 ربات آماده‌ست!"
          const body = {
            chat_id: chatId,
            text: reply,
            reply_markup: {
              inline_keyboard: [
                [{ text: "پینگ 🛰️", callback_data: "ping" }],
                [{ text: "آخرین پیام من", callback_data: "last_message" }]
              ]
            }
          }
          ctx.waitUntil(tgFetch("sendMessage", body))
          sendLog("info", "/start handled", { chatId })
        } else if (text === "/help") {
          const reply = "دستورات:\n/start\n/help"
          ctx.waitUntil(tgFetch("sendMessage", { chat_id: chatId, text: reply }))
          sendLog("info", "/help handled", { chatId })
        } else {
          const reply = `گفتی: ${text}`
          ctx.waitUntil(tgFetch("sendMessage", { chat_id: chatId, text: reply }))
          sendLog("info", "Echoed message", { chatId })
        }

        // ذخیرهٔ آخرین پیام در KV اگر موجود است
        if (env.SESSIONS) {
          try {
            ctx.waitUntil(env.SESSIONS.put(String(chatId), text || "", { expirationTtl: 60 * 60 * 24 * 7 }))
          } catch (e) {
            // لاگ خطای KV ولی اجازه می‌دهیم پاسخ به کاربر بیاید
            sendLog("error", "KV put failed", e.toString())
          }
        }

        return new Response("ok")
      }

      // پردازش callback_query
      if (update.callback_query) {
        const cq = update.callback_query
        const data = cq.data
        const chatId = cq.message && cq.message.chat && cq.message.chat.id
        const messageId = cq.message && cq.message.message_id

        sendLog("info", "Callback query", { from: cq.from && cq.from.id, data })

        // حتما answerCallbackQuery بفرست تا spinner در کلاینت حذف شود
        ctx.waitUntil(tgFetch("answerCallbackQuery", { callback_query_id: cq.id }))

        if (data === "ping") {
          if (chatId && messageId) {
            ctx.waitUntil(
              tgFetch("editMessageText", {
                chat_id: chatId,
                message_id: messageId,
                text: "Pong! 🏓"
              })
            )
            sendLog("info", "Handled ping via editMessageText", { chatId, messageId })
          } else if (cq.from && cq.from.id) {
            ctx.waitUntil(tgFetch("sendMessage", { chat_id: cq.from.id, text: "Pong! 🏓" }))
            sendLog("info", "Handled ping via sendMessage to user", { user: cq.from.id })
          }
        } else if (data === "last_message") {
          if (env.SESSIONS && chatId) {
            ctx.waitUntil(
              (async () => {
                try {
                  const last = await env.SESSIONS.get(String(chatId))
                  const text = last ? `آخرین پیام شما: ${last}` : "هیچ پیامی ذخیره نشده."
                  await tgFetch("sendMessage", { chat_id: chatId, text })
                } catch (e) {
                  sendLog("error", "KV get failed in last_message", e.toString())
                  await tgFetch("sendMessage", { chat_id: chatId, text: "خطا در خواندن آخرین پیام." })
                }
              })()
            )
            sendLog("info", "Handled last_message", { chatId })
          } else if (chatId) {
            ctx.waitUntil(tgFetch("sendMessage", { chat_id: chatId, text: "سیستم ذخیره‌سازی فعال نیست." }))
            sendLog("info", "No KV for last_message", { chatId })
          }
        }

        return new Response("ok")
      }

      // سایر انواع آپدیت را نادیده می‌گیریم
      sendLog("info", "Unhandled update type")
      return new Response("ok")
    } catch (err) {
      // هر خطای غیرمنتظره را لاگ و (اختیاری) به چت لاگ می‌فرستیم
      sendLog("error", "Unhandled exception", err && err.stack ? err.stack : err.toString())
      return new Response("ok")
    }
  }
}
