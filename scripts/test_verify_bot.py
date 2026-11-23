"""Tests for scripts/verify-bot.py, offline: a stand-in client for the
checks, and, with Telethon installed, a stand-in Telegram connection for the
real client. Run by CI (which installs Telethon and requires it):

  python3 -m unittest discover -s scripts -p 'test_verify_bot.py' -v
"""

from __future__ import annotations

import asyncio
import contextlib
import importlib.util
import io
import json
import logging
import os
import pathlib
import sys
import tempfile
import types as pytypes
import unittest
from unittest import mock

_path = pathlib.Path(__file__).with_name("verify-bot.py")
_spec = importlib.util.spec_from_file_location("verify_bot", _path)
vb = importlib.util.module_from_spec(_spec)
sys.modules["verify_bot"] = vb  # dataclasses look their module up
_spec.loader.exec_module(vb)

try:
    import telethon  # noqa: F401

    HAVE_TELETHON = True
except ImportError:
    HAVE_TELETHON = False
    # CI installs it, so the real client's tests must run there, not skip.
    if os.environ.get("VERIFY_BOT_REQUIRE_TELETHON") == "1":
        raise

BOT = "example_bot"
ORIGIN = "https://example.github.io"
GOOD = "https://example.github.io/#tgWebAppData=SECRET-LOGIN&tgWebAppVersion=9.1&tgWebAppPlatform=android&tgWebAppThemeParams=%7B%7D"
EVIL = "https://evil.example/#tgWebAppData=SECRET-LOGIN"
# Addresses that must not pass: each is somewhere other than ORIGIN + "/".
ELSEWHERE = [
    "https://evil.example/",
    "https://example.github.io/x/",
    "https://example.github.io/index.html",
    "https://example.github.io",  # no path at all
    "http://example.github.io/",
    "https://example.github.io.evil.example/",
    "https://example.github.io@evil.example/",
    "https://user@example.github.io/",
    "https://example.github.io:8443/",
    "https://example.github.io:443/",
    "https://example.github.io./",
    "https://Example.github.io/",
    "https://еxample.github.io/",  # a Cyrillic е
    "https://evil.example\\@example.github.io/",
    "//example.github.io/",
    "javascript:alert(1)//example.github.io/",
    "",
]
# At the right address, with parameters Telegram doesn't add: the app reads
# some of them (a start parameter, #save=).
PLANTED = [
    "https://example.github.io/?tgWebAppStartParam=attacker",
    "https://example.github.io/?x=1#tgWebAppData=SECRET",
    "https://example.github.io/#save=ticket",
    "https://example.github.io/#tgWebAppData=SECRET&tgWebAppStartParam=attacker",
    "https://example.github.io/#tgWebAppData=SECRET&save=ticket",
    "https://example.github.io/#/route",
]


class Stub:
    """A stand-in client: answers from its fields, records /start. A field
    set to an exception is raised instead."""

    def __init__(self, **kw):
        self.is_bot = kw.get("is_bot", True)
        self.has_main_app = kw.get("has_main_app", True)
        self.main = kw.get("main", GOOD)
        self.menu = kw.get("menu", GOOD)
        self.welcome = kw.get("welcome", [GOOD])
        self.link = kw.get("link", None)
        self.started = 0

    @staticmethod
    def answer(value):
        if isinstance(value, Exception):
            raise value
        return value

    async def resolve(self, username):
        return vb.Bot(id=42, is_bot=self.is_bot, has_main_app=self.has_main_app)

    async def main_url(self, bot):
        return self.answer(self.main)

    async def menu_button(self, bot):
        return self.answer(self.menu)

    async def welcome_urls(self, bot):
        self.started += 1
        return self.answer(self.welcome)

    async def link_url(self, bot, app_name):
        return self.answer(self.link)


def check(stub, start=True):
    return asyncio.run(vb.run_checks(stub, BOT, ORIGIN, "app", start))


