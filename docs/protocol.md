# Protocol

The formats clients and the backend agree on. Each has test vectors that both
sides check (listed at the end). How the parts fit together is in
[architecture.md](architecture.md), and what they protect in
[security.md](security.md); this file is only the exact encoding.

Suite `0x01` throughout: P-256, SHA-256, HKDF-SHA256, AES-256-GCM. Every key,
signature and envelope is tied to it, so a later suite can never be confused
with this one.

## Notation

**Labelled message**, used for everything that is signed, hashed or MACed:

```
Message(label, part1, part2, …) =
    u16(len(label)) ‖ label ‖ u32(len(part1)) ‖ part1 ‖ u32(len(part2)) ‖ part2 ‖ …
```

Big-endian lengths. A signature for one label is never accepted for another,
and bytes can't move between parts. Strings are UTF-8; numbers as parts are
either decimal strings or 8-byte big-endian integers, as stated.

**IDs** are random bytes in unpadded base64url: accounts, devices,
conversations, messages and mailboxes 16 bytes (22 characters), links 8 bytes
(11 characters). Only the canonical encoding is accepted.

**Times** in signed structures are Unix seconds on a whole hour, so they don't
record exactly when anything happened.

## Keys

| Key | Algorithm | Notes |
|---|---|---|
| Account key | ECDSA P-256 | Copyable (sealed in the vault), never shown to other users |
| Device signing key | ECDSA P-256 | Non-extractable, one device |
| Link signing key | ECDSA P-256 | One per account, kept when its link is replaced; the server gives it to that account for good; copyable |
| Link encryption key | ECDH P-256 | Signed by the link signing key, rotated |
| Conversation key | ECDH P-256 | One per conversation per side, rotated |

Public keys travel as 65-byte uncompressed points. Signatures are IEEE P1363
(`r ‖ s`, 64 bytes) over SHA-256 of the labelled message, as WebCrypto makes
them.

**Fingerprint** of a public key `P`: base64url of
`SHA-256(Message("incognitochat/v2/fingerprint", [0x01], P))`, 43 characters.

**Key ID** of a recipient key `P`: the first 8 bytes of
`SHA-256(Message("incognitochat/v2/key-id", [0x01], P))`.

## Registration and sessions

| Label | Signed by | Parts |
|---|---|---|
| `incognitochat/v2/register` | account key and device key | SHA-256(initData), account key, device ID, device key |
| `incognitochat/v2/device-list` | account key | see below |
| `incognitochat/v2/session` | device key | account ID, device ID, timestamp (decimal), nonce |
| `incognitochat/v2/request` | device key | account ID, device ID, method, path, timestamp (decimal), nonce, SHA-256(body) |

A registration launch has `start_param = "reg" ‖ fingerprint(account key)`.
The session token travels in `X-Session` (not `Authorization`, which
CloudFront fills in when it signs a request to the backend), and a request
with a body carries the body's SHA-256, in hex, in `X-Amz-Content-Sha256`,
which that signature covers.
Signed requests carry `X-Device-Signature: <timestamp>.<nonce>.<signature>`
next to the session token. Nonces are 16–64 base64url characters and are used
once; timestamps must be within 60 seconds of the server's clock (otherwise
`clock_skew`, below). A login that can't be valid whatever the device's key
(its nonce or signature malformed) is refused with `login_refused` before
the server reads anything. A login reads the device eventually consistent,
at half the cost. So a device replaced or removed in about the last second
may still get a token, and one set up in about the last second may be
refused: the app logs in once more a second later when that happens right
after a setup, its own or another copy's. Each logged-in request reads the
device and its account again, in one strongly consistent read, so a
replaced or deleted account is refused at its first request. Opening a push
socket is the exception: it checks the token alone
([security.md](security.md#other-limits)).

**Clocks.** A login or signed request whose timestamp is more than 60 seconds
from the server's clock, and a new account's device list issued outside its
window (below), get `401 {"error": "clock_skew", "now": <the server's Unix
seconds>}`. The server decides this from the timestamp alone, before it reads
anything about the account or device, so the answer says nothing about whether
they exist. The app keeps, in memory, how far its clock is from `now`, and
uses the corrected clock for exactly these: login and signature timestamps,
a new account's first device list, and checking the session token's expiry.
It signs again with a fresh nonce and retries once, so a device whose clock
is off (a wrong time zone set by hand, say) works without the user seeing an
error. Other times still come from the device's own clock: a link's key times
(`from`, `until`, checked only to the hour and valid for weeks), and the week
of send and media tokens. The app believes `now` only within two days of its
own clock; further off, it signs nothing and asks the user to set the
device's date and time.

Messages are dated by the server's clock too (`at`, Inner message), learnt
from the session token: `/register` and `/session` answer `{account, token,
expires}`, and `expires` is exactly 15 minutes after the server issued the
token, in Unix seconds rounded down. So the server's clock was `expires` − 15
minutes (plus up to a second) at some moment while the request was out, and
the app takes the middle of both: to within half a second plus half the
round trip. Each login does this anew. The app believes it only within 60
seconds of its own clock, as far as a login's timestamp may be off. Further
off, messages are dated by the device's own clock (rounded down to the
second), and so they are until a login succeeds in a run of the app: while
it's offline, and also while the server refuses or fails logins (`429`,
`5xx`), which the app treats the same way.

**Overload.** When AWS throttles the server (a table at its cap, a function
out of instances) or a request runs out of time, the server answers
`503 {"error": "unavailable"}` with `Retry-After: 2`, rather than
`500 internal`, which stays for other failures. The functions try an AWS
call at most twice, waiting at most 200 ms in between, and cut a request's
calls off after 5 seconds (3 in `ws`, 7 in `notify`), so a throttled table
fails requests fast instead of holding the functions' instances. When the
`api` function itself has no instance free, Lambda answers `429` on its
own, without `Retry-After` (and the app may see no answer at all, if it
lacks the CORS headers); the app backs off from that too. The app doesn't
retry what the user does by itself; its background syncs back off (below,
Delivery).

**Refusals.** These answers about the device itself:

| Answer | Meaning |
|---|---|
| `401 session_expired` | The session token is missing or over; the app logs in again. |
| `401 clock_skew` | The device's clock is off (above). |
| `401 login_refused` | The device or its account doesn't exist (deleted, or replaced long ago), or the login's signature or nonce is wrong, or the device was set up in about the last second (the app tries once more, above). |
| `410 account_replaced` | The account was replaced by a setup elsewhere. Said only once the device's signature checks out. |
| `409 account_deleting` | The account is being deleted (below): it takes no request but `GET /account` (which says `deleting: true`) and `DELETE /account`. |

The app doesn't take `login_refused`, `account_replaced` or
`account_deleting` (or `deleting` in `GET /account`) on trust, since a
server could send them to anyone. It says so on a screen of its own, keeps
the device's chats there and readable (nothing is sent or downloaded), asks
again when the user taps Try again and at every launch, and goes on as
before if the server lets the device in again. It remembers each of the
three answers, so a launch that can't reach the server opens on the same
screen, read-only. A replaced account
stays shown as replaced if the server later only refuses it (the server
keeps its marker of a replacement for 90 days). It deletes nothing on such
an answer: only setting up again does, or finishing a deletion the server
says is under way (Finish deleting), each after the user types a
confirmation. The one exception is a deletion the user confirmed on this
device (below).

**One device per account.** Setting up on a second device replaces the
account (after a typed confirmation); there is no device linking or sync. A
new setup on a device first deletes everything the previous account left
there (keys, conversations, mailboxes, links). Per Telegram user and UTC day,
`POST /register` makes at most 3 accounts or replacements, and takes at most
20 attempts that get past the signature checks, retries and `account_exists`
answers included: launch data stays valid for 10 minutes, so it can be
replayed. An attempt reads only three items: the Telegram user's (`T#`),
its account item and the registering device's; a replacement, once counted,
also the old account's devices and link. A replacement whose reading of the
old account then fails still counts against the 3.

