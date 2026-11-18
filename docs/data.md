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
blocks. History and attachments are encrypted under a key that can't leave the
device. None of it leaves the device in readable form. It's deleted when the
user deletes the account or sets up again, or when Telegram or the phone
clears the app's storage. Deleting a conversation deletes its history and
attachments; its record (keys and mailboxes included) stays, out of the list,
so it can come back if either side writes again. Attachments can also be
cleared on their own (Data and storage), and their messages stay.

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
| The time and ID of their newest message it took in | Until a delete for both sides names it, or they delete it for both sides; otherwise while the conversation is kept |
| For a received message, when it was sent by the other side's clock, if that's later than when it arrived; for a sent one, the earliest time (their clock) something of theirs showed they had it | With the message |
| A reaction that arrived before its message, sealed like message text | Until the message arrives, or 31 days |

The keyed hashes are kept apart from the conversation itself (one item per
chat and kind), so the chat list doesn't read them.

## On the server

| What | Why | How long |
|---|---|---|
| A random account ID, and a keyed hash of the user's Telegram ID (not the ID itself) | One account per Telegram account; daily limits | While the account exists |
| The account's and its device's public keys | To check logins and requests | While the account exists |
| The user's Telegram chat ID, encrypted so only the notice service can open it, and their language | To send "New message" notices, if the user allows them | While notices are on |
| The account's link: its ID, its public keys, its first-contact mailbox | So people can write to the user | Until it's replaced, or the account ends |
| Mailboxes: random IDs, and which account they belong to | To deliver messages | Until they're ended or expire |
| Messages waiting for the device, encrypted, each with the mailbox it came through | Delivery. The app takes a message in only through the mailbox it belongs to, so another user can't learn whose device opens it by sending it elsewhere | Until the device confirms them, at most 30 days |
| Placeholders: a device of no account, and at most one waiting message for each size an envelope can have (64 sizes), all zeros, with no mailbox and no time, under an account ID no account has | A send to a mailbox that doesn't exist (or ended) reads and writes them instead, so it costs and takes what a delivery does; each write writes the same item again, so nothing about the send is kept. They only show which envelope sizes were ever sent to such a mailbox | They never change, and stay |
| Attachments, encrypted, with their padded size and how many fresh upload links they were given (at most 3, when an upload is tried again) | Delivery, and fetching again (after clearing them from the device) | Until the recipient deletes the message or the chat, or at most 30 days; downloading or saving doesn't delete them. An upload is written once, with a link that only starts an upload within a minute and is given only in the 3 hours after payment, while nothing is stored: once deleted, it can't come back, except from a link given in that same minute (and that copy also expires within 30 days) |
| Invitation codes the account created, and its invitation level | Invite-only access to links | While the account exists |
| Two settings for everyone: whether uploads, and whether downloads, of attachments are paused (the operator's emergency switches). Nothing about any user | So the operator can pause attachments when their cost runs away | Until the operator changes them |
| Rate counters: how many messages each mailbox got in a minute, and first messages each link in an hour; how much each device fetched in a minute; and what each person (Telegram user) used in a day (tokens, mailboxes, link changes, notice setups, fetches, confirmations of messages already gone, and so on), and how often each attachment was fetched. Each is named by a keyed hash of what it counts and its window, which changes every window: without the server's secret key, nobody can tell which mailbox, link, device or person a counter is about, or that two counters are about the same one. The daily ones go by the Telegram user, so setting up again doesn't reset them | Rate limits, among them the ones that keep one account from using up the capacity everyone shares | Until their window (minute, hour or UTC day) ends |
| Socket records: a keyed hash of the account (not its ID), the connection ID, and the minute the record expires | Live updates, while the app is open | From opening the app until the server finds the socket closed, the account is deleted, or the record expires, 40 minutes after the minute it opened |
| Notice quiet periods: a keyed hash of the account, the minute the period ends, and a random token naming who started it | At most one notice every 3 minutes | 3 minutes, rounded up to the minute (as long as Telegram asks, if it refused a notice for sending too many) |
| Login nonces, spent send and media tokens (and whether one was given back). Nothing about whose they were | Replay protection | Minutes, up to two weeks |
| Error logs, without IDs, IP addresses or content | Fixing problems | 7 days |

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

When a user deletes their account, all of the above goes at once. Only
short-lived rate counters (and a quiet period, for a few minutes) are left.
They expire on their own within about a day, though DynamoDB can take some
days more to delete them, and an expired one is never used again. Until
then, that day's counters still say how much was used that day (for example
how many send tokens were fetched), under names only the server's key ties
to a Telegram user; not what was sent or to whom. Setting up again instead
replaces the old account: a marker and the old device's public key are kept
for 90 days, so the old device can say it was replaced; everything else of
the old account goes at once.

**Never stored:** the content of any message or attachment in readable form,
who sent a message, which conversations belong together, which mailboxes got
messages when, the user's name, username or phone number, and IP addresses.
Senders don't log in to send: they pay with anonymous tokens that can't be
linked to their account.

## What Telegram gives the app

When a user sets up, Telegram gives the app signed launch data about them
(their Telegram ID, name, username and language). The server checks Telegram's
signature, keeps the keyed hash of the ID described above, and forgets the
rest. When the user allows notices, it also keeps their chat ID, encrypted,
and their language. When someone opens a link, the app never sends that launch
data to the server, so it doesn't learn who opened which link.

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
  opens a save page; the address may stay in its history (it opens nothing
  once the upload is gone).

None of them receive message content. The app loads no third-party code and
has no analytics or trackers.

## What timing can reveal

Even without stored records, someone watching the servers or Telegram live
could link people by timing: a message arriving, then a notice, then a reply
or a "seen". So could whoever holds the server's keys, from the short-lived
records above that the database hasn't deleted yet (a few minutes to about a
day, and DynamoDB's lag). A copy of the database alone can't. This is
explained in [security.md](security.md#what-still-leaks).

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
- **Turn notices off** by blocking the bot in Telegram.
- **Choose what stays on the device** (Data and storage, on the Link tab): keep
  attachments forever, for a month or for a week; clear a chat's or all of
  them; and choose which kinds download by themselves. A cleared attachment
  can be fetched again only while the server still holds it.
- **Delete their account** in the app (on the Link tab). Everything the server
  holds for it is deleted at once (the link, mailboxes, waiting messages and
  attachments, invitation codes, keys, and the hash of the Telegram ID), and
  then everything on the device. They can set up a new account later.
- **Set up again on another device** if they can't use theirs any more. This
  replaces the old account; its links and mailboxes are deleted at once.

Since the server keeps no content and no record of who talks to whom, there's
nothing of that kind to hand over to anyone. What it does keep is listed
above.