class Checks(unittest.TestCase):
    def test_all_pass(self):
        r = check(Stub(link=GOOD))
        self.assertEqual(r.result, "passed")
        self.assertEqual(r.statuses, {c: "passed" for c in vb.CHECKS})
        self.assertEqual(r.bot_id, 42)

    def test_the_named_app_is_optional(self):
        r = check(Stub(link=None))
        self.assertEqual(r.result, "passed")
        self.assertEqual(r.statuses["link"], "na")
        self.assertIn("not set link: the bot has no Mini App named 'app'", r.lines)

    def test_the_main_app_is_required(self):
        r = check(Stub(has_main_app=False))
        self.assertEqual(r.result, "failed")
        self.assertEqual(r.statuses["main"], "failed")

    def test_each_check_fails_for_every_other_address(self):
        for where in ("main", "menu", "link"):
            for url in ELSEWHERE:
                with self.subTest(where=where, url=url):
                    r = check(Stub(**{where: url}))
                    self.assertEqual(r.result, "failed")
                    self.assertEqual(r.statuses[where], "failed")
                    others = {c: s for c, s in r.statuses.items() if c != where}
                    self.assertTrue(all(s in ("passed", "na") for s in others.values()), others)
        for url in ELSEWHERE:
            with self.subTest(where="welcome", url=url):
                self.assertEqual(check(Stub(welcome=[url])).statuses["welcome"], "failed")

    def test_planted_parameters_fail(self):
        for url in PLANTED:
            for where in ("main", "menu", "link"):
                with self.subTest(where=where, url=url):
                    r = check(Stub(**{where: url}))
                    self.assertEqual(r.statuses[where], "failed")
                    self.assertNotIn("attacker", "\n".join(r.lines))
                    self.assertNotIn("ticket", "\n".join(r.lines))
            with self.subTest(where="welcome", url=url):
                self.assertEqual(check(Stub(welcome=[url])).statuses["welcome"], "failed")
        # Named, values never shown.
        for url, names in (("https://example.github.io/#tgWebAppData=x&save=ticket", "#save"),
                           ("https://example.github.io/?tgWebAppStartParam=attacker", "?tgWebAppStartParam"),
                           ("https://example.github.io/?x=1&y=2#tgWebAppStartParam=a", "?x, ?y, #tgWebAppStartParam")):
            with self.subTest(url=url):
                text = "\n".join(check(Stub(main=url)).lines)
                self.assertIn(f"with parameters Telegram doesn't add: {names}", text)

    def test_telegrams_own_parameters_pass(self):
        for url in ("https://example.github.io/", GOOD, "https://example.github.io/#tgWebAppData=a%26b%3Dc&tgWebAppFullscreen"):
            with self.subTest(url=url):
                self.assertEqual(check(Stub(main=url, menu=url, welcome=[url], link=url)).result, "passed")

    def test_one_bad_button_fails_the_welcome_check(self):
        # The bad one first: a later good one mustn't turn it back to passed.
        for urls in (["https://evil.example/", GOOD], [GOOD, "https://evil.example/"]):
            with self.subTest(urls=urls):
                r = check(Stub(welcome=urls))
                self.assertEqual(r.statuses["welcome"], "failed")
                self.assertEqual(r.result, "failed")

    def test_missing_buttons_fail(self):
        self.assertEqual(check(Stub(menu=None)).statuses["menu"], "failed")
        self.assertEqual(check(Stub(welcome=[])).statuses["welcome"], "failed")

    def test_no_reply_is_not_a_failure_but_unfinished(self):
        # A bot that's down looks the same: not a swap.
        r = check(Stub(welcome=None))
        self.assertEqual(r.statuses["welcome"], "unknown")
        self.assertEqual(r.result, "error")

    def test_no_start_skips_the_welcome(self):
        stub = Stub(welcome=["https://evil.example/"])
        r = check(stub, start=False)
        self.assertEqual(stub.started, 0)
        self.assertEqual(r.statuses["welcome"], "na")
        self.assertEqual(r.result, "passed")

    def test_not_a_bot(self):
        r = check(Stub(is_bot=False))
        self.assertEqual(r.result, "failed")
        self.assertEqual(r.statuses["bot"], "failed")
        self.assertEqual({r.statuses[c] for c in ("main", "menu", "welcome", "link")}, {"unknown"})

    def test_an_error_stays_in_its_check(self):
        r = check(Stub(menu=OSError("network")))
        self.assertEqual(r.statuses["menu"], "unknown")
        self.assertEqual(r.statuses["main"], "passed")
        self.assertEqual(r.statuses["welcome"], "passed")
        self.assertEqual(r.result, "error")
        self.assertIn("ERROR menu: couldn't check (OSError)", r.lines)

    def test_a_failure_outranks_an_error(self):
        # Failure before the error, and after it.
        for kw in ({"main": "https://evil.example/", "menu": OSError("x")}, {"main": OSError("x"), "link": "https://evil.example/"}):
            with self.subTest(kw=list(kw)):
                self.assertEqual(check(Stub(**kw)).result, "failed")

    def test_the_full_address_is_never_printed(self):
        for kw in ({}, {"main": EVIL}, {"link": GOOD.replace("example.github.io", "evil.example")}, {"welcome": [GOOD.replace(".io/#", ".io/x#")]}):
            r = check(Stub(**kw))
            text = "\n".join(r.lines)
            self.assertNotIn("SECRET", text)
            self.assertNotIn("tgWebApp", text)