**Replacing** ends the old account at once, in one transaction of a few
writes however much it owns: its account item becomes a marker that, with
its device keys, expires after 90 days (so its device can be told), and its
link (and, for an account set up while the server stored it, its device
list) is deleted. From then on nothing of it is used: a send
to one of its mailboxes goes nowhere, doing exactly what a send to an ended
mailbox does (the server finds the mailbox's account ended; it reads the
account item with the devices, in the same query), its invitation codes
don't work, and nothing new can be made under it. The rest (its mailboxes,
invitation codes, and envelopes still waiting for its device) is deleted in
steps of about 50 write units, as a deletion is (below): the first in the
registration itself, the rest as the new device's app asks, `POST
/account/cleanup` (signed), which answers `409 in_progress` while more is
left, or while another step for the account runs, and `200 {}` once nothing
is (also when nothing was); the app repeats it a second later, in the
background (waiting out a busy server, as for a deletion, below; at most 400
steps a run). `GET /account` says `cleanup: true` while anything is left, so
the app carries on at its next launch if it closed first. Until then the new
account's item lists the old account's ID; replacing the new account carries
the list over, and deleting it finishes the cleanup first. Each step reads
only what it deletes, deletes a mailbox, code or link only if the old
account owns it, and can be repeated, or cut short anywhere, safely: the
next step finds what one left.
A device without an account may ask `POST /accounts/lookup {initData}` whether
its Telegram user has one, to say "your account is on another device" instead
of offering setup. Like notices, it accepts only a plain or registration
launch, never one that names a link or an invitation, and stores nothing
but the Telegram user's daily count of lookups (at most 30 a day). An
account being deleted (below) doesn't count: a lookup says there is none,
and setting up again replaces it without `replace`, so without the warning
about taking an account over; what is left of it goes with the new
account's cleanup, as for any replacement. Unlike other replacements, and
as its deletion would have, it keeps no marker: its item and devices lose
their keys (they stay only as stubs, until the cleanup deletes them), so
its device is refused like a deleted account's (`login_refused`), not told
it was replaced; the app that confirmed the deletion takes either answer
as done. Only the account's own signed `DELETE /account` marks it so, and
nothing undoes that, so this can't take over an account in use.

**Deleting an account:** `DELETE /account`, signed. The server deletes the
account's waiting envelopes, links (their bundles then answer "not found"),
mailboxes (sends to them get the usual answer and are dropped), invitation
codes, device list (if it has one), devices and the account itself, and
the item that keeps one account per Telegram user, so the same user can set
up again, and, in the last step, its socket records. Unlike a replacement, it keeps no
marker, also when setting up again replaces it before it's done (above);
only rate-limit counters remain until they expire (within about a
day; DynamoDB can take longer to delete them). The daily limits (send and
media tokens, new mailboxes, link changes, notice setups, mailbox checks,
invitation attempts) count per Telegram user, by the same keyed hash that
keeps one account per user, so deleting an account and setting up again
doesn't start a fresh day. It works in steps of about 50
write units, each reading about what it deletes, so a big account neither outlasts
a request nor takes the table's write capacity: while more is left the
server answers `409 in_progress`, and the app repeats the request a second
later. One step at a time runs for an account: it holds a lease on the
account item, for 15 seconds at most (longer than the function may run), and
lets the next step start a second after it ends, so the server keeps its own
pace whatever the app does. A request while another step runs, or within that
second, is answered `in_progress` too, having done nothing. The first step marks the
account as being deleted and deletes its link (its bundle then answers "not
found"), in one transaction: from then on nothing is delivered to it (a send
to its mailboxes does what a send to an ended one does), its codes don't
work, nothing new can be made under it, and it takes no request but `GET
/account`, which says `deleting: true`, and `DELETE /account`; any other is
answered `409 account_deleting`. It can't be undone. What is left of
accounts it replaced goes next, then the rest of what it owns (a mailbox or
code only if it owns it), the account, its devices and the Telegram item
last, together; 4,000 mailboxes take about 160 steps, a few minutes. Another
write to the account that cancels the last step (a notice) is answered
`in_progress` too, never as done. The last step answers `200 {}`. Once the
devices are gone, a repeat (its answer was lost) is refused like any login
of a device that no longer exists, `401 login_refused`, and the app takes
that as done too; any other answer, `404` included, leaves everything on the
device and says the deletion didn't finish.

Once the user has typed the confirmation, before its first request, the app
records that it is deleting this account (by its ID) and carries on with it
at every launch until it's done, before asking anything else; a launch whose
login is then refused (`login_refused`) takes it as done and deletes
everything on the device. Before each request, and before deleting
anything on the device, it checks that the device still holds that account
and the record, and each request, its retries included (a new login after
an expired session, a new signature after `clock_skew`), is bound to that
account: a record for another account (left by another copy of the app
before a new setup, say) is dropped and acts on nothing, and a copy of the
app whose deletion another copy finished, followed by a new setup, stops
without logging in or signing as the new account. A server that is busy
(`503 unavailable`, `429`) is waited out, as long as it asks (`Retry-After`,
up to 30 seconds). One run takes at most 400 steps, or 10 minutes; then,
or if the server keeps failing, the deleting screen offers Try again, the
chats, read-only, and deleting everything on this device only (already
confirmed, asked once more in a popup); what the server holds then stays,
unused, until the user sets up again, which replaces it (above). A
launch that can't reach the server shows that screen too. When the server says the account is
being deleted (`deleting`, or `account_deleting`), the app carries on if it
has the record (another copy of the app started it); if it hasn't, it doesn't
take the server's word: it keeps the chats readable, as when signed out
(above), and offers Finish deleting, which takes the same typed
confirmation. Until the user confirms that, no answer from the server,
`login_refused` included, deletes anything on the device. So an account is
never left half deleted and in use, and nothing on the device is deleted on
the server's word. Before its first request, the app fetches the messages
still waiting for the device (best effort, and only then: the server takes
no other request once the deletion has started), then deletes the uploads
of the attachments it received (`POST /media/{id}/delete`, which needs no
login), trying those that fail again a few times, waiting about 7 seconds
in all between tries (not while the device says it's offline). It starts
no more fetching or trying again 10 seconds after it began (a request
under way then can take up to its 15-second timeout), and goes on with the
deletion; any upload it couldn't delete, or never saw, expires within 30
days. Afterwards it deletes everything on the device. The other side of
each conversation isn't told.

**Device list** (`incognitochat/v2/device-list`), parts in order: suite
(1 byte), sequence number (8), SHA-256 of the previous list (32; zeros for the
first), issued (8), expires (8, at most 30 days later), then per device: ID
(16 raw bytes), signing key (65), added (8). A new account's first list must
be issued from 2 hours before to 1 hour after the server's clock (on the
hour, as signed times are), or registration answers `clock_skew`. The server
checks it and doesn't store it: with one device per account, nothing reads
it (accounts set up before keep theirs until they end).

## Links

```
https://t.me/<bot>/<app>?startapp=<payload>
payload = "1" ‖ link ID (11) ‖ fingerprint(link signing key) (43)       55 characters
```

The bundle (`GET /links/{id}`) holds the link signing key and 1–4 encryption
keys, each `{key, from, until, signature}` with the signature over
`Message("incognitochat/v2/link-key", [0x01], key, u64(from), u64(until))`.
A client trusts a bundle only if the signing key's fingerprint is the one in the
link and every key's signature checks; it encrypts to the newest key valid now.
Anyone can ask for a bundle, so the server reads it eventually consistent, at
half the cost: a link made, changed or revoked in about the last second may
not show so yet. Sends always go by a fresh read of the mailbox.

An account has one link at a time (`POST /links`). Replacing it
(`POST /links` with `replaces: <old ID>`) swaps the old link and its intro
mailbox for the new one in one step: the old link stops working at once.
Creating and replacing count together: at most 5 a day (UTC).
The new link has a new ID and new encryption keys but the **same signing
key**, so its fingerprint stays the same. Sender tags are made from that
fingerprint, so the same people keep the same tags across replacements, which
keeps blocks and labels. Conversations carry on, since after the first message
they don't go through the link. A sender the owner hasn't answered yet keeps
writing to the old intro mailbox, which went with the old link, so what they
send is dropped, without their being told, until the owner replies.

**Owner proof.** Creating or replacing a link (`POST /links`) and rotating
its keys (`PUT /links/{id}/keys`) carry `proof`, the link signing key's
signature over

```
Message("incognitochat/v2/link-owner", [0x01], UTF-8 link ID, UTF-8 account ID)
```

with the new link's ID when creating or replacing, and the caller's account
ID. The server checks it first; a missing or wrong proof is
`400 {"error": "invalid_link"}`. The encryption keys' signatures don't name
the link, and anyone can copy them from a bundle, so they don't show that
the caller holds the key. The proof does, and only for that account and
link.

**One account per signing key.** Since a sender's tag is the same on every
link with one signing key, accounts whose links shared a key could compare
the tags they get and match a sender who writes to each of them. So the
server gives each signing key to the first account that proves it holds it,
for good. Any other account's create, replace or rotation with that key
gets `409 {"error": "signing_key_taken"}`. The account keeps the key after
it revokes its link or moves to another key, so its next link can use it
again. When the account ends (deleted, or replaced by setting up again), the
key isn't freed: the server keeps a tombstone of it, holding only the
fingerprint, which refuses every account. So a key never passes from one
account to another, at the same time or later.

Links made before the server checked this get their key claimed at their
next rotation or replacement, each with an owner proof: whoever proves they
hold the key first claims it. Until those links' current keys expire, two
things made before stay open:

- **Copies.** Another account's copy of someone's link (their signing key
  and signed keys, taken from a bundle, under another link ID) keeps taking
  first messages meant for them until the copied keys expire: at most 5
  weeks after they were signed, since the app signs each key for 5 weeks.
  Whoever made the copy can't make a proof, so they can't claim the key,
  rotate the copy or make another one.
- **Shared keys.** Accounts that shared a private key itself keep getting
  the same tag from a sender who writes to each of their links until the
  keys those links already hold expire. The server accepted keys that start
  in the future, so a link could hold up to 4 keys of up to 8 weeks each,
  back to back: about 32 weeks from when they were put up. Only the first of
  those accounts to create, replace or rotate since can do so again; the
  others get `signing_key_taken`, and their apps make a new key (below).

A key that was never claimed stays unclaimed when its link is revoked or its
account ends, since those writes carry no proof, and whoever holds it can
still claim it.

**A key someone else has.** Told `signing_key_taken` when it creates or
replaces a link, the app makes a new signing key and tries once more with
it. Told so when it rotates, it replaces the link with one that has a new
signing key. It does the same for a link whose signing key is gone from the
device. Either way the user is told that the link has a new key: they
share the new link, senders get new tags on it, and so new labels, and
blocks don't carry over. The app notes this on the device before it makes
the new key, and keeps the note until the home screen has said it (in any
copy of the app), so a lost answer or the app closing doesn't lose it.

**A lost answer.** The client picks the new link's ID, and makes and signs
its keys, before it asks. Without an answer (a timeout, a dropped
connection, a failure without the server's own error, or the app closing),
the server may have made the change all the same, so the app keeps what it
sent: a note of the request, then the new private key, sealed and indexed
before the request (first messages to it open whatever the server did). It
deletes them at once only when the server refuses it (a 4xx answer, which
the server gives before changing anything). It settles the change at the next
upkeep, and before the next create or replace, from the link's bundle
(`GET /links/{id}`, checked like any bundle against the link signing key).
That read is eventually consistent: a change made about a second before may
not show yet, so "not there" is never taken as final on its own.

- The new key is in it: the change was made, and is taken as if the answer
  had come (a new link becomes the account's link, in place of the one it
  replaced, whose keys stay 35 days; a new key becomes the link's, and its
  older keys go 35 days later). The app shows a link it learns of this way
  at once.
- A new key for a link that isn't there, or isn't listed: it wasn't taken.
  The key is kept 35 days all the same (in case the read lagged), and the
  next rotation makes another. The app doesn't rotate while a change is
  unsettled, and never gives a new key the hour (its `from`, which names it
  on the device) of any key the link still has, kept ones included: with no
  hour free after them, the rotation waits for the next upkeep.
- A new link that isn't there: when the user creates or replaces again, the
  same request goes again, with the same ID, so the server can't make two
  links of one. If that's refused (the ID taken, the account at its limit,
  the link it replaces gone), the first may have been made after all, and
  the bundle is asked once more. If it still doesn't show, the app says the
  request was refused and keeps the change for the next try or upkeep,
  unless the change was last sent (a refused send doesn't count, since it
  isn't on its way) 10 minutes before or more: then it gives the change up
  and makes a new link in its place. Upkeep doesn't send it again; it gives
  the change up 10 minutes after it was last sent, when no request can
  still be on its way and the read has long caught up.
- A link of that ID that isn't ours: ours wasn't made.
- A note whose key isn't sealed: the app closed (or storage failed) before
  the request went, so it was never sent, and is dropped.

Revoking a link also revokes a replacement of it whose answer was lost (the
link first, so a replacement still on its way finds it gone, or was made
before and goes too), and deletes every key of the link on the device
before the link leaves the list.

An older app deleted the key after any failure, and could close between
publishing a key and indexing it. Upkeep indexes a sealed key that the index
lacks if the link's bundle lists it and the sealed key is its private half;
one the bundle doesn't list, older than its newest key, is deleted.

Invitation links use `payload = "inv" ‖ code`, the code being 8 characters from
`abcdefghjkmnpqrstuvwxyz23456789`, shown as `abcd-efgh`.

## Envelope

What the server stores and delivers, opaque to it:

```
envelope = suite (1) ‖ wrap count n (1, 1–16) ‖ wrap₁ … wrapₙ ‖ body
wrap     = key ID (8) ‖ enc (65) ‖ wrapped content key (48)
body     = nonce (12) ‖ AES-256-GCM(content key, nonce, aad, padded inner)
aad      = Message("incognitochat/v2/body", [0x01])
```

The content key is 32 random bytes per envelope. Each wrap is single-shot HPKE
Base mode (RFC 9180) — DHKEM(P-256, HKDF-SHA256), HKDF-SHA256, AES-256-GCM —
sealing the content key to one recipient key, with empty AAD and

```
info = Message("incognitochat/v2/wrap", [0x01], key ID, SHA-256(body))
```

so a wrap can't be moved onto another body. A recipient tries the wraps whose
key ID it knows.

**Padding.** The inner message is padded to 512, 2048, 8192 or 16384 bytes:
`u32(length) ‖ inner ‖ zeros`. Anything else is rejected, including non-zero
padding. An envelope's size therefore only reveals its wrap count and size
class.

## Inner message

```
inner = tag (32) ‖ JSON (UTF-8)
tag   = HMAC-SHA256(K, JSON)
K     = HKDF-SHA256(ikm = ECDH(sender conversation key, recipient key),
                    salt = empty,
                    info = Message("incognitochat/v2/message-auth", [0x01],
                                   sender public key, recipient public key))
