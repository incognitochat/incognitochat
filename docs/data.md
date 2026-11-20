# What the software stores

What Incognito Chat keeps, where, and for how long, as this code does it. How
the protections work is in [security.md](security.md) and
[architecture.md](architecture.md).

This isn't a privacy policy. Whoever runs a deployment publishes its policy,
with who runs it, how to reach them, where the data is hosted, and anything
they add, such as payments; this page is the technical part it can point to.
A change to what the code stores updates this page in the same change.

## In short

- Messages and attachments are encrypted on the device. Nobody else can read
  them: not whoever runs the server, not Telegram, not the hosting providers.
- The server doesn't store who writes to whom, or who an anonymous sender is.
- Chats exist only on the user's device. The server can't restore them or hand
  them to anyone, because it doesn't have them.
- The server does see some things it can't avoid seeing, such as IP addresses
  and when messages arrive. They're listed below.

## On the device

Keys, conversations, their history, attachments received or sent, labels, and
blocks, in the app's storage (IndexedDB) in Telegram's web view. The app sends
none of it anywhere in readable form.

History and attachments are encrypted under a storage key, but that key is
kept in the same storage, with the account's other keys. They're
non-extractable WebCrypto keys, which only means code can't read them out: on
Android, Windows and Linux, at least, the web view writes them to disk as
they are. So a copy of the app's storage (an image of the device, say, or of
Telegram Desktop's folder) holds the keys with the data. It opens the whole
history, and can use the account as this device.

When the user deletes the account or sets up again, the app clears all of it
from its storage. Cleared isn't erased: on some systems (Android and Windows
at least, whose web views use Chromium's engine) the cleared keys and records
stay in the storage files until the engine compacts them, which can take a
long time, and with the keys there they can still be read. A copy of the
device made before then may still hold all of it. Real erasure would need a
key kept outside the app's storage and deleted with the account; the app
doesn't do that yet. Everything is also lost if Telegram or the phone clears
the app's storage.

Deleting a conversation deletes its history and attachments; its record
(keys and mailboxes included) stays, out of the list, so it can come back if
either side writes again. Each conversation also keeps what the chat list
shows of its newest message (the start of its text, or what its attachment
or sticker is), sealed under the storage key like the message, until a
newer one replaces it or the message goes. Attachments can also be cleared
on their own (Data and storage); their messages stay, with each file's
key, to fetch it again.
Downloads are marked not to be kept in the web view's cache.

So that a message delivered again, or late, can't undo anything (bring back
something deleted, wipe newer history, or move the app back to an older key
or mailbox), each conversation also keeps, without any content:

| What | How long |
|---|---|
| Which of the other side's envelopes it took in: a keyed hash of each one's ID (made with the account's secret, so it can't be matched to the ID, on the other person's device say, without that), with only the day it was sent; at most 2,000 | Until 31 days after that day ends (removed at the next upkeep, or the next time something arrives in that chat) |
| Which messages were deleted one by one: theirs they deleted (at most 1,000), theirs the user deleted here, singly or with the whole chat (at most 5,000), and the user's own deleted here (at most 1,000); keyed hashes the same way, with the day | The same |
| The time, by the other side's clock, up to which the conversation was cleared for both sides, and for their delete, when this device took it in | 31 days |
| Only if the user deleted more than 5,000 of their messages in a month: the end of the day up to which their messages are dropped | 31 days |
| The time, by the other side's clock, and keyed hash of the newest envelope it took in | While the conversation is kept |
| The time of the last thing this device sent in it, to the second, so the next is dated after it | Until the chat is deleted (here or for both sides), and with the conversation |
| The envelope ID (random) and time, to the second, of each of the last 10 things this device sent in it (messages, receipts, reactions, edits, deletes, key updates), so what the other side writes naming one as the newest of the user's it had shows after it | Until the chat is deleted (here or for both sides), and with the conversation; each until 10 newer ones were sent |
| The time and ID of their newest message it took in | Until a delete for both sides names it, or they delete it for both sides; otherwise while the conversation is kept |
| For a received message, when it was sent by the other side's clock, if it shows at another time (their clock ahead of ours, or behind what it names, such as the message it answers, or their previous message); for a sent one, the earliest time (their clock) something of theirs showed they had it; sealed like message text, for a sent one that was sent again, when it was first tried, and for a sent attachment, when its upload was made (to send it again with that upload while it lasts) | With the message |
| A reaction that arrived before its message, sealed like message text | Until the message arrives, or 31 days |
| An edit that arrived before its message, sealed like message text: at most 20 per conversation, 64 KB in all (the newest); in conversations started through the user's link that they haven't answered, 64 KB across all of them (those an edit came to most recently) | Until the message arrives, or 31 days; in a conversation the user hasn't answered, until they delete or block it |
| A conversation started through the user's link that they never opened or answered, with no messages (its first message was dropped, deleted or cleared before it came, or the sender cleared it for both sides): its record, out of the list | 31 days after the newest envelope it took in |

And, before a conversation through the user's link has started, the
sender's edits, reactions and deletes that overtook its first message,
sealed like message text, in one store for all: at most 50 edits and
reactions, 64 KB in all, and apart from them at most 50 deletes, 32 KB in
all (past either, the oldest of that kind go). Each is kept until its
message arrives (then it's taken in, like anything else in that
conversation), or until 31 days after it was sent.

The keyed hashes and the edits are kept apart from the conversation itself
(one item per chat and kind), so the chat list doesn't read them.

## On the server

| What | Why | How long |
|---|---|---|
| A random account ID, and a keyed hash of the user's Telegram ID (not the ID itself). The hash hides the ID only from someone without the server's key: whoever holds the key, such as the operator, can hash every possible Telegram ID in minutes, and so tell which Telegram user each account belongs to | One account per Telegram account; daily limits | While the account exists |
| The account's and its device's public keys | To check logins and requests | While the account exists |
| The month, UTC, the account was last used (`2026-11`, say): nothing finer, not the day, not how often. On the account, and in an index of accounts by that month, which holds the account ID and the month alone | So that, where the operator has turned it on, accounts nobody uses any more are deleted ([below](#accounts-nobody-uses)). Kept while it's off too, so turning it on later doesn't take accounts in use for unused | While the account exists. Replaced at the first login of each month (the app logs in each time it's opened) |
| Only for accounts set up before the server stopped storing it: the account's first signed device list (its device's ID and public key, and the hour the account was set up). Accounts set up since have their list checked at setup and not stored | Nothing reads it | Until the account is replaced or deleted |
| The user's Telegram chat ID, encrypted so only the notice service can open it, their language, and the Telegram message ID of the latest notice (so the next one can replace it) | To send "New message" notices, if the user allows them | While notices are on. When Telegram refuses a notice (the user blocked the bot, say), they're marked off, and all three are deleted the next time the app opens (if it never opens again, they stay until the account ends: where the operator has turned it on, at the latest when it's deleted for going unused, [below](#accounts-nobody-uses)). The app then doesn't turn notices on again by itself: it offers to, and only the user's tap (Turn on notices) stores the chat ID and language anew |
| The account's link: its ID, its public keys, its first-contact mailbox | So people can write to the user | Until it's replaced or deleted, or the account ends |
| The ID of every link that was replaced or deleted, or ended with its account, with nothing else (a few bytes each, naming nobody). Only links that went once the server started keeping these: the IDs of earlier ones weren't kept, and can still be taken | So nobody can make a new link with an old link's ID: whoever opens the old link is told it's gone, not shown someone else's | For good |
| Each link signing key the account has used: the key's fingerprint and the account ID, kept apart (by fingerprint) and in the account's own records. While its link has the key, the link already says both (its owner, and its signing key, whose fingerprint anyone can work out); after a revocation, or a move to another key, the account keeps the key for a later link | So no two accounts' links ever share a signing key, which would let their owners match a sender who writes to each of them by the tag the sender's app adds | While the account exists. When it ends, the account ID goes from it (at once for its current link's key, the rest with the steps below), and the fingerprint stays for good, as a tombstone naming nobody: one small item for each signing key ever used, so that no account can take the key up later and match its senders' tags with the ones the ended account saw |
| Mailboxes: random IDs, and which account they belong to | To deliver messages | Until they're ended, or their account is deleted or replaced: they take nothing from that moment, and go in steps while the app is open (below) |
| Only while a deletion, or the cleanup after a replacement, is under way: that the account is being deleted, and whether its user or the deletion of unused accounts started it (so the app can say which); or, on the new account, the old account's ID | So the deletion or cleanup carries on where it stopped, and the account is never left half deleted and in use | Until it's done, a few minutes at most while the app is open; it carries on each time the app is opened. If the app is never opened again, it stays, with what isn't deleted yet (below): where the operator has turned it on, until the account has gone unused for 12 months ([below](#accounts-nobody-uses)) |
| On the account: a random value replaced at each change to its link (not a count, so it says nothing about how often it changed), and, while a step of a deletion or cleanup runs, until when that step holds the account (to the millisecond) | So two requests can't undo each other's change to the link, or run the same step twice | The random value while the account exists; the step's time until the work is done (each step replaces it, the last removes it, or it goes with the account) |
| Messages waiting for the device, encrypted, each with the mailbox it came through | Delivery. The app takes a message in only through the mailbox it belongs to, so another user can't learn whose device opens it by sending it elsewhere | Until the device confirms them, at most 30 days |
| Placeholders: a device of no account, and at most one waiting message for each size an envelope can have (64 sizes), all zeros, with no mailbox and no time, under an account ID no account has | A send to a mailbox that doesn't exist (or ended) reads and writes them instead, so it costs and takes what a delivery does; each write writes the same item again, so nothing about the send is kept. They only show which envelope sizes were ever sent to such a mailbox | They never change, and stay |
| Attachments, encrypted, with their padded size and how many fresh upload links they were given (at most 3, when an upload is tried again) | Delivery, and fetching again (after clearing them from the device) | Until the recipient deletes the message or the chat, or at most 30 days; downloading or saving doesn't delete them. An upload is written once, with a link that only starts an upload within a minute and is given only in the 3 hours after payment, while nothing is stored: once deleted, it can't come back, except from a link given in that same minute (and that copy also expires within 30 days) |
| Invitation codes the account created, and its invitation level | Invite-only access to links | While the account exists |
| Two settings for everyone: whether uploads, and whether downloads, of attachments are paused (the operator's emergency switches). Nothing about any user | So the operator can pause attachments when their cost runs away | Until the operator changes them |
| One month for everyone: the newest in which a login recorded its account's month of use. Nothing about any user | So the deletion of unused accounts deletes nothing if logins stop recording their month ([below](#accounts-nobody-uses)) | Replaced by the next month's, at the first such login of each month |
| The admins' Telegram IDs, in an encrypted parameter (SSM Parameter Store), not in the `api` function's settings or the deployment's Terraform state. Whoever may read that parameter can read them: the `api` function, the deploy and the operator's AWS admins | To recognise admins, by the keyed hash of their ID | Until the operator changes them. SSM also keeps the parameter's earlier values, its last 100 |
| Rate counters: how many messages each mailbox got in a minute, and first messages each link in an hour; how much each device fetched in a minute; and what each person (Telegram user) used in a day (tokens, mailboxes, link changes, notice setups, fetches, confirmations of messages already gone, and so on), and how often each attachment was fetched. Each is named by a keyed hash of what it counts and its window, which changes every window: without the server's secret key, nobody can tell which mailbox, link, device or person a counter is about, or that two counters are about the same one. The daily ones go by the Telegram user, so setting up again doesn't reset them | Rate limits, among them the ones that keep one account from using up the capacity everyone shares | Until their window (minute, hour or UTC day) ends |
| Socket records: a keyed hash of the account (not its ID), the connection ID, and the minute the record expires | Live updates, while the app is open | From opening the app until the server finds the socket closed, the account is deleted, or the record expires, 40 minutes after the minute it opened |
| Notice quiet periods: a keyed hash of the account, the minute the period ends, and a random token naming who started it | At most one notice every 3 minutes | 3 minutes, rounded up to the minute (as long as Telegram asks, if it refused a notice for sending too many) |
| Login nonces, spent send and media tokens (and whether one was given back). Nothing about whose they were | Replay protection | Minutes, up to two weeks |
| Error logs, without IDs, IP addresses or content | Fixing problems | 7 days |
| Request counts: once a minute, how many requests each server instance answered, by route (`POST /send`, never the path with its IDs) and status, and by error code (`rate_limited`, say). Counts only, nothing about who | Alarms on limits being hit, refused requests, and how many accounts and tokens are given out ([deployment.md](deployment.md#request-counts)) | The log lines 7 days. The metrics made from them (registrations, token batches, 429s overall and by route, three kinds of refusal): kept by CloudWatch for 15 days a minute at a time, 63 days 5 minutes at a time and 15 months an hour at a time, and they can't be deleted |
| Request counts at the firewall, only where the API has one in front of it (by default in production alone): how many requests it allowed and blocked, overall and by rule, and, added by AWS, how many per country and per device type (desktop or mobile, say). Counts only, nothing about who | The alarm on blocked requests, and seeing which rule blocks ([deployment.md](deployment.md#the-firewall)) | Kept by CloudWatch for 15 days a minute at a time, 63 days 5 minutes at a time and 15 months an hour at a time, and they can't be deleted |
| The audit trail: a record of the AWS account's management calls, each call that reads or changes the account's settings (its roles, functions, buckets' settings, parameters and so on), by the operator's admins, the deploy and AWS services (the functions too, when they read their secrets at startup), with who made it, from which IP address (theirs, not users') and when. Nothing about users: the app's reads and writes of table items and attachments, and its invocations, are data events, which the trail doesn't record; and AWS leaves out values it treats as secret, such as parameters' values and the functions' environment variables | Finding out who changed what in the account, and alerts on changes ([deployment.md](deployment.md#audit-trail-and-change-alerts)) | 365 days. Removing a file sooner takes changing the bucket's settings first, which sends an alert; a file replaced before then stays 30 days more as an older version. CloudTrail's event history, which every AWS account has and can't be turned off, keeps the last 90 days of the same calls |

DynamoDB can take some days to delete an item after it expires; an expired
one is never used again, but a copy of the table made meanwhile still holds
it. That's why none of the short-lived records names a mailbox, link,
account or device, or holds the keyed hash of a Telegram ID the directory
keeps: each is named by a keyed hash, under a key that only the server
functions that use it hold (the rate counters' only `api`; the socket
records' `api` and `ws`; the quiet periods' only `notify`; never in the
database). So a copy of the database can't be matched up with the
directory, which says who owns each mailbox and link, to show which
accounts got messages, or opened the app, when. Whoever holds those keys
(see [security.md](security.md#what-still-leaks)) could, for the records not
yet deleted.

When a user deletes their account, it ends at once: the first step deletes
its link and marks the account as being deleted, and from then on nothing is
delivered to it, its invitation codes stop working, and nothing new is
stored for it. Then the rest of the above goes, in steps that keep the
database's capacity for everyone else: first what is left of an account it
replaced, and the messages waiting for its device; everything within a few
minutes for the biggest accounts, while the app stays open. If the app
closes first, it carries on the next time it's opened; meanwhile the server
keeps that the account is being deleted, and what isn't deleted yet stays,
unused. If the app is never opened again, that stays too: the account,
marked and unused, with what is left of it; where the operator has turned
on the deletion of unused accounts, until it has gone unused for 12 months,
when the server finishes it ([below](#accounts-nobody-uses)). The same if the server can't
finish and the user deletes everything from the device only; setting up
again later replaces that account (without asking: it isn't in use) and
deletes what is left of it, keeping no marker of it. Besides its old link
IDs and the tombstones of its link signing keys (above), which name nobody,
only short-lived rate counters (and a quiet period, for a few minutes) are
left. They expire on their own within about a day, though DynamoDB can take
some days more to delete them, and an expired one is never used again.
Until then, that day's counters still say how much was used that day (for
example how many send tokens were fetched), under names only the server's
key ties to a Telegram user; not what was sent or to whom.

Setting up again instead replaces the old account, which ends at once the
same way: a marker and the old device's public key are kept for 90 days, so
the old device can say it was replaced, and its link goes at once. The rest
of the old account (its mailboxes, invitation codes and messages still
waiting for the old device) goes in the same steps: the first during setup,
which is everything for a small account, the rest while the new device's app
is open, carrying on at each launch until it's done. Meanwhile the new
account records the old account's ID, which links the two on the server
until the cleanup ends; setting up again carries it over, and deleting the
new account finishes the cleanup first. Those leftovers have no expiry of
their own, since giving each one an expiry costs as much as deleting it: if
the new device's app is never opened again, they stay as long as the new
account does, unused, and go with it if it's deleted for going unused
(below).

### Accounts nobody uses

This is the operator's choice: it's on only where they've turned it on
(the software deletes nothing by default, it only counts what it would),
and whoever runs a deployment says in their policy whether it is. Where
it's on, an account whose app hasn't been opened for 12 whole months is
deleted, as if the user had deleted it: from the first day of the 13th
month after the
month of its last login (the app logs in each time it's opened), so one last
opened in November 2026 goes in December 2027, within hours, or days if
very many are due at once. Everything the server holds for it goes, in the
same steps as above: its link (its ID stays as a tombstone, naming nobody),
mailboxes, the messages waiting for its device, invitation codes, devices,
keys (the link signing keys' fingerprints stay as tombstones), the
encrypted chat ID and language for notices, the hash of the Telegram ID,
the month itself, what is left of an account it replaced, and a deletion
that stopped halfway. Attachments are left to expire within 30 days, as
always. Its link stops working, and the people who wrote to it can no
longer reach it; they aren't told. Opened while the deletion is under way,
or after, the app says the account was deleted for going unused (if it
was deleted in one step before the app could hear that, it says only that
the server no longer takes the device); it keeps the chats on the device
readable, and the user can set up a new account.

Only the month is stored for this, also while it's off, so turning it on
later doesn't take accounts in use for unused. Accounts set up before it
was stored get one at their next login, and aren't deleted until 12
months after that (or after the month the operator gives the rest, once:
[deployment.md](deployment.md#account-expiry)). It deletes nothing while
no login has recorded a month of use this month or last, as when logins
have stopped recording it (registrations, which store their own month,
don't count), so accounts in use are never taken for unused.

**Never stored:** the content of any message or attachment in readable form,
who sent a message, which conversations belong together, which mailboxes got
messages when, the user's name, username or phone number, and users' IP
addresses.
Senders don't log in to send: they pay with anonymous tokens that can't be
linked to their account.

## What Telegram gives the app

When a user sets up, Telegram gives the app signed launch data about them
(their Telegram ID, name, username and language). The server checks Telegram's
signature, keeps the keyed hash of the ID described above, and forgets the
rest. When the user allows notices, it also keeps their chat ID, encrypted,
and their language, while notices stay on. When someone opens a link, the
app never sends that launch data to the server, so it doesn't learn who
opened which link.

## Who else sees what

The services the software runs on:

- **Telegram** runs the bot and the app's window. It sees who uses the bot,
  which links they open, and when notices are sent. It doesn't see messages or
  attachments.
- **Amazon Web Services** hosts the backend and storage. It sees the IP
  address of every request the app makes, and holds the encrypted data listed
  above.
- **GitHub Pages** serves the app's files. It sees the IP address of every app
  load, and the link being opened, which is part of the page address.
- **The device's browser**, when an attachment is saved outside Telegram,
  opens a save page; the address, which holds the file's key, name and type,
  may stay in its history, and the name and type can be read from it there.
  Once the upload is gone the link fetches nothing, but its key still opens
  any copy of the encrypted file kept elsewhere. The download is marked not
  to be cached, so the browser keeps no copy of its own.

None of them receive message content. The app loads no third-party code and
has no analytics or trackers.

## What timing can reveal

Even without stored records, someone watching the servers or Telegram live
could link people by timing: a message arriving, then a notice, then a reply
or a "seen". So could whoever holds the server's keys, from the short-lived
records above that the database hasn't deleted yet (a few minutes to about a
day, and DynamoDB's lag). A copy of the database alone can't. This is
explained in [security.md](security.md#what-still-leaks). Deleting a chat's
attachments names their uploads together, up to 50 in a request, so someone
watching live would see which uploads one device deleted at once, as the
address and timing of one request per upload showed before; the uploads'
records go in that same request.

## What users can do

- **Delete a message for both sides** (their own, the default when deleting
  one): it goes from the other side's device too, opened or not, and its
  attachment from the server. Unticked, it goes only from their own device,
  and the other side can still fetch its attachment.
- **Delete a conversation** on their device; the other person keeps theirs.
  Or for both sides (unticked by default): it goes from the other person's
  device too, both sides' messages, until either writes again.
- **Block** someone. They're not told; their messages are no longer delivered.
- **Replace their link.** The old one stops working at once.
- **Turn notices off** by blocking the bot in Telegram. Once the next notice
  is refused, the server deletes the encrypted chat ID and language the next
  time the app is opened (above), and the app doesn't turn notices on again
  unless the user taps Turn on notices.
- **Choose what stays on the device** (Data and storage, on the Link tab): keep
  attachments forever, for a month or for a week; clear a chat's or all of
  them; and choose which kinds download by themselves. A cleared attachment
  can be fetched again only while the server still holds it.
- **Choose the app's language** (Data and storage): English, Persian, or the
  same as Telegram, the default. The choice stays on the device and isn't
  sent; notices keep the language Telegram gives the server.
- **Delete their account** in the app (on the Link tab). First the app
  deletes from the server the attachments they received: those of the
  messages on the device, and of those still waiting for it, which it
  fetches first. Any it couldn't delete, or never saw (one that arrived
  later), expire within 30 days, and so do the ones they sent, which stay
  for the other side to fetch. Then the account ends at once, and
  everything the server holds for it is deleted within minutes (the link,
  mailboxes, waiting messages, invitation codes, keys, and the hash of the
  Telegram ID; only its link IDs and link signing keys' fingerprints stay,
  naming nobody), then the app clears everything on the device (see On
  the device for what that leaves). They can set up a new account later.
- **Leave it unused.** Where the operator has turned this on, an account
  whose app isn't opened for 12 months is deleted
  ([above](#accounts-nobody-uses)).
- **Set up again on another device** if they can't use theirs any more. This
  replaces the old account: its link goes and its mailboxes stop at once, and
  they're deleted within minutes while the new device's app is open.

Since the server keeps no content and no record of who talks to whom, there's
nothing of that kind to hand over to anyone. What it does keep is listed
above.