class Addresses(unittest.TestCase):
    def test_origin_must_be_plain(self):
        self.assertEqual(vb.expected_origin(ORIGIN), ("https", "example.github.io"))
        self.assertEqual(vb.expected_origin(ORIGIN + "/"), ("https", "example.github.io"))
        for bad in ("http://example.github.io", "https://example.github.io/app/", "https://Example.github.io",
                    "https://example.github.io?x", "https://u@example.github.io", "https://example.github.io:8443", "example.github.io"):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                vb.expected_origin(bad)

    def test_shown_keeps_origin_and_path_only(self):
        self.assertEqual(vb.shown(GOOD), "https://example.github.io/")
        self.assertEqual(vb.shown("https://user:pass@evil.example/p?q=1#f"), "https://evil.example/p")
        self.assertEqual(vb.shown("https://еxample.github.io/"), "https://?xample.github.io/")
        self.assertEqual(vb.shown("https://evil.example/\x1b[2J"), "https://evil.example/?[2J")
        self.assertEqual(len(vb.shown("https://evil.example/" + "a" * 500)), 200)
        self.assertEqual(vb.shown(""), "(not an address)")
        self.assertEqual(vb.shown("https://[::1/"), "(not an address)")


class Buttons(unittest.TestCase):
    def test_web_app_buttons_in_every_shape(self):
        # Shapes by class name, as Telegram's layers name them.
        WebView = type("InlineButtonTypeWebView", (), {})
        UrlType = type("InlineButtonTypeUrl", (), {})
        OldWebView = type("KeyboardButtonWebView", (), {})
        Button = type("KeyboardInlineButton", (), {})

        def obj(cls, **kw):
            o = cls()
            o.__dict__.update(kw)
            return o

        markup = pytypes.SimpleNamespace(rows=[
            pytypes.SimpleNamespace(buttons=[obj(Button, text="Open", type=obj(WebView, url="https://a.example/")),
                                             obj(Button, text="Site", type=obj(UrlType, url="https://b.example/"))]),
            pytypes.SimpleNamespace(buttons=[obj(OldWebView, text="Old", url="https://c.example/")]),
        ])
        self.assertEqual(vb._web_app_urls(markup), ["https://a.example/", "https://c.example/"])
        self.assertEqual(vb._web_app_urls(None), [])
        self.assertEqual(vb._web_app_urls(pytypes.SimpleNamespace(rows=None)), [])


def run_main(argv, env=None):
    out, err = io.StringIO(), io.StringIO()
    with mock.patch.dict(os.environ, env or {}, clear=True), contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = vb.main(argv)
    return code, out.getvalue(), err.getvalue()