```

The recipient computes the same `K` with its private key and the sender's
public key from `from`, so it can check the tag, and could have made it:
messages are deniable. The server holds neither private key.

JSON fields:

| Field | Meaning |
|---|---|
| `v` | 1 |
| `kind` | `message`, `seen`, `reaction`, `delete`, `edit`, `key_update` or `end` (reserved: see below) |
| `conv` | conversation ID (16 bytes) |
| `id` | message ID (16 bytes) |
| `at` | sent time, Unix milliseconds in whole seconds, by the server's clock as the sender knows it (see Times, below) |
| `from` | sender's current conversation public key (65 bytes); a new one is a rotation |
| `to` | key ID of the recipient key it was written for; must be the key that opened it |
| `reply` | mailbox to write back to (16 bytes), on everything the sender sends once it has one for the conversation: it takes one with the first thing it sends that isn't a receipt or a delete |
| `tag` | sender tag (32 bytes), on everything sent by the side that wrote through a link: `HMAC-SHA256(account secret, Message("incognitochat/v2/sender-tag", UTF-8 of the link fingerprint))`, the same for one person on every link with that fingerprint |
| `last` | ID of the newest envelope taken in from the other side (by its `at`); in a `delete` with `all`, the newest of the other side's messages the sender has (see Replays and order) |
| `text` | the text (`message` only; at most 12,000 UTF-8 bytes) |
| `replyTo` | ID of the message this answers |
| `seen` | IDs read (`seen` only, 1–100) |
| `earlier` | `true`: the recipient's messages written up to the oldest one named in `seen` (that second included) were read too (`seen` only; see Receipts) |
| `media` | an attachment (`message` only, with or without text): `{t, id, k, d, s, n?, m?, w?, h?, l?, v?, p?}`, see Media |
| `sticker` | a sticker (`message` only, with no text or attachment): `{id, e?}`, see Stickers |
| `reaction` | a reaction (`reaction` only): `{to, e}`, where `to` is the ID of a message in the conversation, from either side, and `e` one emoji (one grapheme with an emoji code point, at most 32 UTF-16 units, with no combining marks but U+FE0E, U+FE0F and U+20E3) or empty to take the reaction back |
| `delete` | IDs of the sender's own messages to delete on the recipient's device too (`delete` only, 1–100) |
| `all` | `true`: the whole conversation instead, both sides' messages (`delete` only, instead of `delete`) |
| `edit` | a new text for one of the sender's own messages (`edit` only): `{to, text}`, `text` at most 12,000 UTF-8 bytes, empty only for an attachment's caption |

Unknown fields are ignored but covered by the tag. `message` needs non-blank
text, an attachment or a sticker; `seen` needs `seen` and no text;
`reaction` needs `reaction`, `edit` needs `edit`, and `delete` needs
`delete` or `all` (one of them), and nothing else; `earlier` goes only
with `seen`; `key_update` and `end` carry none of these.

`end` is reserved and does nothing: no app sends it, and one that comes is
taken in and changes nothing. Older versions ended the conversation on one
(no more replies); a conversation they left that way is active again from
the next thing the other side sends.

**Times.** `at` is the server's clock as the sender's app knows it (Clocks,
above), rounded down to the whole second: the device's own clock, to the
millisecond, would tell recipients how far that clock is off, which lasts
for days and is the same in all of a person's conversations, so recipients
comparing notes could link them ([security.md](security.md), What still
leaks). Within a conversation, the sender dates each envelope at least a
second after the last one it sent there, so the other side never gets two
of its envelopes there with the same `at`; a quick run of them is dated a
few seconds ahead. The app keeps that last time with the conversation, so
this holds across reloads and between copies of the app. The one exception
is a clock that went back by more than a minute (the device's, or the
server's as the app knows it): then `at` goes back with it. So, for up to
a minute after the app starts dating messages by the server's clock rather
than its own (above), what it sends in a conversation where it already sent
something by its own clock carries on from that time. The inbox gives
envelopes in no set order, so it's this, not when they arrive, that keeps
one side's messages, edits and reactions in order. Versions before this
one sent the device's own clock, to the millisecond; recipients take both.

The recipient shows a message at its `at`, with two bounds. It's shown no
earlier than what it shows the sender had, as the recipient shows those:
the message it answers (`replyTo`), the envelope `last` names (a message,
or a receipt, reaction, edit or delete among the last few the recipient
sent there, whose IDs and times it keeps), and the sender's previous
message. Written after those, it shows after them, though the sender's
clock may be a little behind the recipient's. And it's shown no later than
it arrived: the second it arrived in, or the last thing the recipient sent
there if a quick run of those was dated ahead of that second, unless that
is a minute ahead or more (the clock went back, as above). This bound wins
over the first, so a message can't be pushed later than it arrived by
naming one dated further ahead. Messages with the same time (from both
sides, or from versions before this one) show in the order they were
written or taken in on this device. Where envelopes from the same side have the same `at`, the one
taken in last counts as the later one: edits and reactions keep it, and so
does the choice of key and mailbox (Replays and order).

**IDs count only within their conversation.** `conv` and `id` are the
sender's choice, so the recipient never takes them as unique on its device,
and never uses them to pick the conversation. That comes from how the
envelope reached it: the key it was written for, through the mailbox that key
belongs to (below). One of its conversation keys belongs to one
conversation, whose `conv` the message must carry; a link's key means a
first message (or more from a sender who has had nothing back yet), which
belongs to the conversation started through that link with that `conv` from
that `from` key, or else starts a new one.
Within the conversation, an `id` it has already taken in is a repeat and is
dropped (Replays and order, below), and the IDs in `seen`, `reaction`,
`edit`, `delete`, `replyTo` and `last` name that conversation's messages
only. So an ID that another conversation on the
device also uses changes nothing the sender could notice. Each app keeps a
conversation under an ID of its own, which never goes out.

One exception, on devices upgraded from before this rule: a conversation
someone started through our link that we had already answered doesn't know
the sender's first key (it may have changed since). A first message through
that link with its `conv` goes to it whatever its `from`, and is dropped
unless `from` is the sender's current key, as before. Only someone who knows
that `conv` (its sender, or whoever they told) can tell this from a fresh
ID, and all it tells them is that our device still has that conversation,
nothing about who its sender is.

**Each envelope counts only through its own mailbox.** The inbox says which
mailbox each envelope came through (Delivery). The recipient takes one in
only if that's the mailbox its key belongs to:

- written for a key of one of its links: that link's intro mailbox. A replaced
  link's keys keep theirs for as long as they're kept, for what was already
  on its way;
- written for one of its conversation keys: its mailbox for that
  conversation. In a conversation someone started through its link, also
  that link's intro mailbox, where they write until they hear of its own.
  And a mailbox of its own the conversation moved on from (unblocking takes
  a new one, as does replacing one the server no longer has). The intro
  mailbox and former ones count until 31 days after something first comes
  through the current one: the other side writes to the old one until a
  message tells them of the new, and what they wrote may wait in the inbox
  for 30 days.

The recipient keeps the intro mailbox on the conversation from its first
message, so it needs neither the link nor the network for it, even once the
link is revoked or replaced. A link made before intro mailboxes were kept
learns its own from its bundle, after checking the bundle is that link's
(signed by its signing key, listing a key made for it); envelopes that need it
while it can't be fetched wait in the inbox, unconfirmed, for the next sync.

Anything else is dropped exactly like an envelope it can't open, and
confirmed the same way. Otherwise whoever knows one of its keys (the other
side of a conversation) could seal to it and leave copies in suspects'
mailboxes, which anyone can write to: only the real owner's device would
open one, and its "seen" would say whose mailbox that was. The check trusts
the server to report the mailbox honestly; a server that lied learns
nothing it doesn't already know, since it knows every mailbox's owner.

**Deleting for both sides.** A sender can delete their own messages on the
recipient's device too, whether or not they were opened: the app sends a
`delete`, deletes the uploads of any attachments (it holds their delete
secrets), then deletes its own copies. The recipient deletes only messages
from that side in that conversation; a `delete` naming one of the
recipient's own messages changes nothing. Each message it names is
remembered as deleted, so it's dropped if it comes, also when the `delete`
arrives before it (delivery has no set order), until it's too old to come
(Replays and order). Only a `message` starts a conversation: a `delete`,
`edit` or reaction through a link before the first `message` of its
conversation (its `conv`, from its `from`) is kept aside, sealed, and
taken in just before that message, when it comes. At most 50 edits and
reactions are kept so on the device, 64 KB in all, and apart from them 50
deletes, 32 KB (past either, the oldest of that kind go, so edits can't
push out a delete), each until 31 days after its `at`; anything else that
comes first is dropped. A conversation through the link with no messages
(its first message dropped, deleted or cleared before it came, or cleared
by the sender's `delete` with `all`) stays out of the list; if the
recipient never opened or answered it, and hasn't blocked it, it goes once
nothing more can come for it: 31 days after the newest envelope it took
in. With `all`,
the recipient deletes the conversation as it was when the sender deleted
it, both sides' messages, as in Telegram: the sender's messages sent by the `delete`'s
`at`, and its own up to the newest one the sender had then (Replays and
order: the two clocks are never compared). Anything written after it, by either
side, stays, whatever order it all arrives in. Messages from that side sent
by then that arrive later are dropped. If nothing is left, it leaves the
list until either side writes again. Like blocks, this relies on the
recipient's app doing it.

**Editing.** A sender can change the text of their own sent messages, or an
attachment's caption, which may become empty; stickers, voice and video
messages have none, for 24 hours after sending. The recipient applies an
`edit` only to a message from that side in that conversation, only if its
`at` is at most 25 hours after the message's (an hour of grace for clocks
and late arrivals), and keeps the latest by `at` (of two from the same
second, the one taken in last), so a replayed or late older one changes
nothing; the message shows as edited. An `edit` that arrives before its
message is kept, sealed under the storage key like any text, for at most 31
days, and applied when the message comes; not one for a message deleted on
the recipient's device, nor one from before the conversation was cleared
(its message would be dropped). A conversation keeps at most 20 such
edits, 64 KB in all, the newest, apart from its record; conversations
through the recipient's link that it hasn't answered keep at most 64 KB
of them together (those an edit came to most recently keep theirs), and
none once deleted or blocked. One before the conversation's first message
is kept aside with the envelopes above. Like deleting for both sides, it
relies on the recipient's app.

**Receipts.** A `seen` names the messages read, up to 100; the app names
at most 50, the newest it hasn't marked read yet, and sends one receipt
however many there are. With more than 50, it adds `earlier`: the
recipient also marks as seen its messages written up to the oldest one
named (its own clock, that second included, since times are whole
seconds) that it still shows as sent (not one still sending). So reading
a chat flooded with thousands costs one send, not one per 50. One of the
recipient's messages written by then but still on its way shows as seen
before it arrives. Versions without `earlier` ignore it, as they ignore
any unknown field, and mark only the messages named: the older ones stay
shown as sent there.

**Reactions.** Each side has at most one reaction per message, as on Telegram
without Premium; a new one replaces it. The recipient keeps the one with the
latest `at` from that side (of two from the same second, the one taken in
last), so a replayed or late older one changes nothing.
One that arrives before its message (one of the sender's own, still on its
way) is kept like an early edit, sealed, the latest per message, and shown
when the message comes; one for a message deleted on the recipient's
device, or from before the conversation was cleared, is dropped, and so is
one for a message that never comes, after 31 days. Versions without
reactions drop them as an unknown kind.

**Replays and order.** The inbox gives envelopes in no set order, and the
same envelope can come more than once: an inbox read that's out of date, an
item taken in again after its confirmation failed, two copies of the app
that each take it in, or a server that keeps envelopes and delivers them
again. The recipient drops any envelope whose `at` is more than 31 days
old, or more than a day ahead of its own clock, and within that window
nothing that comes again or late undoes what came after it. There's no new
field: the one change on the wire is which ID `last` names in a `delete`
with `all` (below), and versions before this one don't read `last`. The
rest is the recipient's bookkeeping, per conversation and content-free:

- *Envelopes taken in*, of every kind: a keyed hash of each one's `id`, the
  first 9 bytes of `HMAC-SHA256(account secret,
  Message("incognitochat/v2/local-id-tag", this device's ID for the
  conversation, id))`, grouped by the UTC day of its `at`. One that comes
  again is dropped before it changes anything. A day is forgotten once
  nothing from it can still be taken in (31 days after the day ends); at
  most 2,000 are kept, the oldest day going first (when the record is
  full, a new one from that day or older is the one left out).
- *Messages deleted one by one*, keyed hashes the same way, in records
  with budgets of their own, so the other side can't push out the user's:
  their messages they deleted (`delete`; by the day of the `delete`'s `at`,
  which is no earlier than the message's; at most 1,000), their messages
  the user deleted on this device, singly or with the whole conversation
  (by the day of the message's `at`; at most 5,000), and the user's own
  messages deleted on this device (at most 1,000). Such a message is
  dropped if it comes, and an edit or reaction for it isn't kept for later.
  If the record of their messages the user deleted overflows, their
  messages up to the end of the day the oldest went from are dropped
  instead, for 31 days; nothing is dropped by time for the user's own.
- *Cleared up to*: a time on the other side's clock up to which everything
  of theirs is gone for both sides: their `delete` with `all`, or ours
  (then the time of their newest message ever taken in). Anything of
  theirs sent by then is dropped, and so is a `delete` with `all` from no
  later. Forgotten after 31 days.
- *The newest envelope taken in* from them (its `at` and keyed hash), and
  *the newest of their messages taken in* (its `at` and ID), until it's
  named in a delete for both sides, or they delete it for both sides.

The keyed hashes live apart from the conversation record (the chat list
reads that), one item per conversation and kind, and only the kind that
changes is written; the times, and that one ID, are on the record.

The record of envelopes taken in is the first check, but not the only one:
each kind changes nothing when it comes a second time even without it (once
it's let go, or when another copy of the app took the envelope in). A
`message` it has is dropped, and so is one deleted or cleared (above); a
receipt only ever marks messages seen; edits and reactions keep the latest
by `at`; a `delete` deletes what's already gone; a `delete` with `all` from
no later than the time the conversation is cleared to is skipped.

*Which key and mailbox.* The other side's key (`from`), the mailbox to write
to (`reply`) and `last` are taken only from an envelope newer than the
newest taken in: by `at`, and of two from the same second the one taken in
last (but never a message dropped as deleted or cleared: it was sent
before what deleted or cleared it). An older one coming late or again
can't move the recipient back to an older key or mailbox. A conversation
from before this was kept starts from the newest of the other side's
messages it has.

*Deleting the whole conversation for both sides.* The deleting app names in
`last` the newest of the other side's messages it ever took in (also one it
has since deleted on its own side, but not one they deleted for both sides:
then their newest message it has), deletes theirs up to that one and its
own up to the `delete`'s `at`, and from then on drops whatever of theirs is
sent by that time. Anything that arrives meanwhile stays. `at` is the
sender's clock, and the two sides' clocks may differ, so the recipient
never compares the `delete` with its own times. It deletes:

- the sender's messages with `at` up to the `delete`'s `at` (their clock
  against their clock);
- of its own messages, those up to the newest one the sender is known to
  have had when it deleted (its own clock against its own clock). Known
  from the `delete`'s `last`, or from a receipt, a reaction, a reply or a
  `last` of the sender's with an `at` no later than the `delete`'s; one
  such receipt that arrives after the `delete` still counts.

What such a receipt can take is bounded twice, by the recipient's own
clock, since the sender's may have been set back since its delete and then
dates anything it sends before the delete (a receipt, a reaction, a reply,
or `last` on any envelope, even a message itself dropped as sent before
the delete):

- if the `delete`'s `last` names one of the recipient's messages, nothing
  newer than that one: the sender names the newest of the recipient's
  messages it had, so a newer one was still on its way when it deleted,
  reached it after the delete, and stays there;
- nothing the recipient wrote after it took the `delete` in.

So both sides keep the same: what the sender wasn't known to have had
hadn't reached it, and it keeps it when it arrives, since it drops from
the other side only what its `last` covered. Two cases are left. A sender
from before this version names in `last` its newest message from the
recipient that it still has (or the last thing it took in), which may be
older than others it had: those stay on the recipient's side though the
sender deleted them, a leftover, never a loss (it ends once the sender's
app is updated, on its next reload). And when `last` names none of the
recipient's messages (a receipt, or one the recipient deleted), only the
second bound applies: a message written before the recipient took the
`delete` in that was still on its way to the sender can then be taken
here after the sender's clock was set back, though the sender keeps it.
Both bounds trust the recipient's own clock not to go back: if it ran
ahead and was set right after the delete was taken in, a message written
since can look written before.

A `delete` with `all` from a version before this one names in `last` the
last envelope it took in, often a receipt: when that isn't one of the
recipient's messages, only the sender's receipts, reactions and replies
from before the `delete` say what it had, and messages of the recipient's
it had without any of those stay on the recipient's side. The other way,
a version before this one that receives a `delete` with `all` deletes
everything in the conversation, both sides', including what it wrote
after the `delete` was sent.

*Deleting the conversation on this device only* deletes everything here and
remembers each message here, one by one (above): what comes again is
dropped, but nothing is dropped by its time (unless more than 5,000 of
theirs were deleted here within 31 days, above), so anything of theirs not
taken in yet still arrives and brings the conversation back.

*Clocks set back.* A sender whose clock ran ahead and is set right sends
envelopes that look older than what came before. Since `at` comes from the
server's clock, this is left to devices whose own clock is more than a
minute off, and to versions before this one. Its key or mailbox change
is taken up only once its clock passes the newest time already taken in,
at most about a day later (envelopes dated further ahead are dropped);
meanwhile the recipient writes to its older key, which it still has, and to
its older mailbox: if that one was discarded (an unblock moves to a new
one), what the recipient sends then is lost. And once a conversation is
cleared for both sides up to a time on the other side's clock (their
delete's own `at`, or, for a delete we sent, the time of their newest
message we had), their messages dated up to it are dropped: if their clock
ran ahead and was set right, their new messages are dropped until it
passes that time. Deleting on this device only drops nothing by time (but
past the 5,000 above). A `delete` with `all` of theirs is skipped when it's
no later than the time the conversation is cleared to, also when that came
from a delete for both sides of ours: if their clock ran ahead when we
took in their newest message and was set right since, a later delete of
theirs looks older and is skipped, and what we wrote after our delete
stays here, though their delete takes it on their side.

Deletes that versions before this one kept by ID (for messages not here
yet) become keyed hashes when something next comes in that conversation,
when the conversation or a message in it is deleted, or at upkeep.
Messages deleted before this version have no record: until they're 31 days
old, a server that kept them could still deliver them again.

**Who writes with which key.** A first message through a link comes from a
fresh conversation key of the sender and is written for the link's current
encryption key. The owner's first reply comes from a fresh conversation key of
the owner and carries its reply mailbox; from then on each side writes for the
other's latest conversation key. Seen receipts and deletes the owner sends
before replying come from that key too but carry no mailbox: the sender
writes for the owner's key from then on, still to the link's intro mailbox,
until the owner replies. So a conversation the owner only reads or deletes
takes none of the owner's mailboxes. Both sides rotate their own conversation key
about weekly, each conversation on its own schedule.

## Key rotation

Encryption keys are replaced about weekly and old private keys deleted, so a
key stolen later can't open envelopes someone kept from long before.

- **Our conversation key:** every 6 to 9 days, on each conversation's own
  random schedule, the next message or receipt in it comes from a new key
  (its `from`); nothing is sent just to rotate. Not before the other side has
  written to us, since until then they know us by our first key alone.
- **A link's encryption key:** every 6 to 9 days, when the app opens, the
  owner publishes a new key (`PUT /links/{id}/keys`); the bundle then lists
  only the new key. A sender the owner hasn't answered yet fetches the bundle
  again before writing if the key it has is over an hour old. The new key is
  indexed before it's sent, and kept if the answer is lost (Links, A lost
  answer), so first messages to it open even if the server took it unheard.
- **Deleting old keys:** an old conversation key is deleted 35 days after the
  other side first writes to the new one; an old link key 35 days after it is
  replaced (or after the link is). Undelivered envelopes expire after 30 days,
  so nothing that can still arrive is written for a deleted key. If the other
  side never writes to the new key, the old one stays.
- Blocking keeps a conversation's keys, so it can be undone.

Rotation is invisible to users: labels come from sender tags, not keys, and
the history kept on the device is sealed under the device's storage key.

## Delivery

The server routes by **mailbox** (16 random bytes), never by account. It knows
each mailbox's owner, to deliver, but not who writes to it.

- Each link has an intro mailbox, listed in its bundle (`mailbox`); first
  messages go there. Clients keep a small pool of further mailboxes
  (`POST /mailboxes`, up to 10 a request, 100 a day per Telegram user and
  4,000 in all per account) and take one when a conversation needs it. A
  take that leaves the pool low has it topped up at a random moment after,
  so creating one happens right before a send only rarely: when more chats
  start in one burst than the pool holds, or a top-up failed (offline, or
  the day's mailboxes used up) or didn't run (the app closed first). Once
  the account holds 4,000 (`409 mailbox_limit`), the app stops topping the
  pool up until it blocks someone, which discards a mailbox (deleting a
  chat doesn't), and says so when a chat can't be started or answered.
- `POST /send {mailbox, envelope, token | tokens, quiet?}` needs no login,
  only send tokens: as many as the envelope costs, one per started 2.5 KiB
  (Send tokens, below), so one for all but long texts. The server checks
  the envelope's layout, the tokens and the caps, then stores the envelope
  once for each of the owner's devices. Unknown and discarded mailboxes go
  through the same steps, for an account that doesn't exist: the same
  reads, the same write of the same size, which goes to a placeholder of
  the envelope's size that holds nothing (it's overwritten with zeros each
  time, so it costs the same and keeps nothing), and the same request for
  a push (below), for nobody. They get the same `200 {}`, and fail the same
  way when the database does. Only a link's intro mailbox also counts the
  link's first messages; the sender knows whether it writes to one, and a
  link that is gone says so itself. `quiet` sends (seen receipts,
  reactions, edits, deletes and key updates) trigger no notice.
- `GET /inbox` returns a page of a device's undelivered envelopes in no
  meaningful order, each with the mailbox it came through
  (`{id, mailbox, envelope}`): the app takes an envelope in only through the
  mailbox it belongs to (Inner message). A page holds at most 50, about
  128 KiB as stored, and no more than one confirmation may claim (300 write
  units, below), so a page of the largest envelopes holds 15. If there are
  more, it says so (`more`) and where the next page starts (`next`, for
  `GET /inbox?after=<next>`); a page can be empty and still have more after
  it, past envelopes that expired.
  `POST /ack {ids}` deletes the ones the device has stored, at most 50 at
  once, by the IDs `GET /inbox` gave them. Each such ID carries a MAC by the
  server, for that device, over the envelope's key, what deleting it costs
  and the hour it was listed in. IDs the server didn't hand out, and a batch
  that claims more than 300 write units, are refused (`bad_request`) before
  anything is deleted. An ID is good in the hour it was listed in and the
  next (one to two hours); an older one is taken but deletes nothing, and
  the envelope is listed again under a new one. Listed again within the
  hour, an envelope has the same ID, so the app skips what it has just
  confirmed (the server's reads can lag a moment). If some deletes fail,
  the answer lists their IDs (`retry`), and the app sends only those again.
- **Limits on fetching and confirming.** The database charges for what each
  fetch reads and each delete writes, even of an envelope that isn't there,
  out of capacity everyone shares.
  - Each device's fetches may read 300 read units a minute (one unit is
    8 KiB: about 2 MiB as stored). A fetch that reads nothing, such as of an
    empty inbox, isn't counted; one whose first read (two envelopes) is all
    there is counts what it read, at least 10; one that reads on first takes
    what a page can cost at most (57 units) from the minute, before reading
    on, and gives back what it didn't use. An instance of the server that
    knows nothing of the device's minute yet reads its count first, and one
    that lately needed a page for the device takes the next before reading
    anything. Past the minute, the server answers `rate_limited`.
  - Each person's (Telegram user's) fetches may read 50,000 units a UTC day,
    counted by what they read, and refused fetches that read or wrote
    anything at least 10 each, in batches of about 50 on each instance; each
    instance asks for the day's count at least once a minute. Past it, the
    server answers `daily_limit`, with `Retry-After` until the day ends.
  - A confirmation may claim at most 300 write units (a small envelope is
    one, a larger one one per started KiB): a page never claims more.
    Confirming envelopes that are there isn't otherwise limited: they were
    delivered, and their senders paid for that with tokens, by size. Confirming
    envelopes that aren't there (any more), or with IDs too old, is limited
    per person to 1,000 a day (UTC), as many as a day's send tokens; past
    that, confirmations delete nothing until the next day, and the
    envelopes are listed and confirmed again then. A confirmation starts no
    more deletes once 5 missed (so at most 14 miss, with 10 at a time); the
    rest are taken without deleting.
  - If the server can't reach its counters, each of its instances lets a
    device read one page a minute, and confirm 50 envelopes that aren't
    there, without counting the day.

  These are per device, however many instances serve it, except where
  said: fetches that start at once on instances that know nothing of the
  minute yet each read their first two envelopes (at most 5 units) or try
  a write before most are refused, and the day's counts let an instance
  that hasn't written its batch, or hasn't asked lately, serve a little
  past them.

  The app syncs one at a time, and once more for whatever asked meanwhile
  (pushes, polls, being shown). It reads at most 10 pages a sync, and the
  next sync carries on where it stopped (from the start after an error).
  What it couldn't confirm (a network or server error, or deletes to try
  again) it keeps and sends again in a later sync; what the server refuses
  for good (`bad_request`) it drops, and those envelopes come again under
  new IDs. Once three pages wait to be confirmed, it stops reading until
  they are. Told `rate_limited`, it waits 30 to 60 seconds and then syncs,
  from the page it was refused at, whether or not a push came meanwhile;
  told `daily_limit`, it waits until the next UTC day. A pause longer than
  that (the device's clock was set back) is over. When a sync gets no
  answer, a server error (`503 unavailable`, say) or a `429`, the syncs the
  app asks for by itself (the poll, pushes) wait: half to all of 20
  seconds, twice as long after each such failure in a row, up to 5
  minutes, and at least the server's `Retry-After`; whatever asked
  meanwhile becomes one sync when the wait ends. Being shown still syncs at
  once, and a sync that gets through ends the wait, as do the push socket
  opening and the device coming back online, which sync at once too. No
  answer while the device says it's offline doesn't count. An envelope the app
  can't take in yet (its chat is busy, or its link can't be asked now)
  stays unconfirmed, and the walk goes past it. Undelivered envelopes
  expire after 30 days.
- **Push:** an open app keeps a WebSocket (`new WebSocket(url, ["v1", token])`,
  the session token as the second subprotocol, never in a URL). After a
  delivery the server sends the owner's open sockets `{"t":"sync"}` and nothing
  else; the app then fetches its inbox. The Telegram notice goes out only if
  no socket took the push. Receipts are pushed but never noticed. The app
  sends a heartbeat about every 5 minutes, keeps the socket only while it's
  visible, and replaces it with a new one about every 30 minutes.

  `/send` doesn't wait for the push: the `api` function hands every send to
  the `ws` function in an asynchronous invoke (`{"push":{"account","quiet"}}`,
  with an empty account for a mailbox that doesn't exist) and answers. `ws`
  pushes, and, if no socket took it and the send isn't `quiet`, asks
  `notify` for the notice, without waiting either. So how long a send takes
  says nothing about whether the recipient's app is open. A push is tried
  once: not again after a failure, and not at all if it waited a minute for
  `ws` to have room (the app also polls, every two minutes while its socket
  is open). It usually reaches the app a few tenths of a second after the
  answer; `api` can't post to sockets, and `notify` can't see them.

  The server doesn't hear when a socket closes. It keeps a record of each
  socket (a keyed hash of the account, not its ID; the connection ID; and
  when it expires: 40 minutes after the minute it opened, rounded up to the
  minute) until a push finds the socket closed, a later connect needs the
  place, the account is deleted, or a connect or push finds it expired; the
  key is derived from the session key, which `api` and `ws` hold. DynamoDB's
  TTL can take days to delete
  an expired record, which is never used. A socket an app keeps open longer
  than that (an older app that doesn't replace it) gets no pushes, and the
  app polls. A delivery is pushed to the account's most recently opened
  sockets first, 5 at a time, passing over closed ones (each found closed is
  forgotten), until 5 have taken it. An account can open about 5 sockets a
  minute (UTC minutes) and keep about 10 records; more connects are refused,
  and the app tries again later, polling meanwhile. These are about, not
  exact: connects at the same moment are checked against what each read
  before writing. A connect at 7 records forgets the oldest, which may be of
  a socket still open; that one gets no pushes until its app replaces it.
  The app opens the replacement before closing the old socket, and keeps the
  old one if the replacement is refused, trying again after about 1, 2,
  then every 4 minutes. A socket that closes is reopened after about a
  second, then twice as long each time, up to a minute.
- `POST /mailboxes/{id}/discard` ends a mailbox (a block, or an ended
  conversation); a link's intro mailbox ends with the link.
- `POST /mailboxes/check {ids}` (at most 1,000 IDs) returns which of the
  given mailboxes aren't the caller's (any more). At upkeep, at most once a
  day, the app drops those from its pool and
  gives conversations that used one as their reply address a new one, which
  their next message carries. Nothing is stored.
- **Blocking** discards our mailbox for the conversation and, for someone who
  wrote to our link, remembers their sender tag (by link fingerprint), so new
  conversations from them are dropped too. Silent: their sends still look
  accepted. **Unblocking** forgets the tag and, if we had a mailbox, sends
  them a quiet `key_update` from a new mailbox (and a new key if ours is
  gone), so their app writes there from then on; until that has gone out, the
  conversation stays blocked, and unblocking again sends it. What they sent
  meanwhile is lost. Only `message` sends trigger a Telegram notice.

## Media

Attachments travel outside the envelope, encrypted, through an S3 bucket.

- The app encrypts the file with a fresh key, pads it, and asks
  `POST /media {size, deleteHash, tokens}` for an upload URL. No login: it
  pays with media tokens, one per started MiB. `size` must be a padded size
  (below): 16, 32, 64, 128, 256 or 512 KiB, or 1 to 51 whole MiB; any other
  is refused with `bad_request` before a token is spent. `deleteHash` is the
  SHA-256 of a random delete secret. The answer is `{id, url}`, and the app
  PUTs exactly `size` bytes of ciphertext to `url` with the headers
  `Content-Type: application/octet-stream` and `If-None-Match: *`. The
  length and both headers are part of the URL's signature.
- An upload URL writes once and starts within a minute. S3 refuses a PUT
  once the upload exists (412), and a PUT that starts more than a minute
  after the URL was signed (S3 checks when a request starts, so a long
  upload that started in time finishes). The bucket also refuses any PUT
  that creates an object without `If-None-Match`, and any presigned request
  whose signature is over two minutes old. So an upload can't be replaced
  after it was sent.
- **Trying again.** If a PUT fails, or sends nothing for 60 seconds, the
  app tries again, up to four tries in all, waiting 2, 10 and 30 seconds,
  with no new tokens. Before each later try it asks
  `POST /media/{id}/upload {secret}` (the delete secret; no
  login); if that request can't get through, or the server fails, that try
  counts as failed too. The
  server checks the secret, then looks in the bucket: if the upload is
  stored (an earlier try wrote it and only its answer was lost), it answers
  `{uploaded: true}` and the app counts the upload as done; otherwise it
  answers a fresh `{url}` for the same upload and size. It answers at most
  3 times per upload, and only in the 3 hours after `POST /media`; past
  that, and for an unknown upload or a wrong secret, it answers
  `not_found`, and the app marks the message failed. A 412 to any try also
  means the upload is stored. The recipient's message carries the delete
  secret too, so the recipient can ask as well; with the upload stored, it
  only ever learns that. Once the upload is deleted, no URL is given for it
  again; only one given less than a minute before could write it back
  (where the bucket's 30-day expiry still removes it).
- The app runs two uploads at a time and asks for an upload's URL only when
  its turn comes, so a URL doesn't age out while it waits behind other
  transfers to the bucket.
- **Deleted while it goes out.** A message of ours deleted on this device
  (alone, or with its conversation) before it's sent isn't sent. Before
  sealing it, under the conversation's send lock (which deleting takes
  too), the app checks that it's still there and still sending; if not, it
  stops before taking a mailbox or showing any token to the server. An
  attachment deleted before its upload starts isn't uploaded or paid for;
  one deleted while it uploads is deleted from the server once the upload
  is done, or has failed (`POST /media/{id}/delete`, as for a received
  one), and no error is shown for it. The server looks uploads up from a
  copy that can lag a moment behind, so for these the app takes a first
  `not_found` as "not yet" and asks once more about 30 seconds later (or
  on the next start).
- **Failed after the upload.** If its message surely didn't go out (it
  failed before it could, or the server refused it with a `4xx`, or there
  were no tokens or no mailbox to send it with), the upload is deleted the
  same way. After any other failure (no answer, a `5xx`) the message may
  have arrived, and the upload stays for the other side to fetch.
- The message carries the attachment in `media`, inside the encrypted
  envelope: kind `t` (`photo`, `video`, `gif`, `voice`, `audio` (music),
  `round` (a video message) or `file`), upload ID `id` (16 bytes),
  AES-256-GCM key `k` (32 bytes), delete secret `d` (16 bytes), the file's
  size `s` (at most 50 MiB), and optionally its name `n`, MIME type `m`,
  pixel size `w`/`h`, length in seconds `l`, a voice message's waveform `v`
  (base64url of 1–100 bytes, one bar each, 0–255) and a tiny JPEG preview `p`
  (base64url, at most 3000 characters). The server never sees a key, name or type. A kind the
  recipient's version doesn't know (lowercase letters and `_`, at most 16)
  is accepted and shown as a file.
- **The name** `n` is any 1–255 UTF-16 units, and taken in as it is: a
  message refused for it would be acked and lost. Where it's shown, shared
  or saved (the save page too), the recipient cleans it first: bidi
  controls (U+200E/F, U+202A–202E, U+2066–2069, U+061C), the byte-order
  mark and C0/C1 control characters go, line breaks and tabs become a
  space, and `/` and `\` become `_`; ZWNJ and ZWJ stay. So
  `photo<U+202E>gpj.exe` shows and saves as `photogpj.exe`, not as
  `photoexe.jpg`. A name with nothing left is replaced by one made from
  the kind and type, as for no name. The save page, whose link anyone can
  make, also cuts a longer name to 255.
- What each kind is: a photo is redrawn on the sender's device (at most
  1280 px, JPEG), which drops its metadata. A video is sent as recorded (no
  compression), with most location, device and time metadata removed: the
  MP4/QuickTime `udta` and `meta` boxes (at the top level, and in the
  movie, its tracks, their media, media information, sample tables and
  edit lists), the `uuid` boxes of XMP and of Sony, Canon and Garmin
  cameras wherever they are, and every top-level `uuid` box are renamed
  `free` and zeroed; `free` and `skip` boxes are zeroed (unless a chunk
  offset points into one, or the file is fragmented or has part of a track
  the app can't read); and the times in the movie, track and media
  headers, a QuickTime preview (`pnot`) and producer reference times
  (`prft`) are zeroed, so nothing else in the file moves. Timed metadata
  tracks (a camera's GPS or timecode track) are kept, and a video the app
  can't read is sent as it was. A GIF is sent as it is, with any metadata
  in it.
  A voice message is recorded in the app (AAC in MP4 where the browser can,
  else Opus in WebM or Ogg; at most 15 minutes), with a waveform taken from
  the microphone level while recording (or from the recording, where the
  level couldn't be read); it carries no device or place metadata. A video
  message is recorded in the app too: the camera's picture cropped to a
  384 × 384 square (mirrored for the front camera, as the sender saw it),
  with sound, as H.264 in MP4 where the browser can, else WebM; at most a
  minute, with a preview frame and no device or place metadata. Music is the
  audio file as it is (its tags included), with its length. A file is the
  original bytes, untouched (location included, if it has any).
- **Fetched by itself.** Photos up to 5 MiB, and voice and video messages
  and GIFs up to 10 MiB, by the size `s` their message gives, are fetched
  when their conversation opens (each kind can be turned off); larger ones,
  and videos, music and files, on a tap. The limits leave room above what
  the app sends: a photo of at most 1280 px as JPEG stays under its raw
  pixels (4.7 MiB); 15 minutes of voice at 48 kbit/s is 5.1 MiB, and a
  minute of video message at about 650 kbit/s 4.6 MiB.
- **Shown in the chat.** Only JPEG, PNG, WebP and GIF images are shown as
  photos or GIFs: one of any other type (an SVG, which can carry script, or
  none given) is shown as a file, whatever kind the sender says. To show or
  play a decrypted file, and on the save page, the app gives the browser
  the sender's type only for those images, audio and video; anything else
  is plain bytes (`application/octet-stream`).
- The upload is `nonce (12) ‖ AES-GCM(k, nonce, file ‖ zeros, aad =
  "incognitochat/v2/media")`, padded to the next power of two from 16 KiB up
  to 1 MiB, then to the next whole MiB.
- The recipient gets a download URL with `GET /media/{id}` (no login; the ID
  is the permission; at most 5 a day per file, counted when the URL is
  given, so a download that then fails uses one up), fetches and decrypts
  the file and keeps it on the device. The URL starts a download within a
  minute, and S3 answers it with `Content-Encoding: identity` and type
  `application/octet-stream` whatever the upload claimed, so no browser
  unpacks a compressed upload, and with `Cache-Control: no-store`, so no
  browser keeps a copy of the ciphertext in its cache (all three are in its
  signed query). The app fetches it with `cache: 'no-store'` too. The app reads
  at most the padded size of `s`: it stops at once if `Content-Length` says
  otherwise or more bytes arrive, and refuses a shorter answer. It gives up
  on a download that gets no answer, or no more bytes, for 30 seconds. The
  upload stays, downloaded or saved, until the
  message or conversation is deleted on the recipient's device (then it's
  deleted with `POST /media/{id}/delete {secret}`) or it expires.
- **A download that fails.** One of another size, one that doesn't decrypt
  with `k`, and one the bucket refuses (S3 answers 403 or 404 for a file
  never uploaded, but also for a download URL that expired before it was
  used, as when the app was put to sleep in between) mark the attachment
  broken: it's fetched again, with a fresh URL, only on a tap. One the
  server doesn't know (`not_found` from `GET /media/{id}`: expired or
  deleted) is gone. Any other failure (the server or the bucket out of
  reach, failing, busy or refusing, or the device too full to keep the
  file) leaves it to fetch: after each, fetching by itself waits one to two
  minutes, and it tries one attachment at most three times in a run of the
  app; then a tap. Paused downloads don't count toward the three.
- **Saving outside Telegram.** A Mini App can't hand a file to the device
  (Telegram's download needs a public HTTPS URL, which would mean a decrypted
  copy on a server). Where the app has a share sheet, it uses that.
  Otherwise it opens `<site>/#save=<base64url(JSON {id, k, s, n?, m?})>`
  in the device's own browser: the part after `#` is never sent to any
  server, and the page removes it from the address at once. That page
  fetches and decrypts the upload and offers it as a normal download. It
  doesn't delete the upload, and the link carries no delete secret. The
  link may stay in the browser's history; once the upload is gone it opens
  nothing.
