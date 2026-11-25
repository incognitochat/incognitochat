#!/usr/bin/env python3
"""Checks that the ways the bot opens the app point at the official address.

Whoever controls the bot in BotFather picks the page Telegram opens
(docs/security.md, "A swapped page inside Telegram"). verify-site.sh checks
what the app's address serves; this checks that Telegram opens that address,
as one Telegram account sees it (docs/verifying.md):

  main     the bot's Main Mini App, which t.me/<bot>?startapp links open.
           Required.
  menu     the bot's menu button. Required.
  welcome  the app buttons in the bot's replies to /start (skipped with
           --no-start).

Each must open <app origin>/ exactly. The menu button and the /start
buttons are the bot's own addresses, so they must be exactly <app origin>/.
The Main Mini App's address comes back from Telegram with its launch
parameters added in the fragment, so it may carry Telegram's tgWebApp...
keys, each once, but no query, no start parameter (the script asks for
none), and nothing else. The page is never loaded, and only an address's
origin and path, and the names of unexpected parameters, are printed: the
fragment Telegram adds holds this account's signed launch data, a login to
the app's server for a while.

  scripts/verify-bot.py <bot username> <app origin> [--no-start] [--summary FILE]
  scripts/verify-bot.py <bot> https://<org>.github.io
  scripts/verify-bot.py --make-session

Logs in as a Telegram user (bots can't ask for these). Needs TG_API_ID and
TG_API_HASH, an app's credentials from https://my.telegram.org, and either
TG_SESSION (a session string from --make-session, for runs without anyone
typing) or an interactive login in a terminal: your phone number, the code
Telegram sends you, and your password if you set one. An interactive login
is kept in memory and logged out at the end.

Needs Python 3.11 or later and the packages in
scripts/verify-bot.requirements.txt (install steps in docs/verifying.md).

Exit codes: 0 verified, 1 verification failed (even if another check
couldn't run), 2 couldn't run or couldn't finish (usage, login, network,
Telegram limits).
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import datetime
import json
import logging
import os
import re
import sys
from dataclasses import dataclass, field
from typing import Protocol
from urllib.parse import parse_qsl, urlsplit

EXIT_VERIFIED, EXIT_FAILED, EXIT_ERROR = 0, 1, 2
CHECKS = ("bot", "main", "menu", "welcome")
# What Telegram calls the device in the account's list of sessions.
DEVICE = "Incognito Chat bot check"


class CouldNotRun(Exception):
    """The check couldn't run (login, network, Telegram limits): exit 2."""


# --- Addresses ---------------------------------------------------------------


def expected_origin(origin: str) -> tuple[str, str]:
    """The scheme and host an origin names: "https://host", nothing more."""
    parts = urlsplit(origin)
    if (
        parts.scheme != "https"
        or not parts.netloc
        or parts.netloc != parts.netloc.lower()
        or not re.fullmatch(r"[a-z0-9.-]+", parts.netloc)
        or parts.path not in ("", "/")
        or parts.query
        or parts.fragment
    ):
        raise ValueError(f"the app origin must be https://<lowercase host>, not {origin!r}")
    return parts.scheme, parts.netloc


def shown(url: str) -> str:
    """An address's origin and path only, for printing: never its query or
    fragment, which may hold a login. At most 200 characters."""
    try:
        parts = urlsplit(url)
        host = parts.netloc.rsplit("@", 1)[-1]
        text = f"{parts.scheme}://{host}{parts.path}" if parts.scheme else "(not an address)"
    except ValueError:
        text = "(not an address)"
    text = "".join(c if c.isprintable() and c.isascii() else "?" for c in text)
    return text if len(text) <= 200 else text[:197] + "..."


def same_place(url: str, scheme: str, host: str, empty_path: bool = False) -> bool:
    """Whether url opens <scheme>://<host>/ exactly: no user, no port, path
    "/" (or none, with empty_path: browsers read https://host as
    https://host/; for an address typed in BotFather)."""
    try:
        parts = urlsplit(url)
    except ValueError:
        return False
    return parts.scheme == scheme and parts.netloc == host and (parts.path == "/" or (empty_path and parts.path == ""))