class Command(unittest.TestCase):
    def test_bad_arguments_are_refused(self):
        for argv in ([], [BOT], ["bad name", ORIGIN], [BOT, "http://x.example"], [BOT, ORIGIN, "--app-name", "a/b"]):
            with self.subTest(argv=argv), self.assertRaises(SystemExit) as e, contextlib.redirect_stderr(io.StringIO()):
                vb.main(argv)
            self.assertEqual(e.exception.code, 2)

    def test_an_old_python_is_refused(self):
        with mock.patch.object(vb.sys, "version_info", (3, 10, 14)):
            code, _, err = run_main([BOT, ORIGIN])
        self.assertEqual(code, 2)
        self.assertIn("3.11", err)

    def test_no_credentials_exit_2_with_an_error_summary(self):
        with tempfile.TemporaryDirectory() as d:
            summary = os.path.join(d, "s.json")
            with mock.patch.object(vb, "_telethon", return_value=(None, None)):
                code, out, err = run_main([BOT, ORIGIN, "--summary", summary])
            self.assertEqual(code, 2)
            self.assertIn("TG_API_ID", err)
            data = json.loads(pathlib.Path(summary).read_text())
            self.assertEqual(data["result"], "error")
            self.assertEqual(set(data["checks"].values()), {"unknown"})
            self.assertRegex(data["checked_at"], r"\A\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\Z")

    def test_an_unexpected_error_prints_its_type_only(self):
        def boom():
            raise RuntimeError(GOOD)

        with mock.patch.object(vb, "_telethon", side_effect=boom):
            code, out, err = run_main([BOT, ORIGIN])
        self.assertEqual(code, 2)
        self.assertIn("RuntimeError", err)
        self.assertNotIn("SECRET", err + out)

    def test_telethons_logging_is_silenced(self):
        with mock.patch.object(vb, "_telethon", return_value=(None, None)):
            run_main([BOT, ORIGIN])
        self.assertFalse(logging.getLogger("telethon").isEnabledFor(logging.CRITICAL))
        self.assertFalse(logging.getLogger("telethon.network").isEnabledFor(logging.CRITICAL))

    def finish(self, report, argv):
        async def fake_main(args):
            return vb._finish(report, args)

        with mock.patch.object(vb, "_main", fake_main):
            return run_main(argv)

    def test_a_passing_run_prints_verified_and_writes_its_summary(self):
        report = vb.Report()
        for c in vb.CHECKS:
            report.ok(c, "fine")
        report.bot_id = 42
        with tempfile.TemporaryDirectory() as d:
            summary = os.path.join(d, "s.json")
            code, out, _ = self.finish(report, [BOT, ORIGIN, "--summary", summary])
            self.assertEqual(code, 0)
            self.assertEqual(out.splitlines()[-1], "VERIFIED")
            data = json.loads(pathlib.Path(summary).read_text())
            self.assertEqual((data["result"], data["bot_id"], set(data["checks"])), ("passed", 42, set(vb.CHECKS)))

    def test_an_unwritable_summary_is_said_not_a_traceback(self):
        report = vb.Report()
        for c in vb.CHECKS:
            report.ok(c, "fine")
        code, out, err = self.finish(report, [BOT, ORIGIN, "--summary", "/nonexistent-dir/s.json"])
        self.assertEqual(code, 2)
        self.assertEqual(out.splitlines()[-1], "VERIFIED")
        self.assertIn("couldn't write the summary", err)
        self.assertNotIn("Traceback", err)

    def test_a_failing_run_exits_1_and_an_unfinished_one_2(self):
        failed = vb.Report()
        failed.fail("main", "opens https://evil.example/")
        code, out, _ = self.finish(failed, [BOT, ORIGIN])
        self.assertEqual((code, out.splitlines()[-1]), (1, "VERIFICATION FAILED"))
        unfinished = vb.Report()
        unfinished.ok("main", "fine")
        unfinished.error("menu", OSError("x"))
        with tempfile.TemporaryDirectory() as d:
            summary = os.path.join(d, "s.json")
            code, out, _ = self.finish(unfinished, [BOT, ORIGIN, "--summary", summary])
            self.assertEqual((code, out.splitlines()[-1]), (2, "COULDN'T FINISH"))
            data = json.loads(pathlib.Path(summary).read_text())
            self.assertEqual((data["result"], data["checks"]["main"], data["checks"]["menu"]), ("error", "passed", "unknown"))