- Uploads expire after 30 days. The bucket keeps no
  versions and no access logs.
- **Paused.** The operator can pause uploads or downloads for everyone
  (the emergency switches; [deployment.md](deployment.md#emergency-switches)).
  While uploads are paused, `POST /media` answers `503 uploads_paused`
  before looking at any token, so none is spent. `POST /media/{id}/upload`
  checks the secret and the bucket as usual, so a stored upload is still
  answered `{uploaded: true}`, and answers `503 uploads_paused` only instead
  of a fresh URL (the try counts as one of its 3). While downloads are
  paused, `GET /media/{id}` answers `503 downloads_paused` before counting
  the download. A change reaches every server within about 30 seconds, and
  a server that hasn't yet read the switches counts both as paused. The
  app doesn't try again by itself: it puts the tokens back in its wallet and
  marks the message not sent, saying why; Try again in its menu sends it,
  as a new attachment, if it was never uploaded. A paused download stays to
  fetch: the app fetches nothing by itself for two minutes, then tries again
  when the chat next opens or a message arrives, and a tap says it's paused.

## Stickers

Stickers come from the app's own packs, built into the app (web/public/stickers:
Microsoft's Fluent Emoji, MIT licensed). Sending one uploads nothing: the
message names it, `sticker: {id, e?}`, where `id` is `pack/name` (lowercase
letters, digits and `_`; pack at most 32 characters, name at most 40) and `e`
the emoji it stands for (at most 16 UTF-16 units). A sticker the recipient's
version doesn't have, from a newer pack, shows as that emoji if it's one
emoji (as a reaction's `e` must be), else as a generic sticker sign. There are no
Telegram sticker packs: a Mini App can't reach them, and fetching them
through the bot would tell the server who uses which.

The images are files of the app's build (`stickers/<pack>/<name>.webp`).
The app fetches all of them at once when a conversation opens, not when a
sticker is shown or sent, so the host serving the app learns nothing about
stickers from it.

## Notices

The bot can tell someone that a message is waiting: a generic "New message"
with a button that opens the app, never who wrote or what. `notify` holds
the bot token to send notices, and `bot` holds it too, used only when the
deploy sets the bot up (its webhook, menu button and command).

- The app turns notices on with `POST /notices {initData}`, sending its
  Telegram launch data. The server accepts only a plain launch or a
  registration launch, never one whose `start_param` names a link or an
  invitation, and only for the account's own Telegram user. It keeps the chat
  ID sealed (AES-256-GCM under a key only `notify` has) and the notice
  language, nothing else. The bot needs permission to write first; the app
  asks Telegram for it. `GET /account` says whether notices are on, and the
  app sets them up again when they're off.
- After each delivery that isn't `quiet` and that no open app took (Delivery,
  Push), `ws` asks `notify` to send the owner a notice, without waiting.
  `notify` sends at most one every 3 minutes per account (its quiet period is
  stored under a keyed hash of the account, with a key derived from the chat
  key), and deletes the previous one, so the chat holds one notice at most,
  besides older ones Telegram no longer let it delete (below).
  If Telegram refuses (the bot is blocked), notices turn off.
- In order: `notify` reads the account's notice settings, then starts its
  quiet period for 30 seconds (rounded up to the minute), longer than it
  can run, with a conditional write, so of two deliveries at once only one
  goes on. The row holds a random token, and only a write naming it can
  change the period later, so a late one can't end a newer period. It
  sends the new notice; once that went out, the quiet period is set to 3
  minutes from then, the new notice's message ID recorded, and the
  previous notice deleted. Telegram lets bots delete their messages only
  for 48 hours, so an older one stays in the chat. If the send fails,
  nothing is deleted or recorded, and:
  - refused outright (other than "blocked"), the quiet period ends at once,
    so the next message can notify;
  - with no answer or a server error, the notice may have gone out, so the
    30 seconds run out first: no second notice follows at once that would
    never be recorded or deleted.
- Telegram's flood control (about 30 messages a second per bot, one a
  second per chat) answers 429 with `parameters.retry_after`, in seconds.
  `notify` waits that long and tries once more if it's at most 3 seconds
  and the invocation has time left for it. Otherwise, or if it's refused
  again, it drops the notice: the account's quiet period runs as long as
  Telegram asked, at least a minute, and that function instance tries no
  notice to anyone until Telegram allows, without calling it. Failed
  notices aren't retried later (Lambda's retries are off): a late notice
  is little use, and retrying into a flood only adds to it.