def _name(key: str) -> str:
    """A parameter's name for printing; anything not shaped like a name
    (it could be a value) as a placeholder."""
    return key if re.fullmatch(r"[A-Za-z0-9_-]{1,40}", key) else "(unnamed)"


def added_parameters(url: str, telegram_adds: bool) -> list[str]:
    """What an address carries that Telegram doesn't add, by name. The app
    acts on some parameters (a start parameter, #save=, a second copy of a
    launch parameter, which it reads first), so a planted one changes what
    it does.

    telegram_adds: the address came back from Telegram, which adds its
    launch parameters in the fragment (tgWebApp... keys, each once). Without
    it (a button's address, as the bot set it), any query or fragment is
    planted. Either way, no query: the script asks for no start parameter,
    and Telegram adds no query without one."""
    try:
        parts = urlsplit(url)
    except ValueError:
        return []
    names = ["?" + _name(k) for k, _ in parse_qsl(parts.query, keep_blank_values=True)]
    if parts.query and not names:
        names.append("?")
    if not telegram_adds:
        names += ["#" + _name(k) for k, _ in parse_qsl(parts.fragment, keep_blank_values=True)]
        if not names and ("?" in url or "#" in url):
            names.append("an empty ? or #")
        return names
    if "#" in parts.fragment:
        names.append("a second #")
    seen: set[str] = set()
    for k, _ in parse_qsl(parts.fragment, keep_blank_values=True):
        if not re.fullmatch(r"tgWebApp[A-Za-z]+", k) or k == "tgWebAppStartParam" or k in seen:
            names.append("#" + _name(k) + (" (twice)" if k in seen else ""))
        seen.add(k)
    return names


class PartialRead(Exception):
    """Reading the replies to /start failed partway; urls: what was read."""

    def __init__(self, urls: list[str], cause: BaseException) -> None:
        super().__init__(type(cause).__name__)
        self.urls = urls


# --- What the checks need from Telegram ----------------------------------------


@dataclass
class Bot:
    id: int
    is_bot: bool
    has_main_app: bool
    handle: object = None  # the client's own reference to the bot


class Client(Protocol):
    async def resolve(self, username: str) -> Bot: ...

    async def main_url(self, bot: Bot) -> str: ...

    async def menu_button(self, bot: Bot) -> str | None:
        """The menu button's web app address; None if it opens no web app."""

    async def welcome_urls(self, bot: Bot) -> list[str] | None:
        """Sends /start; the web app addresses in every reply (None if the
        bot didn't reply). Deletes all those messages afterwards."""


# --- The checks -------------------------------------------------------------


@dataclass
class Report:
    statuses: dict[str, str] = field(default_factory=lambda: {c: "unknown" for c in CHECKS})
    lines: list[str] = field(default_factory=list)
    bot_id: int | None = None
    errors: bool = False

    def ok(self, check: str, detail: str) -> None:
        if self.statuses[check] != "failed":
            self.statuses[check] = "passed"
        self.lines.append(f"ok {check}: {detail}")

    def fail(self, check: str, detail: str) -> None:
        self.statuses[check] = "failed"
        self.lines.append(f"FAILED {check}: {detail}")

    def error(self, check: str, e: BaseException) -> None:
        # The type only: a Telegram error's text can quote the request.
        self.unchecked(check, type(e).__name__)

    def unchecked(self, check: str, why: str) -> None:
        if self.statuses[check] != "failed":
            self.statuses[check] = "unknown"
        self.errors = True
        self.lines.append(f"ERROR {check}: couldn't check ({why})")

    @property
    def result(self) -> str:
        """failed outranks error: a wrong address found stays a failure."""
        if "failed" in self.statuses.values():
            return "failed"
        return "error" if self.errors else "passed"