class Login(unittest.TestCase):
    """_main's login: an interactive one needs a terminal and is logged out
    at the end, a saved session never is, and --make-session prints only the
    string on stdout and checks nothing."""

    API = {"TG_API_ID": "12345", "TG_API_HASH": "0123456789abcdef0123456789abcdef"}

    def run_with(self, argv, env, checks=None, terminal=True, logout_fails=False, result="passed"):
        made = []

        class Session:
            def __init__(self, saved=""):
                self.saved = saved

            def save(self):
                return "SESSION-STRING"

        class FakeTelegram:
            def __init__(self, session, api_id, api_hash, **kw):
                self.session, self.api, self.kw = session, (api_id, api_hash), kw
                self.authorized = session.saved == "GOOD"
                self.calls = []
                made.append(self)

            async def start(self):
                # Telethon prompts and reports on stdout.
                print("Please enter your phone: ")
                print("Signed in successfully as Someone")
                self.calls.append("start")
                self.authorized = True

            async def connect(self):
                self.calls.append("connect")

            async def is_user_authorized(self):
                return self.authorized

            async def log_out(self):
                self.calls.append("log_out")
                if logout_fails:
                    raise ConnectionError("lost")
                self.authorized = False

            async def disconnect(self):
                self.calls.append("disconnect")

        async def fake_checks(client, username, origin, app_name, start):
            if checks:
                raise checks
            report = vb.Report()
            for c in vb.CHECKS:
                report.ok(c, "fine")
            if result == "failed":
                report.fail("main", "opens https://evil.example/")
            return report

        with mock.patch.object(vb, "_telethon", return_value=(FakeTelegram, Session)), mock.patch.object(vb, "run_checks", fake_checks), \
                mock.patch.object(vb, "_is_terminal", return_value=terminal):
            code, out, err = run_main(argv, env)
        return code, made[0] if made else None, out, err

    def test_an_interactive_login_is_logged_out_at_the_end(self):
        code, tg, out, err = self.run_with([BOT, ORIGIN], self.API)
        self.assertEqual(code, 0)
        self.assertEqual(tg.calls, ["start", "log_out", "disconnect"])
        self.assertEqual(tg.session.saved, "")
        self.assertEqual(tg.kw["device_model"], vb.DEVICE)
        self.assertEqual(tg.api, (12345, "0123456789abcdef0123456789abcdef"))
        # The prompts went to stderr; stdout is the result.
        self.assertIn("Signed in", err)
        self.assertNotIn("Signed in", out)

    def test_also_when_the_checks_stop_early(self):
        code, tg, _, _ = self.run_with([BOT, ORIGIN], self.API, checks=vb.CouldNotRun("no such bot"))
        self.assertEqual(code, 2)
        self.assertEqual(tg.calls, ["start", "log_out", "disconnect"])

    def test_a_failed_logout_warns_but_keeps_the_result(self):
        code, tg, out, err = self.run_with([BOT, ORIGIN], self.API, logout_fails=True, result="failed")
        self.assertEqual(code, 1)
        self.assertEqual(out.splitlines()[-1], "VERIFICATION FAILED")
        self.assertIn("Settings, Devices", err)
        self.assertEqual(tg.calls, ["start", "log_out", "disconnect"])

    def test_an_interactive_login_needs_a_terminal(self):
        code, tg, _, err = self.run_with([BOT, ORIGIN], self.API, terminal=False)
        self.assertEqual(code, 2)
        self.assertIsNone(tg)
        self.assertIn("TG_SESSION", err)

    def test_a_saved_session_is_used_and_kept(self):
        code, tg, _, _ = self.run_with([BOT, ORIGIN], {**self.API, "TG_SESSION": "GOOD"}, terminal=False)
        self.assertEqual(code, 0)
        self.assertEqual(tg.calls, ["connect", "disconnect"])
        self.assertEqual(tg.session.saved, "GOOD")

    def test_a_session_that_isnt_logged_in_is_refused(self):
        code, tg, _, err = self.run_with([BOT, ORIGIN], {**self.API, "TG_SESSION": "EXPIRED"})
        self.assertEqual(code, 2)
        self.assertIn("--make-session", err)
        self.assertEqual(tg.calls, ["connect", "disconnect"])

    def test_make_session_prints_only_the_string_on_stdout(self):
        code, tg, out, err = self.run_with(["--make-session"], {**self.API, "TG_SESSION": "GOOD"})
        self.assertEqual(code, 0)
        self.assertEqual(out, "SESSION-STRING\n")
        self.assertEqual(tg.calls, ["start", "disconnect"])
        self.assertIn("secret", err)

    def test_bad_credentials_are_refused_before_any_login(self):
        h = self.API["TG_API_HASH"]
        for env in ({}, {"TG_API_ID": "x", "TG_API_HASH": h}, {"TG_API_ID": "1", "TG_API_HASH": "short"},
                    {"TG_API_ID": "2147483648", "TG_API_HASH": h}, {"TG_API_ID": "0", "TG_API_HASH": h}):
            with self.subTest(env=env):
                code, tg, _, err = self.run_with([BOT, ORIGIN], env)
                self.assertEqual(code, 2)
                self.assertIsNone(tg)
                self.assertIn("my.telegram.org", err)


