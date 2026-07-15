"""
Telegram forwarding for support reports.

Sends each /api/support submission to a Telegram chat: the message text, then
the screenshot and the document as attachments. Configured via env (loaded
from server/.env):

  TELEGRAM_BOT_TOKEN   the bot token
  TELEGRAM_CHAT_ID     where to deliver (optional — auto-resolved from the most
                       recent chat that has messaged the bot, then cached)

Best-effort: if the bot isn't configured or Telegram is unreachable, support
submissions still succeed; only the forwarding is skipped.
"""
from __future__ import annotations

import os
from pathlib import Path

import httpx

_resolved_chat: str | None = None


def available() -> bool:
    return bool(os.environ.get("TELEGRAM_BOT_TOKEN"))


async def _chat_id(client: httpx.AsyncClient, token: str) -> str | None:
    """Configured chat id, or the most recent chat that messaged the bot."""
    global _resolved_chat
    cid = os.environ.get("TELEGRAM_CHAT_ID", "").strip()
    if cid:
        return cid
    if _resolved_chat:
        return _resolved_chat
    try:
        r = await client.get(f"https://api.telegram.org/bot{token}/getUpdates")
        for u in reversed(r.json().get("result", [])):
            chat = ((u.get("message") or u.get("edited_message")
                     or u.get("my_chat_member") or {}).get("chat") or {})
            if chat.get("id") is not None:
                _resolved_chat = str(chat["id"])
                return _resolved_chat
    except Exception:
        pass
    return None


async def send_support(ticket: str, text: str,
                       screenshot: Path | None = None, document: Path | None = None) -> None:
    token = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
    if not token:
        return
    api = f"https://api.telegram.org/bot{token}"
    try:
        async with httpx.AsyncClient(timeout=25) as client:
            chat = await _chat_id(client, token)
            if not chat:
                return
            await client.post(f"{api}/sendMessage",
                              data={"chat_id": chat, "text": f"🆘 Support · {ticket}\n\n{text}"[:4096]})
            for path, method, field in ((screenshot, "sendPhoto", "photo"),
                                        (document, "sendDocument", "document")):
                if path and path.exists():
                    await client.post(f"{api}/{method}", data={"chat_id": chat},
                                      files={field: (path.name, path.read_bytes())})
    except Exception:
        pass                                              # forwarding is best-effort