async def run_checks(client: Client, username: str, origin: str, start: bool) -> Report:
    scheme, host = expected_origin(origin)
    want = f"{scheme}://{host}/"
    report = Report()

    def judge(check: str, what: str, url: str, telegram_adds: bool = False) -> None:
        added = added_parameters(url, telegram_adds)
        if not same_place(url, scheme, host, empty_path=telegram_adds):
            report.fail(check, f"{what} opens {shown(url)}, not {want}")
        elif added:
            report.fail(check, f"{what} opens {shown(url)} with parameters Telegram doesn't add: {', '.join(added[:5])}")
        else:
            report.ok(check, f"{what} opens {shown(url)}")

    bot = await client.resolve(username)  # without the bot, nothing can be checked
    report.bot_id = bot.id
    if not bot.is_bot:
        report.fail("bot", f"@{username} (id {bot.id}) is not a bot")
        return report
    report.ok("bot", f"@{username} is a bot, id {bot.id}")

    async def main() -> None:
        if not bot.has_main_app:
            report.fail("main", f"the bot has no Main Mini App, which every t.me/{username}?startapp link opens")
        else:
            judge("main", f"t.me/{username}?startapp (the Main Mini App)", await client.main_url(bot), telegram_adds=True)

    async def menu() -> None:
        url = await client.menu_button(bot)
        if url is None:
            report.fail("menu", "the menu button opens no web app")
        else:
            judge("menu", "the menu button", url)

    async def welcome() -> None:
        if not start:
            report.statuses["welcome"] = "na"
            report.lines.append("skipped welcome: --no-start")
            return
        try:
            urls = await client.welcome_urls(bot)
        except PartialRead as e:
            # What was read is judged (a wrong address stays a failure);
            # the rest couldn't be checked.
            for i, url in enumerate(e.urls, 1):
                judge("welcome", f"app button {i} of {len(e.urls)} read before reading failed", url)
            report.unchecked("welcome", f"reading the replies to /start failed ({e})")
            return
        if urls is None:
            # An outage looks the same: not a swap, so not a failure.
            report.unchecked("welcome", "the bot didn't reply to /start")
        elif not urls:
            report.fail("welcome", "the bot's replies to /start have no app button")
        else:
            for i, url in enumerate(urls, 1):
                judge("welcome", f"app button {i} of {len(urls)} in the replies to /start", url)

    for check, run in (("main", main), ("menu", menu), ("welcome", welcome)):
        try:
            await run()
        except Exception as e:  # network, Telegram limits: this check only
            report.error(check, e)
    return report


# --- Telegram, through Telethon -------------------------------------------------


def _web_app_urls(markup: object) -> list[str]:
    """Every web app button's address in a message's buttons, across the
    shapes Telegram's layers give them (KeyboardButtonWebView in older ones,
    KeyboardInlineButton with InlineButtonTypeWebView since)."""
    urls = []
    for row in getattr(markup, "rows", None) or []:
        for button in getattr(row, "buttons", None) or []:
            for part in (button, getattr(button, "type", None)):
                if part is not None and "WebView" in type(part).__name__ and isinstance(getattr(part, "url", None), str):
                    urls.append(part.url)
                    break
    return urls


# Sent with every request for an app's address, so that Telegram adds its own
# tgWebAppThemeParams, and one planted in the address is a second copy (the
# app reads the first).
THEME = '{"bg_color":"#ffffff","text_color":"#000000"}'