@unittest.skipUnless(HAVE_TELETHON, "Telethon isn't installed (scripts/verify-bot.requirements.txt)")
class RealClient(unittest.TestCase):
    """TelethonClient against a stand-in connection: what it asks Telegram,
    and how it reads the answers (Telethon's own types)."""

    def setUp(self):
        from telethon.tl import types

        self.t = types
        self.bot_user = types.User(id=42, access_hash=7, bot=True, bot_has_main_app=True, username=BOT)
        self.bot = vb.Bot(id=42, is_bot=True, has_main_app=True, handle=types.InputUser(user_id=42, access_hash=7))

    def fake(self, answers, replies=None, fail_reading=False):
        """replies: a list of messages, or a function of the read's number
        (0, 1, ...) giving the messages then."""
        calls = []
        reads = []
        test = self

        class Conn:
            async def __call__(self, request):
                calls.append(request)
                answer = answers[type(request).__name__]
                if isinstance(answer, Exception):
                    raise answer
                return answer

            async def send_message(self, entity, text):
                calls.append(("send", text))
                return pytypes.SimpleNamespace(id=100)

            async def get_messages(self, entity, limit, min_id):
                calls.append(("get", min_id))
                # Only what came after this account's /start.
                test.assertEqual(min_id, 100)
                if fail_reading:
                    raise OSError("network")
                now = replies(len(reads)) if callable(replies) else (replies or [])
                reads.append(1)
                # Newest first, as Telethon returns them.
                return sorted(now, key=lambda m: -m.id)

        return Conn(), calls

    def client(self, conn):
        return vb.TelethonClient(conn, reply_wait=2, quiet=0.3, poll=0.05)

    def markup(self, *urls, plain=None):
        t = self.t
        buttons = [t.KeyboardInlineButton(text="Open", type=t.InlineButtonTypeWebView(url=u)) for u in urls]
        if plain:
            buttons.append(t.KeyboardInlineButton(text="Site", type=t.InlineButtonTypeUrl(url=plain)))
        return t.ReplyInlineMarkup(rows=[t.KeyboardInlineButtonRow(buttons=buttons)])

    def rpc_error(self, code):
        # As Telethon makes it from Telegram's answer.
        from telethon import errors
        from telethon.tl.types import RpcError

        return errors.rpc_message_to_error(RpcError(error_code=400, error_message=code), request=None)

    def test_reads_every_address(self):
        from telethon.tl import functions

        t = self.t
        resolved = t.contacts.ResolvedPeer(peer=t.PeerUser(user_id=42), chats=[], users=[self.bot_user])
        full = t.users.UserFull(full_user=t.UserFull(id=42, settings=t.PeerSettings(), notify_settings=t.PeerNotifySettings(), common_chats_count=0,
                                                     bot_info=t.BotInfo(menu_button=t.BotMenuButton(text="Open", url=GOOD))), chats=[], users=[self.bot_user])
        reply = pytypes.SimpleNamespace(id=101, out=False, reply_markup=self.markup(GOOD, plain="https://other.example/"))
        conn, calls = self.fake({
            "ResolveUsernameRequest": resolved,
            "RequestMainWebViewRequest": t.WebViewResultUrl(url=GOOD),
            "GetFullUserRequest": full,
            "DeleteMessagesRequest": object(),
            "GetBotAppRequest": object(),
            "RequestAppWebViewRequest": t.WebViewResultUrl(url=GOOD),
        }, replies=[reply])
        r = asyncio.run(vb.run_checks(self.client(conn), BOT, ORIGIN, "app", True))
        self.assertEqual(r.statuses, {c: "passed" for c in vb.CHECKS}, r.lines)

        sent = [c for c in calls if not isinstance(c, tuple)]
        web = next(c for c in sent if isinstance(c, functions.messages.RequestAppWebViewRequest))
        self.assertIs(web.write_allowed, False)
        self.assertEqual(web.app.short_name, "app")
        self.assertIsInstance(web.peer, t.InputPeerUser)
        main = next(c for c in sent if isinstance(c, functions.messages.RequestMainWebViewRequest))
        self.assertIsInstance(main.peer, t.InputPeerUser)
        self.assertIn(("send", "/start"), calls)
        deleted = next(c for c in sent if isinstance(c, functions.messages.DeleteMessagesRequest))
        self.assertEqual((sorted(deleted.id), deleted.revoke), ([100, 101], True))

    def test_every_reply_to_start_is_read_and_deleted(self):
        from telethon.tl import functions

        good = pytypes.SimpleNamespace(id=101, out=False, reply_markup=self.markup(GOOD))
        evil = pytypes.SimpleNamespace(id=102, out=False, reply_markup=self.markup(EVIL))
        mine = pytypes.SimpleNamespace(id=103, out=True, reply_markup=None)
        conn, calls = self.fake({"DeleteMessagesRequest": object()}, replies=[good, evil, mine])
        urls = asyncio.run(self.client(conn).welcome_urls(self.bot))
        self.assertEqual(urls, [GOOD, EVIL])
        deleted = [c for c in calls if isinstance(c, functions.messages.DeleteMessagesRequest)]
        self.assertEqual([sorted(d.id) for d in deleted], [[100, 101, 102]])

    def test_a_reply_without_an_app_button_counts_as_a_reply(self):
        plain = pytypes.SimpleNamespace(id=101, out=False, reply_markup=None)
        conn, _ = self.fake({"DeleteMessagesRequest": object()}, replies=[plain])
        self.assertEqual(asyncio.run(self.client(conn).welcome_urls(self.bot)), [])

    def test_an_edited_reply_is_read_as_edited(self):
        # Good at first, edited to another address before the last read.
        def replies(n):
            return [pytypes.SimpleNamespace(id=101, out=False, reply_markup=self.markup(GOOD if n == 0 else EVIL))]

        conn, _ = self.fake({"DeleteMessagesRequest": object()}, replies=replies)
        self.assertEqual(asyncio.run(self.client(conn).welcome_urls(self.bot)), [EVIL])

    def test_the_last_read_before_deleting(self):
        # With no wait, only the read right before deleting sees the replies:
        # whatever came (or was edited) until then is read, then deleted.
        from telethon.tl import functions

        late = pytypes.SimpleNamespace(id=102, out=False, reply_markup=self.markup(EVIL))
        conn, calls = self.fake({"DeleteMessagesRequest": object()}, replies=[late])
        client = vb.TelethonClient(conn, reply_wait=0, quiet=0, poll=0)
        self.assertEqual(asyncio.run(client.welcome_urls(self.bot)), [EVIL])
        deleted = [c for c in calls if isinstance(c, functions.messages.DeleteMessagesRequest)]
        self.assertEqual([sorted(d.id) for d in deleted], [[100, 102]])

    def test_a_failed_delete_keeps_what_was_read(self):
        reply = pytypes.SimpleNamespace(id=101, out=False, reply_markup=self.markup(EVIL))
        conn, _ = self.fake({"DeleteMessagesRequest": ConnectionError("lost")}, replies=[reply])
        client = self.client(conn)
        self.assertEqual(asyncio.run(client.welcome_urls(self.bot)), [EVIL])
        self.assertEqual(len(client.warnings), 1)
        self.assertIn("delete them", client.warnings[0])
        # And through the checks, the address is still a failure.
        stub = Stub(welcome=asyncio.run(self.client(self.fake({"DeleteMessagesRequest": ConnectionError("lost")}, replies=[reply])[0]).welcome_urls(self.bot)))
        self.assertEqual(check(stub).statuses["welcome"], "failed")

    def test_no_reply_still_deletes_the_start_message(self):
        from telethon.tl import functions

        conn, calls = self.fake({"DeleteMessagesRequest": object()}, replies=[])
        self.assertIsNone(asyncio.run(self.client(conn).welcome_urls(self.bot)))
        deleted = [c for c in calls if isinstance(c, functions.messages.DeleteMessagesRequest)]
        self.assertEqual([d.id for d in deleted], [[100]])

    def test_a_failed_read_still_deletes_the_start_message(self):
        from telethon.tl import functions

        conn, calls = self.fake({"DeleteMessagesRequest": object()}, fail_reading=True)
        with self.assertRaises(OSError):
            asyncio.run(self.client(conn).welcome_urls(self.bot))
        deleted = [c for c in calls if isinstance(c, functions.messages.DeleteMessagesRequest)]
        self.assertEqual([d.id for d in deleted], [[100]])

    def test_no_app_by_that_name_as_telegram_says_it(self):
        from telethon import errors

        for code in ("BOT_APP_INVALID", "BOT_APP_SHORTNAME_INVALID"):
            conn, _ = self.fake({"GetBotAppRequest": self.rpc_error(code)})
            self.assertIsNone(asyncio.run(self.client(conn).link_url(self.bot, "app")), code)
        # Any other error isn't read as "no app".
        conn, _ = self.fake({"GetBotAppRequest": self.rpc_error("PEER_ID_INVALID")})
        with self.assertRaises(errors.RPCError):
            asyncio.run(self.client(conn).link_url(self.bot, "app"))

    def test_menu_button_that_opens_no_web_app(self):
        t = self.t
        for button in (t.BotMenuButtonDefault(), t.BotMenuButtonCommands(), None):
            full = pytypes.SimpleNamespace(full_user=pytypes.SimpleNamespace(bot_info=t.BotInfo(menu_button=button)))
            conn, _ = self.fake({"GetFullUserRequest": full})
            self.assertIsNone(asyncio.run(self.client(conn).menu_button(self.bot)))

    def test_the_main_app_flag_is_read(self):
        t = self.t
        for flag in (True, False, None):
            user = t.User(id=42, access_hash=7, bot=True, bot_has_main_app=flag, username=BOT)
            resolved = t.contacts.ResolvedPeer(peer=t.PeerUser(user_id=42), chats=[], users=[user])
            conn, _ = self.fake({"ResolveUsernameRequest": resolved})
            self.assertIs(asyncio.run(self.client(conn).resolve(BOT)).has_main_app, bool(flag))

    def test_a_user_that_isnt_the_resolved_peer_is_refused(self):
        t = self.t
        resolved = t.contacts.ResolvedPeer(peer=t.PeerChannel(channel_id=9), chats=[], users=[self.bot_user])
        conn, _ = self.fake({"ResolveUsernameRequest": resolved})
        with self.assertRaises(vb.CouldNotRun):
            asyncio.run(self.client(conn).resolve(BOT))


if __name__ == "__main__":
    unittest.main()