What this tells the server: that an account has a Telegram chat, which it
already knows from registration, and when the account gets messages, which
delivery already tells it. Quiet sends tell it which deliveries are seen
receipts, though not whose. Telegram learns when someone gets messages, in
3-minute steps.

## Send tokens and media tokens

Every `POST /send` spends anonymous send tokens, one per started 2.5 KiB of
envelope, and every upload one media token per started MiB, so the server
can limit both, by what they cost it, without learning who sends. Tokens
are RSA blind signatures (RFC 9474,
RSABSSA-SHA384-PSS-Deterministic) in the shape of Privacy Pass token type 2
(RFC 9578):

```
token     = u16(0x0002) ‖ nonce (32) ‖ challenge (32) ‖ key ID (32) ‖ authenticator (256)
challenge = SHA-256(Message(label, [0x01], u64(epoch)))
label     = "incognitochat/v2/send-token" or "incognitochat/v2/media-token"
key ID    = SHA-256(issuer public key as SubjectPublicKeyInfo, DER)
epoch     = floor(unix seconds / 604800)
```

The authenticator is an RSA-PSS signature (SHA-384, MGF1-SHA-384, 48-byte
salt) over the first 98 bytes, by a 2048-bit issuer key. A logged-in device
blinds token inputs, gets them signed, and unblinds them; the issuer never
sees the tokens it signs:

| Kind | Route | A request | A day (UTC) |
|---|---|---|---|
| Send tokens | `POST /tokens` | at most 50 | 1,000: everything a person (Telegram user) sends (messages, receipts, reactions, edits, deletes), by size (below) |
| Media tokens | `POST /tokens/media` | at most 50 | 500: 500 MiB of uploads |

A request is `{"blinded": [<blinded token input>, …], "keyId": <issuer key
ID>}`, each in base64url, and is answered `{"signatures": […], "left": n}`.
`keyId` names the issuer key to sign with: the one the app's build names
(below). A key the server doesn't hold gets `409 unknown_issuer_key` before
anything is counted, so it costs nothing of the day's budget; a malformed
one gets `400 bad_request`. A request without `keyId` (an app from before
it) was built for the key that was current then, so it is signed with the
oldest key held: the previous one while a rotation lasts (below), the
current one otherwise.

`GET /tokens/keys` (no login) returns the IDs of the issuer keys the server
holds, in base64url: `{"send": [<current>, <previous>], "media": [...]}`,
the previous key only while a rotation lasts. Key IDs are public; the
deploy checks with it that the server loaded the keys it was given.

Each answer also says `left`: how many more of that kind the person may
get today, so the app can say when messages run low. `GET /usage` (logged
in) returns the day's counts for the Usage screen: `{resetsAt, send, media,
mailboxes, linkChanges, owned}`, each `{used, limit}` (`owned`: the
account's mailboxes against the most it may have). The app adds what it
holds unused (tokens fetched ahead, spare mailboxes) to show what's left.
Both only read the counters the limits keep anyway.

The two kinds have different issuer keys. A blind signer can't see what it
signs, so only a key of its own gives a kind its own daily budget; a token
of one kind is refused where the other is asked for.

The server signs with the Chinese remainder theorem, in constant-time
arithmetic (`filippo.io/bigmod`, the code Go's `crypto/rsa` uses), about
twice as fast as a plain `m^d mod n` on the functions' arm64 (about three
times on amd64). Each signature is blinded with
a fresh random `r` (it exponentiates `m·rᵉ`), and checked (`sᵉ = m mod n`)
before it is sent, so a fault in the computation, which would give away a
factor of the key, is answered `500 internal` instead. The signatures are
the same bytes as RFC 9474's `BlindSign` (`backend/internal/tokens`, checked
against circl's and the RFC's test vector).

**What a send costs.** An envelope of `n` bytes costs `ceil(n / 2560)` send
tokens, at least one. Storing it costs the database a write unit per
started KiB, as much again to delete it, and reading it a read unit per
8 KiB, so a token buys at most three write units however the envelope is
made up, and a person's day of tokens at most about 3,000. The app's
envelopes (one wrap):

| Inner message padded to | Envelope | What it holds | Tokens |
|---|---|---|---|
| 512 | 663 bytes | short texts, stickers, receipts for a few messages, reactions, deletes, key updates, short edits | 1 |
| 2048 | 2,199 bytes | texts up to about 1,700 bytes (about 850 Persian letters), attachments, receipts for up to 68 messages | 1 |
| 8192 | 8,343 bytes | texts up to about 7,800 bytes | 4 |
| 16384 | 16,535 bytes | texts up to 12,000 bytes | 7 |

The largest envelope there can be (16 wraps, 18,350 bytes) costs 8. The
app names at most 50 messages in one receipt, so a receipt costs one, and
sends one however many messages it marks read (`earlier`, Receipts).

A send pays with one token as `token`, or several as a list, `tokens`
(`token` is taken like `tokens` with one; the app sends one as `token`,
which servers from before sizes were priced take too). The server checks
how many there are and every one of them before spending any:

- none: `401 invalid_token`;
- fewer or more than the envelope costs: `402 {"error": "tokens_needed",
  "needed": <how many it costs>}`. The app sends the same envelope to the
  same mailbox again, once, if `needed` is no more than the largest
  envelope costs: with the tokens it sent (none was spent), as many as
  `needed`, and fresh ones for the rest (fetching more if it has fewer);
  those it no longer needs are dropped (below). So an app from before the
  price changes, either way, still sends;
- both `token` and `tokens`: `400 bad_request`;
- one that isn't a send token of this week or last, or one twice:
  `401 invalid_token`.

It then spends them one at a time, in the order given, and stops at the
first one spent already: the send is refused (`invalid_token`), and the
tokens before that one **stay spent**, so a refused list may have spent
some of its tokens. Fresh tokens can't be sent again and again behind a
spent one; a refusal costs the database a write unit, plus one for each
token it burned, and a server remembers the spent ones it meets, so the
same list refused again costs it nothing. The app drops all the tokens
it sent (it can't tell which was spent) and tries others, until it has
dropped more than the largest envelope costs: older apps put the tokens of
a send whose answer was lost back in the wallet, so one may still hold a
send's worth of spent ones. An app from before envelopes were priced by
size sends one token, whatever the size: an envelope over 2.5 KiB then gets
`tokens_needed`.

**A token goes with one send.** A token the server has seen with an
envelope and a mailbox is never sent with anything else, even when the
server didn't spend it: one token with two sends would let the server tie
them together, and so the mailboxes one anonymous sender writes to,
whatever their IP addresses. Only sending the same envelope to the same
mailbox again (after `tokens_needed`, above) uses those tokens again. After
any other failure (a cap, `invalid_token`, an error, no answer at all) the
app drops them and never puts them back in its wallet, so a lost answer or
a refused send costs its tokens, as a sent one does. Media tokens likewise
are dropped after an upload request that got no answer (they may be spent);
the only ones that go back to the wallet are those of an upload refused
because uploads are paused, which the server answers before spending any (an
upload names no mailbox, so using them again ties nothing anyone receives
to that try).

The app keeps at least 14 send tokens, twice what the longest message
costs. Once fewer are left after a send, it fetches a batch at a random
moment 10 to 90 seconds later, not with the send, since the issuer sees
which account fetches when. Media tokens likewise: once an upload leaves
fewer than 26 (what a 25 MiB file costs), a batch of 30 comes 10 to
90 seconds later. A send or upload that finds the wallet short fetches
right then, as a last resort. A send or upload that has the tokens it
needs never waits for a batch being fetched, so it doesn't go out just
after that request is answered. The server signs a batch whole or not at
all, so when it has said fewer than a batch of send tokens are left today,
the app asks for just those.

A token is accepted in its own week and the next, and only once: the server
remembers spent nonces until then. A send refused by a mailbox's cap (30 a
minute) doesn't spend its tokens, the first time: each token is given back
only once, so one refused there again may stay spent. A send refused by a
link's cap on first messages (60 an hour) spends its tokens. The app can't
tell the two apart (both are `rate_limited`), and drops the tokens either
way (A token goes with one send, above). Clients only accept the issuer keys their build names
(`VITE_ISSUER_KEY`: an entry of `web/issuer-keys.json`, with the send key
and, under `media`, the media key), so the
server can't hand different users different keys to tell them apart.

**Replacing an issuer key.** Replacing a key is the only way to make the
tokens already handed out worthless (after a leak, or to void tokens
stockpiled ahead). While a rotation lasts, the server holds each kind's
current key and its previous one: it accepts tokens of both, each checked
with the key its key ID names, and signs each batch with the key the
request names. So an app still open on a build for the old key keeps
getting tokens it can use, and one built for the new key never gets
old-key tokens. Apps count and spend only tokens of the key their build
names (bytes 66 to 98 of a token are its key ID). They keep any others in
the wallet until those expire, never sending them: a copy of the app on
the other build, on the same device, may be spending them. Once the old
key is retired, a send or upload paid with its tokens (of this week or
last, and of the right kind) is refused with `401 unknown_issuer_key`
rather than `invalid_token`, before anything is spent, and so is a request
for more of them (`409`). An app still on the old build then says to close
it and open it again. While both keys are held, a token shows which of
the two builds its sender's app is on, and `POST /tokens` which accounts
are still on the old one ([security.md](security.md)); the order of a
rotation is in [deployment.md](deployment.md#rotating-an-issuer-key).

## Admin

Admins are the accounts of the Telegram users in `ADMIN_TELEGRAM_IDS`
(recognised by the keyed hash of their ID). Every admin route needs a
logged-in admin, and every change also a device signature
(`X-Device-Signature`); anyone else gets `403 admin_only`.

| Route | Does |
|---|---|
| `GET /admin/levels` | `{levels: [{level, invitations}]}`: the invitation allowance of each level. |
| `PUT /admin/levels {level, invitations}` | Sets a level's allowance (signed). |
| `POST /admin/grant {link, invitations}` | Gives the member who owns `link` extra invitations (signed). |
| `GET /admin/switches` | `{uploadsPaused, downloadsPaused}`: the emergency switches as stored now. |
| `PUT /admin/switches {switch, paused}` | Pauses (`paused: true`) or resumes `"uploads"` or `"downloads"` for everyone (signed), and answers like `GET`. The server answering follows at once, the others within about 30 seconds. |

## Test vectors

| What | Where |
|---|---|
| Labelled messages, P1363 signatures | `backend/internal/devicesig`, `web/src/crypto/crypto.test.ts` |
| Fingerprint | `backend/internal/devicesig`, `web/src/crypto/crypto.test.ts` |
| Device list | `backend/internal/devicelist`, `web/src/protocol/device-list.test.ts` |
| Register, session and request messages | `backend/internal/api/vectors_test.go`, `web/src/account/account.test.ts` |
| Link keys, owner proofs | `backend/internal/links`, `web/src/protocol/link.test.ts` |
| HPKE, AES-128-GCM and AES-256-GCM (the CFRG's `test-vectors.json`; only the AES-128-GCM one is also in RFC 9180 Appendix A, as A.3.1) | `web/src/crypto/hpke-vectors.json` |
| Envelope layout (sealed by the client) | `backend/internal/envelope/testdata` |
| Key ID, envelopes and inner messages from fixed keys and randomness (wrap info, body AAD, message tag) | `backend/internal/envelope/testdata/vectors.json`: `web/src/protocol/vectors.test.ts` seals them again byte for byte, `backend/internal/envelope/vectors_test.go` opens them with Go's `crypto/hpke` |
| Sender tags, ID tags, labels | the same file: `web/src/messaging/secret.test.ts` (all three), `backend/internal/envelope/vectors_test.go` (sender and ID tags) |
| Blind RSA (RFC 9474 Appendix A, PSS-Deterministic) | `web/src/crypto/blindrsa-vectors.json`, `backend/internal/tokens/testdata` |
| Send-token challenge | `backend/internal/tokens`, `web/src/protocol/token.test.ts` |
| Send tokens an envelope costs | `backend/internal/envelope`, `web/src/protocol/envelope.test.ts` |