class TelethonClient:
    """The real client: a Telegram user account through Telethon."""

    def __init__(self, telegram: object, platform: str = "android", reply_wait: float = 20.0, quiet: float = 4.0, poll: float = 1.5) -> None:
        self.tg = telegram
        self.platform = platform
        self.reply_wait = reply_wait  # at most this long for replies to /start
        self.quiet = quiet  # and done once none has come for this long
        self.poll = poll
        self.warnings: list[str] = []  # cleanup that failed, for stderr

    async def resolve(self, username: str) -> Bot:
        from telethon.tl import functions, types

        resolved = await self.tg(functions.contacts.ResolveUsernameRequest(username=username))
        users = [u for u in resolved.users if isinstance(u, types.User) and u.id == getattr(resolved.peer, "user_id", None)]
        if not users:
            raise CouldNotRun(f"@{username} isn't a user or bot")
        user = users[0]
        handle = types.InputUser(user_id=user.id, access_hash=user.access_hash)
        return Bot(id=user.id, is_bot=bool(user.bot), has_main_app=bool(user.bot_has_main_app), handle=handle)

    async def main_url(self, bot: Bot) -> str:
        from telethon import utils
        from telethon.tl import functions, types

        peer = utils.get_input_peer(bot.handle)
        result = await self.tg(functions.messages.RequestMainWebViewRequest(peer=peer, bot=bot.handle, platform=self.platform, theme_params=types.DataJSON(data=THEME)))
        return result.url

    async def menu_button(self, bot: Bot) -> str | None:
        from telethon.tl import functions, types

        full = await self.tg(functions.users.GetFullUserRequest(id=bot.handle))
        info = getattr(full.full_user, "bot_info", None)
        button = getattr(info, "menu_button", None)
        return button.url if isinstance(button, types.BotMenuButton) else None

    async def welcome_urls(self, bot: Bot) -> list[str] | None:
        from telethon.tl import functions

        sent = await self.tg.send_message(bot.handle, "/start")
        # Every app address seen in any version of each reply: a button
        # edited to another address and back still counts.
        replies: dict[int, list[str]] = {}

        async def read() -> bool:
            """Reads the replies since /start; whether a new one came."""
            new = False
            for message in await self.tg.get_messages(bot.handle, limit=100, min_id=sent.id):
                if not message.out:
                    new = new or message.id not in replies
                    seen = replies.setdefault(message.id, [])
                    seen += [u for u in _web_app_urls(message.reply_markup) if u not in seen]
            return new

        try:
            loop = asyncio.get_running_loop()
            began = last = loop.time()
            while loop.time() - began < self.reply_wait and not (replies and loop.time() - last >= self.quiet):
                await asyncio.sleep(self.poll)
                if await read():
                    last = loop.time()
            # Once more right before deleting: an edit or a late reply until
            # now is read, and a deleted message can't be edited.
            await read()
        except Exception as e:
            if replies:
                raise PartialRead([u for mid in sorted(replies) for u in replies[mid]], e) from None
            raise
        finally:
            # This account's /start and every reply, also if reading failed;
            # a failed delete doesn't change what was read.
            try:
                await self.tg(functions.messages.DeleteMessagesRequest(id=[sent.id, *sorted(replies)], revoke=True))
            except Exception as e:
                self.warnings.append(f"couldn't delete the /start messages ({type(e).__name__}); delete them in the chat with the bot")
        if not replies:
            return None
        return [url for mid in sorted(replies) for url in replies[mid]]


def _credentials() -> tuple[int, str]:
    api_id, api_hash = os.environ.get("TG_API_ID", ""), os.environ.get("TG_API_HASH", "")
    if not re.fullmatch(r"[1-9][0-9]{0,9}", api_id) or int(api_id) >= 2**31 or not re.fullmatch(r"[0-9a-f]{32}", api_hash):
        raise CouldNotRun("set TG_API_ID and TG_API_HASH to an app's credentials from https://my.telegram.org (docs/verifying.md)")
    return int(api_id), api_hash


def _telethon():
    try:
        import telethon  # noqa: F401
    except ImportError:
        raise CouldNotRun("Telethon isn't installed: see docs/verifying.md for the packages, pinned by hash")
    from telethon import TelegramClient
    from telethon.sessions import StringSession

    return TelegramClient, StringSession


def _is_terminal() -> bool:
    return sys.stdin.isatty()


async def _main(args: argparse.Namespace) -> int:
    TelegramClient, StringSession = _telethon()
    api_id, api_hash = _credentials()
    saved = os.environ.get("TG_SESSION", "")
    interactive = args.make_session or not saved
    if interactive and not _is_terminal():
        raise CouldNotRun("an interactive login needs a terminal; for runs without one, set TG_SESSION (--make-session)")
    tg = TelegramClient(StringSession("" if interactive else saved), api_id, api_hash, device_model=DEVICE, receive_updates=False)
    try:
        if interactive:
            # Telethon asks for the phone number, the code, and a password if
            # the account has one, and says whom it logged in as: all on
            # stderr, so stdout holds only the result (or the session string).
            # Nothing is written to disk.
            with contextlib.redirect_stdout(sys.stderr):
                await tg.start()
        else:
            await tg.connect()
            if not await tg.is_user_authorized():
                raise CouldNotRun("TG_SESSION isn't logged in: make a new one with --make-session")
        if args.make_session:
            print("The session string below logs in as this account. Keep it secret, and use it in one place only:", file=sys.stderr)
            print(tg.session.save())
            return EXIT_VERIFIED
        client = TelethonClient(tg)
        report = await run_checks(client, args.username, args.origin, start=not args.no_start)
        for warning in client.warnings:
            print(f"Warning: {warning}", file=sys.stderr)
    finally:
        await _close(tg, log_out=interactive and not args.make_session)

    return _finish(report, args)


async def _close(tg: object, log_out: bool) -> None:
    """Logs an interactive login out and disconnects. A failure here only
    warns: it mustn't hide the checks' result (or an earlier error)."""
    def warn(why: str) -> None:
        print(f'Warning: couldn\'t log out ({why}): end the session "{DEVICE}" in Telegram, Settings, Devices', file=sys.stderr)

    try:
        # Telethon's log_out() answers False when Telegram refuses.
        if log_out and await tg.is_user_authorized() and not await tg.log_out():
            warn("Telegram refused")
    except Exception as e:
        warn(type(e).__name__)
    try:
        await tg.disconnect()
    except Exception:
        pass


def _finish(report: Report, args: argparse.Namespace) -> int:
    """Prints the report, writes the summary if asked, and gives the exit code."""
    for line in report.lines:
        print(line)
    result = report.result
    print({"passed": "VERIFIED", "failed": "VERIFICATION FAILED", "error": "COULDN'T FINISH"}[result])
    code = {"passed": EXIT_VERIFIED, "failed": EXIT_FAILED, "error": EXIT_ERROR}[result]
    if args.summary and not _write_summary(args.summary, result, report) and code == EXIT_VERIFIED:
        return EXIT_ERROR  # a failure stays a failure
    return code


def _write_summary(path: str, result: str, report: Report | None) -> bool:
    summary = {
        "result": result,
        "checked_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "bot_id": report.bot_id if report else None,
        "checks": dict(report.statuses) if report else {c: "unknown" for c in CHECKS},
    }
    try:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(summary, f, indent=2)
            f.write("\n")
    except OSError as e:
        print(f"Error: couldn't write the summary ({type(e).__name__})", file=sys.stderr)
        return False
    return True


def parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("username", nargs="?", help="the bot's username, without @")
    p.add_argument("origin", nargs="?", help="the app's origin, https://<host>")
    p.add_argument("--no-start", action="store_true", help="don't send /start (skips the welcome check)")
    p.add_argument("--summary", metavar="FILE", help="also write the result as JSON, for other tools")
    p.add_argument("--make-session", action="store_true", help="log in and print a session string for TG_SESSION")
    args = p.parse_args(argv)
    if not args.make_session:
        if not args.username or not args.origin:
            p.error("give the bot's username and the app's origin")
        if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{3,31}", args.username):
            p.error(f"not a Telegram username: {args.username!r}")
        try:
            expected_origin(args.origin)
        except ValueError as e:
            p.error(str(e))
    return args


def main(argv: list[str] | None = None) -> int:
    if sys.version_info < (3, 11):
        print("Error: needs Python 3.11 or later", file=sys.stderr)
        return EXIT_ERROR
    args = parse_args(sys.argv[1:] if argv is None else argv)
    # Telethon's own log lines: none, so nothing it might quote is printed.
    logging.getLogger("telethon").setLevel(logging.CRITICAL + 1)
    try:
        return asyncio.run(_main(args))
    except CouldNotRun as e:
        print(f"Error: {e}", file=sys.stderr)
    except KeyboardInterrupt:
        print("Error: stopped", file=sys.stderr)
    except Exception as e:  # network, Telegram limits (FloodWait), anything unexpected
        # The type only: a Telegram error's text can quote the request.
        print(f"Error: couldn't run the check: {type(e).__name__}", file=sys.stderr)
    if getattr(args, "summary", None):
        _write_summary(args.summary, "error", None)
    return EXIT_ERROR


if __name__ == "__main__":
    sys.exit(main())
