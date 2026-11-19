# Security model

What Incognito Chat protects, from whom, and where it stops. How it works is
in [architecture.md](architecture.md); the exact formats are in
[protocol.md](protocol.md).

## Why it exists in this form

Version 1 relayed messages inside Telegram chats with the bot. Anyone holding
the bot's token can read those chats back through Telegram's own APIs,
including Bot API forwarding and MTProto's `messages.getMessages`, which walks
every message still stored in every chat with the bot. The bot's owner can
always see the token in BotFather. No server hardening fixes that, so
version 2 moves all content out of Telegram and encrypts it on the device.

## Goals

- **Content is end-to-end encrypted.** Only the two people in a conversation
  can read it: not Telegram, not the bot-token holder, not the operator, not
  AWS, not GitHub, not anyone with a copy of the database.
- **Stored data shows no social graph.** The server never records who sent a
  message or which conversations belong together. What it keeps for a short
  while (rate counters, socket records, notice quiet periods) is named by
  keyed hashes, so a copy of the database can't be matched with the
  directory to show which accounts got messages, or had the app open, when.
- **Anonymous senders stay anonymous**, also to recipients who compare notes.
  Someone's anonymous conversation with you can't be linked to the
  conversation they have with you through their own link. The server gives
  each link signing key to one account for good, so the tag a sender's app
  adds to a first message differs between accounts' links (for links made
  before that rule, from their next key change: see Other limits).
- **The app's code is verifiable**: built in public, reproducibly, with
  published hashes and provenance, and served the same to everyone
  ([verifying.md](verifying.md)).
- **Low cost, nothing running when idle.**

Not goals of this version: hiding IP addresses from AWS and GitHub, resisting
an operator who watches live traffic, resisting a malicious Telegram app,
several devices per account, and recovering an account after losing its
device.

## Who could attack, and what they get

| Who | Can | Gets |
|---|---|---|
| A copy of the database (leak, backup, data request) | Read every stored item | Accounts, public keys, links, mailboxes and their owners, undelivered ciphertext, encrypted attachments; short-lived records under keyed hashes that can't be matched with any of them. No content, no senders, no conversation pairs, no record of who got messages or had the app open when. |
| The operator or AWS account holder, passively | Read the database, logs and settings | The same. With the functions' keys (in SSM), also: which Telegram user owns each account, and so each link and mailbox (the stored hash of a Telegram ID is one keyed hash, and with the key, every possible ID can be hashed in minutes), as the sealed chat IDs of accounts that set up notices also say; and which mailboxes got messages, and which accounts had the app open, minute by minute, for the short-lived records not yet deleted (see What still leaks). |
| The operator, actively and live | Change server code, log requests, watch traffic | The recipient of each message, timing, IP addresses. Can link people by timing over several messages. Can set, at each login, the clock someone's app dates messages by, anywhere within a minute of the device's: a recipient working with it can read that in what the person sends, as a tag. Can't read content or forge messages, or use old ones to undo later ones, as long as the app itself isn't swapped. |
| A compromised deploy (a step of the CI job, or a deploy someone got approved) | Deploy code CI signs, change what Terraform manages, read the secrets (older values too), invoke `bot` and `notify` | Through code it deploys, what the functions can reach, until the next deploy replaces it. Can't read the tables, logs or attachments itself. Most ways to leave access behind are denied; some IAM can't deny, and the next deploy finds only some of those (see Other limits). |
| The bot-token holder | Everything Telegram's bot APIs allow | Who uses the bot, when notices go out. No content. Can send look-alike notices that open a look-alike page, which has none of the user's keys. |
| The BotFather owner | Change the Mini App's address | Can point the app at a malicious page, for everyone or for chosen people. The largest remaining risk; see below. |
| Telegram's servers | See app launches and bot traffic | Who opens which link, when notices go out. Timing can link senders to recipients. No content. |
| The Telegram app on the device | Hosts the app's page | Everything on that device. Trusted, like any app you type into. |
| GitHub (hosts the app) | Serve the app's files, log visits | IP addresses, and the link being opened (it's in the page address). Could serve different code, but verifiers would see it. |
| Other users | Receive messages, compare notes | Can't link an anonymous sender's conversations with different people, or their anonymous and known conversations, also not by leaving envelopes sealed to a key they know in other people's mailboxes, or by timing sends to learn when someone has the app open. Message times carry the server's clock to the second, not the sender's device clock, except in the cases under What still leaks (Message times), and except voice messages: the recording's own header still carries the device's clock, to the second (not fixed yet). |
| Spammers | Create Telegram accounts | Bounded by Telegram-only registration, send-token budgets and per-mailbox and per-link caps. |
| A thief with an unlocked device | Use the device | Everything on it. Remedy: set up again, which ends the old account at once. |

## What users still have to trust

The goal is an app where nobody has to trust anyone, including whoever runs
it. This is how close it gets.

**What the operator can't do at all**

- Read anyone's messages or attachments.
- Learn from stored data who wrote to whom, or who an anonymous sender is:
  nothing stored says so. (With the functions' keys it can read the
  short-lived records for as long as they're kept, which show some of the
  timing it can watch live; see 2. below.)
- Forge messages or slip them into a conversation.
- Undo what happened in a conversation by delivering old envelopes again,
  or out of order: bring back a deleted message or chat, wipe later history
  with an old "delete for both", or move an app back to the other side's
  older key or mailbox. Each app remembers, per conversation and as keyed
  hashes only, which envelopes it took in and which messages were deleted,
  for as long as an envelope can still be taken in (31 days); besides
  those, the conversation keeps the time and ID of the other side's newest
  message taken in, until a delete for both sides names it (as it keeps
  the ID of the last envelope taken in); takes key
  and mailbox changes only from newer envelopes, by the sender's clock; and
  a "delete for both" takes only what was written before it
  ([protocol.md](protocol.md#inner-message), Replays and order). The
  operator can still hold an envelope back and deliver it late, within
  those 31 days, as it can drop it; delivered late, it does what it would
  have done on time, nothing more.
- Swap someone's keys unnoticed: every link carries its key's fingerprint, and
  the app checks it.
- Collect logins and signed requests dated far ahead, to replay them later:
  the app corrects for a server whose clock differs from the device's only
  within two days, and further off it signs nothing and asks the user to set
  the device's clock. Within those two days such a request could still be
  replayed once, when its time comes.

**What the operator could do, but would be caught**

- Serve app code that differs from this repository. Builds are public,
  reproducible, attested and hashed, so anyone can compare what is served with
  what is in the repository ([verifying.md](verifying.md)). The verification
  script also checks that the build came from a commit on `main`, made by an
  unchanged copy of the hosting workflow.
- Put another page on the app's origin. Every Pages site of the hosting
  organization is served from the app's origin, `https://<org>.github.io`,
  and a page there could use the keys the app keeps in the browser. So the
  organization hosts nothing but the app, and the verification script fails
  if any other of its repositories has a Pages site. One gap remains: whoever
  controls the hosting repository can add pages the manifest doesn't list to
  the app's own site (through a changed or added workflow, or by deploying
  Pages from a branch), and nothing the script checks would catch it. The
  change may show in the hosting repository's public history, but an admin
  can rewrite that history and delete the runs
  ([verifying.md](verifying.md#what-this-proves-and-what-it-doesnt)).

**What still requires trusting the operator**

1. **A swapped page inside Telegram.** Whoever controls the bot in BotFather
   decides which web page Telegram opens, for everyone or, through the bot,
   for chosen people, and Telegram offers no way to lock it. A page on
   another address has no access to the keys already on a user's device, so
   past messages stay safe. But anyone who types into it, for example a
   sender opening a link, is typing into the operator's page. A user it talks
   into "setting up again" loses their account. What limits the damage:
   - keys are tied to the app's origin, `https://<org>.github.io`, so a page
     on any other address can't use them. A page on that origin could, which
     is why nothing else may be served there, and the verification script
     checks it (above);
   - setting up again replaces the account loudly: the old device says at once
     that the account was replaced, and that this may mean tampering;
   - the old device keeps its chats, readable. No answer from the server
     ("replaced", "not signed in") deletes anything on a device: only the user
     can, by typing a confirmation;
   - the person's link changes, which their contacts see.
2. **Watching live traffic.** The operator, or AWS, can watch requests as they
   happen and link people by timing and IP address: a message arriving, then
   a notice, then a reply or a "seen". A copy of the stored data doesn't show
   this, but live observation does, and so, for a short while, do the
   short-lived records to whoever also holds the functions' keys (What still
   leaks, Short-lived records). Immediate "seen" receipts make it easier.

**What every user trusts in any app**

- Their own phone or computer and its operating system.
- The Telegram app, which hosts the page and could read it.
- The app code they are actually running.

## What still leaks

- **Timing.** The operator, AWS or Telegram, watching live, can correlate "a
  message arrived" with "a notice went out" or "someone replied", and link
  people after a few rounds. "Seen" receipts are sent the moment a message is
  read, which sharpens this. Not stored, but observable.
- **Message times, a little, to other users.** Every message, receipt,
  reaction, edit and delete says when it was sent (`at`). Taken from the
  device's clock, to the millisecond, as versions before this one did, it
  told recipients how far that clock is off: someone who notes when things
  arrive can estimate that, it lasts for days, and it's the same in all of
  a person's conversations, so a recipient comparing an anonymous chat with
  a known one, or two recipients comparing notes, could link them (in a
  simulation of typical clocks and networks, 4 to 5 bits from 10 to 30
  messages and receipts each). So the app dates them by the server's clock
  instead, rounded down to the second, as each login's session token tells
  it ([protocol.md](protocol.md#inner-message), Times). What's left:
  - the app knows the server's clock to about half a second, and the error
    is the same in all its conversations until its next login, about 15
    minutes later. Someone who times, within those minutes, many messages
    and receipts in two chats (by answering while the other person has the
    chat open, say) still learns a little: in that simulation 1.3 to 2.2
    bits from 10 to 30 each, and about 0.2 bits from different logins.
    How long messages take to arrive, which differs between networks, adds
    to that, clocks or not;
  - a device whose clock is more than a minute off gets nothing from this:
    its messages are dated by its own clock, rounded down to the second,
    which still tells how far it's off;
  - everyone's messages are, too, until a login succeeds in that run of
    the app: while it's offline, and also while the server refuses or
    fails logins (429, 5xx), which the app treats the same way. That can be
    a whole run. Then, in a conversation where it sent something by its own
    clock, what it sends next carries on from that time, a second apart, so
    as not to go back: for as long as its clock was ahead, a minute at
    most;
  - voice messages: the recording's own header still carries the device's
    clock, to the second (not fixed yet);
  - anyone still on a version before this one sends the device's clock, to
    the millisecond.
- **File names and the kind of device, to other users.** A file, an audio
  file sent as music, or a video the app can't open goes with its own name.
  Phones often name photos, screenshots and recordings with their brand,
  the moment they were taken (to the second, some to the millisecond), or
  a counter that grows with each photo (`IMG_4821`), so close numbers or
  times in two chats can point to one phone. And attachments can show what
  kind of device sent them, the same in every conversation: a video keeps
  its file type (an iPhone's is `video/quicktime`) and its encoder's names
  and settings; photos, previews and recordings are made by the app's web
  view, whose output differs between iPhones, Android and computers; and a
  photo keeps its camera's proportions.
- **Not to other users: whether someone's app is open, or whether a mailbox
  still exists.** A send is answered after the same steps whatever the
  mailbox. Pushing to the recipient's open apps (and the notice, if none is
  open) happens afterwards, in another function the answer doesn't wait
  for, so how long a send takes doesn't say whether their app is open. A
  mailbox that doesn't exist (never did, or ended with a block or the
  conversation) goes through the same reads and the same write, of the
  same size, costing the same capacity, to placeholders that hold only
  zeros ([data.md](data.md#on-the-server)), so neither the answer, its time
  nor a failure says whether a sender was blocked. What's left: the
  database finds the mailbox and a device, or the placeholders, and
  answers a few bytes more or less; and the very first send to such a
  mailbox in a deployment writes the placeholder device once. "Seen"
  receipts, sent when the person opens the chat, show when they read it.
- **IP addresses.** AWS sees the IP address of every request, including
  attachment uploads and downloads. GitHub sees the IP address of every app
  load, together with the link being opened (Telegram puts it in the page
  address).
- **How busy the service is, minute by minute.** Each `api` instance logs,
  once a minute, how many requests it answered by route, status and error
  code ([deployment.md](deployment.md#request-counts)), for the alarms on
  abuse. Counts only: no IDs, IP addresses, paths or content, per minute,
  so they say what AWS's own per-minute metrics of the functions and tables
  already say, by route. The lines are kept 7 days. The 19 metrics made from
  them (registrations, token batches, 429s overall and by route, and three
  kinds of refusal) are kept by CloudWatch for 15 days a minute at a time,
  63 days 5 minutes at a time and 15 months an hour at a time, and can't be
  deleted. On a quiet deployment, a minute with one `POST /send` says that
  one message was sent then, not by or to whom.
- **When some single requests came.** Lambda freezes an instance between
  requests, so only a request can write its line: the instance's first one
  after the minute. The log dates the line by that request, to the
  millisecond. On a quiet instance it is often the only request the next
  line counts, which then gives its route too, and the metrics made from
  those lines carry the same times, to the minute. So the logs can show when
  a lone request came and what it was, never who made it. That is small,
  and comes with counting at all without a clock of its own.
- **The user's own network.** The app's traffic doesn't travel through
  Telegram: it goes straight to the app's host and the backend. Whoever
  carries it (an internet provider, a Wi-Fi owner, a VPN) sees that the
  device uses this service, and when. They see no content, links or accounts.
- **Telegram** sees who opens which link, and when notices are sent.
- **Recipients are known to the server.** It must know a mailbox's owner to
  deliver to it. Only senders and pairings are hidden.
- **Who is still on the old build, while an issuer key is replaced.**
  Replacing a key ([deployment.md](deployment.md#rotating-an-issuer-key))
  splits senders in two while both keys are held. `POST /tokens` names the
  key it wants, so the server sees which logged-in accounts still fetch
  tokens for the old key, and every send paid with an old-key token comes
  from one of them: a set that only shrinks as people open the app again,
  and can be small near the end. Keep that window short, minutes to an
  hour, and retire the old key as soon as the site serves the new build.
  (Signing each batch with every key held, and letting the app keep its own
  key's signatures, would keep `POST /tokens` from saying which build an
  account is on, at twice the signing work; it isn't done.)
- **Which messages are quiet.** "Seen" receipts, reactions, edits, deletes
  and key updates are marked so they don't trigger a notice. The server sees the mark, not
  who sent it, and mostly not which of these it is: reactions, deletes and
  key updates always fit the smallest size class, but a receipt for more
  than a few messages (opening a chat with a backlog), or a long edit,
  takes a larger one, so the server can tell those apart by size.
- **Attachment sizes, roughly.** Files are padded before upload (to the next
  power of two from 16 KiB up to 1 MiB, then the next whole MiB; the server
  takes no other size), and paid with one media token per started MiB. So
  the server sees a size class, not the type, name or content.
- **Attachments wait on the server, encrypted.** An upload stays in the bucket
  until the recipient deletes the message or the conversation, or 30 days
  pass, whether or not it was downloaded or saved, so the app can fetch it
  again meanwhile. It's ciphertext the server can't open, but it exists. It
  can be written only once, from a link that must start the upload within a
  minute; the server gives such links only while nothing is stored, and
  only in the 3 hours after payment, to whoever holds the delete secret
  (the sender, and the recipient, whose message carries it). So the sender
  can't swap it after sending, and once the recipient deleted it, it can
  come back only from a link given in that same minute, as a copy that
  still expires within 30 days. The link used to save a file in the device's
  browser can stay in that browser's history, with the file's key, name and
  type, all readable by anyone who reads that history; it carries no delete
  secret. Once the upload is gone the link fetches nothing, but its key
  still opens any copy of the encrypted file kept elsewhere. Downloads are
  marked not to be cached (`Cache-Control: no-store`), so the browser keeps
  no copy of its own; one cached before downloads were marked so may
  remain.
- **"Seen" right after a link.** Opening a link from Telegram never opens a
  chat or sends "seen" by itself, so a link's owner can't send someone their
  link and watch for a "seen" to learn whether that person writes to them.
  If the person already does, the app says so and waits for a tap on Open,
  and warns that opening the chat right away could give them away. Someone
  who opens it at once anyway can still be recognised by the timing.
- **Short-lived records.** The server keeps, for minutes to a day:
  - rate counters: messages to each mailbox per minute, first messages
    through each link per hour, what each device fetches per minute, and
    what each person uses per day (so that no one can flood a mailbox or a
    link, or use up the capacity everyone shares);
  - a record of each open app's socket, for pushes, and the minute it
    opened;
  - when each account last got a notice, for the 3 minutes until the next
    may go out.

  None of them holds a mailbox, link, account or device ID, or the hash of
  a Telegram ID the directory keeps. Each is named by a keyed hash, under a
  key only the functions that use it hold, outside the database: the rate
  counters' only `api` (from the Telegram-ID pepper), with a new name every
  minute, hour or day; the socket records' `api` and `ws` (derived from the
  session key); the quiet periods' only `notify` (derived from the chat
  key). Each expires when its window ends. So a copy of the database can't
  be matched with the directory, which says who owns each mailbox and link:
  it can't tell whose a counter or record is, string a mailbox's minutes
  together, or set when someone's mailboxes got messages against when
  someone else's did, or against when anyone had the app open. Socket
  records and quiet periods keep one name per account while they last, so a
  copy shows that some account had the app open, or got a notice, but not
  which.

  Whoever holds those keys (the operator or the AWS account holder, who can
  read SSM, or someone who took them from a running function) could, for
  the records the database hasn't deleted yet (DynamoDB deletes expired
  items within a few days, usually much sooner): recompute the names for
  every mailbox, link and account in the directory, and so see which
  mailboxes got messages in which minute (and so, by timing, who likely
  writes to whom), and which accounts had the app open in which minute.
  That is part of what watching live shows them anyway (What users still
  have to trust, 2.).
- **Who invited whom.** Using an invitation code is a request from the
  person's session that names the code, and the code names whose it is, so
  the server sees who invited whom. It doesn't store it: the person keeps
  only their invitation level, one below the inviter's. An invitation link
  only asks; it's used when the person taps Join.
- **Activity and volume:** roughly how many mailboxes and messages an account
  has.
- **A brand-new user's first message** follows their registration closely in
  time.
- **Attachments can keep metadata.** Photos are redrawn, which drops
  theirs. A video sent "as video" has the usual location, device and time
  tags removed: the MP4/QuickTime metadata boxes, XMP, the boxes Sony,
  Canon and Garmin cameras add, data some cameras leave in unused space
  (`free` and `skip` boxes), and the recording times in its headers. Not
  everything goes, though:
  - a GPS or other sensor track recorded alongside the picture, as action
    cameras, drones and dashcams often write;
  - a timecode track, which cameras often set to the time of day;
  - other makers' own data the app doesn't know, and the names of the
    encoder and handlers, which hint at the device;
  - data in unused space, in a fragmented recording (some dashcams and
    recording apps, and every MP4 a browser records) or in a video with
    part of a track the app can't read;
  - everything, in a video the app can't read (a WebM, or an MP4 with
    extra data after its end): that is sent as it was.

  A file sent "as a file" is sent untouched, location included if it has
  any. Music and GIFs are sent as they are too: an audio file sent "as
  music" keeps its tags (title, artist, album, date, cover picture; a
  phone's voice recorder may name a recording after the place it was
  made), and a GIF any comments or XMP data in it (its preview, the first
  frame drawn again on the device, has none).
- **Abuse can't be traced to a person**, by design. Blocks, budgets, caps and
  replacing a link are the remedies.

## Other limits

- **One device per account.** History lives only on that device. Setting up
  on another device replaces the account; there is no sync and no recovery.
  If Telegram or the phone clears the app's storage, the account is gone.
  Whether iPhones keep the app's storage over long periods is still being
  tested.
- **Keys are stored with the data.** The app's keys are non-extractable
  WebCrypto keys, which only stops code from reading them out. They live in
  the web view's storage, next to the history they encrypt, and on Android,
  Windows and Linux the web view writes them to disk as they are. So an image
  of the device's app storage (a forensic copy of an unlocked phone, or a copy
  of Telegram Desktop's folder) clones the account: it opens the whole
  history and can use the account as this device. Deleting the account or
  setting up again clears the app's storage, but that isn't erasure: on some
  systems (Android and Windows at least, with Chromium's engine) the cleared
  keys and records stay in the storage files until the engine compacts them,
  and a copy of the device made before may still hold them. Real erasure
  needs crypto-shredding: a key kept outside the app's storage (the phone's
  secure storage, or a passphrase), deleted with the account. The app
  doesn't do that yet.
- **Any bot can open the real app.** Telegram lets any bot's `web_app`
  button open any web page, this app's included. Opened that way, the page
  runs on the app's origin, so it finds the keys on the device (where the
  Telegram app shares storage between bots, which differs by client) and
  logs in with the device key, which needs no launch data. The launch data,
  and the link or invitation it names, then come from that bot, and the app
  can't tell which bot it was. So a launch never acts by itself: a link
  shows its screen and opens a chat the user already writes to only on a
  tap, an invitation joins only on Join, and "seen" waits for a tap in the
  app. Registration, notices and account lookups take launch data only
  when it was signed for the app's own bot.
- **Edits rely on honest apps too.** An edit asks the other side's app to
  replace a message's text and mark it edited; a modified app could keep the
  original, as anyone can keep a screenshot. Only the sender's own messages
  can be edited.
- **Deleting for both sides relies on honest apps.** Deleting a message, or
  a whole conversation, for both sides asks the other side's app to delete
  it, and deletes the deleter's uploads from the server. A modified app could
  keep it, and anyone can take a screenshot, as with Telegram's. A single
  message can only be one of the deleter's own; a whole conversation, as in
  Telegram, takes both sides' messages.
- **Blocks rely on honest apps.** A block also covers new conversations from
  the same person through the same link, using a tag the sender's app adds. A
  modified app could send a random tag and appear as someone new. Per-link
  caps, budgets and replacing the link bound this.
- **Distinct sender tags rely on the server.** A sender's tag is the same on
  every link with one signing key. The server gives each signing key to the
  first account that proves it holds it (a signature by the key over the
  link and account IDs), for good, even after that account ends
  ([protocol.md](protocol.md#links)). So link owners who compare notes see
  different tags for the same sender, and a copied bundle can't be put up
  under another account. A sender's app can't check this, since a replaced
  link shows the same key under a new ID too: an operator that let several
  accounts share a key would let their owners match a sender who writes to
  each of them. Links made before the server checked this get their key
  claimed at their next key rotation or replacement, and two things made
  before stay open until those links' current keys expire. A copy of
  someone's link put up under another account keeps taking first messages
  meant for them for up to 5 weeks (the copied keys' lifetime). Accounts
  that shared a private key itself keep matching a sender's tag across
  their links for up to about 32 weeks: the server accepted keys starting
  in the future, up to 4 of 8 weeks each per link. Neither can be renewed:
  a copy can't be rotated without the private key, and of the accounts
  sharing one, only the first to claim it can go on using it. A key never
  claimed before its link was revoked, or its account ended, stays
  unclaimed.
- **A blocked sender may still trigger a notice**: the server can't tell a
  blocked first message from any other, so the owner may be notified of a
  message their app then drops.
- **`api` can ask for notices directly.** Its right to invoke `notify`,
  which it needs to seal chat IDs, can't be limited to sealing, so `api`
  (or whoever controls it) could have `notify` send any account a notice,
  at most one every 3 minutes, skipping `ws`'s check that no open app took
  the push. The notice is still the generic one, and says nothing more.
- **Opening a socket checks only the session token.** `ws` checks the
  token's signature and expiry and reads nothing about the account (its
  role can't read the directory), unlike `api`, which reads the device and
  its account for every request. So a token issued before the account was
  replaced or deleted still opens sockets until it expires, 15 minutes at
  most, though nothing is pushed to an ended account. And whoever holds a
  live token can open sockets for the account that take its pushes ahead
  of its app's own (pushes go to the newest sockets first), for up to about
  40 minutes after the token expires: meanwhile the app learns of new
  messages only when it polls, every 2 minutes, and no notice goes out. The
  same token can already fetch the account's waiting envelopes, and confirm
  them, which deletes them.
- **What `notify` can reach.** It holds the key that opens chat IDs, so its
  role is narrowed ([infra/functions.tf](../infra/functions.tf)). In the
  directory it may only read and update items in account partitions
  ("A#…"): reads must name the notice fields (sealed chat ID, language,
  last notice, "notices off"), and updates may set only the last two and
  ask for nothing back (`ReturnValues`). It can't list or scan, put or delete,
  reach the link, mailbox or Telegram items, or any other table but its
  quiet periods. So whoever holds its role (stolen credentials, a bad
  dependency in its build) can't walk the link and mailbox registry to
  match accounts to Telegram users: it can open the chat IDs only of
  accounts whose IDs it already has (`notify` is given the ID of each
  account it notifies). That narrowing has limits IAM can't close: it
  can't limit sort keys, an update creates the item it names if it isn't
  there, and nothing limits `ReturnValuesOnConditionCheckFailure`. So
  such a role can still:
  - read whole items in an account partition whose keys it knows,
    including the account item (account key, Telegram-ID hash) and device
    keys: an update whose condition fails can ask for the item as it was
    (`ALL_OLD`), and no IAM condition key covers that. It can also tell
    whether such an item exists, say whether an account owns a link or
    mailbox whose ID it knows;
  - create items under any sort key in any account partition, holding
    only the notice fields. Records it adds to the partition of an account
    of its own naming someone else's link, mailbox or code (`K#<link>`,
    `M#<mailbox>`, `I#<code>`) no longer reach them: deleting or replacing
    an account deletes a link, mailbox or code only if it names that
    account as its owner, and otherwise only the record. What stays open:
    - items added to someone else's partition could still break that
      account's requests;
    - added `K#` records make the repair of a stale link count
      (recountLinks) see more links than the account has, so it doesn't
      repair it;
    - items whose sort keys fall between the account's (`A`) and its
      devices' (`D#…`) are never deleted, and every login and request of
      that account reads them (enough of them make those fail);
    - added `D#` records are read in full by the last step of a deletion
      and by the cleanup after a replacement (no page limit).

  Moving the notice fields to a partition of their own (`N#<account>`), so
  the role can be limited to `N#` partitions, would close all of these and
  the first.
- **The server says which mailbox an envelope came through.** The app
  takes an envelope in only through the mailbox it belongs to
  ([protocol.md](protocol.md#inner-message)), so a user who knows one of
  someone's keys can't seal to it, leave copies in suspects' mailboxes (anyone
  can write to a link's), and watch whose app answers. That check trusts the
  server to report the mailbox honestly. A malicious server could lie and get
  past it, but would learn nothing new: it knows every mailbox's owner
  already. The check is against other users.
- **Attachments can be paused for everyone.** The operator, or anyone with
  an admin's unlocked device, can stop uploads or downloads of attachments
  (the emergency switches, for runaway costs). The app says so. It's one
  switch for all: uploads and downloads carry no login, so it can't single
  anyone out, and it reads or stores nothing about anyone. Messages keep
  working.
- **Forward secrecy is weekly, not per message.** Encryption keys rotate about
  weekly, and an old private key is deleted 35 days after it was replaced (a
  conversation key, 35 days after the other side first wrote to the new
  one). So keys taken from a device open about the last five weeks of
  messages a malicious server might have kept, and more where a key wasn't
  replaced: a conversation key rotates only with the next message or
  receipt sent in that conversation, a link key only when the app opens,
  and an old conversation key stays as long as the other side never writes
  to the new one ([protocol.md](protocol.md#key-rotation)).
- **What a compromised deploy can still do.** The CI deploy role may make
  only the calls the app stack's Terraform makes, and is denied much of the
  rest that matters: reading or writing table items, exporting or backing
  up tables, reading logs or attachments, invoking functions other than
  `bot` and `notify`, and the plainest ways to leave access behind that no
  Terraform plan shows (a role, a change to whom a role trusts, a function
  permission for an account or role, a log subscription, bucket versions,
  notifications or replication, a table policy, provisioned concurrency).
  The functions' roles are created by the bootstrap stack, which only an
  admin applies, and trust Lambda alone
  ([deployment.md](deployment.md#what-the-deploy-role-may-do)). What a
  compromised deploy keeps:
  - Code: it deploys whatever it builds and signs, and that code runs with
    the functions' roles, which reach the secrets and the tables. It lasts
    until the next deploy replaces it, and each deploy's public log shows
    the deployed code's hash ([verifying.md](verifying.md#the-backend)),
    though a compromised job can lie in its own log.
  - Secrets: it reads each parameter, since Terraform's AWS provider reads
    every parameter it manages, decrypted, on each plan, and the deploy job
    holds the bot token and the issuer keys. That also reads older values,
    for as long as SSM keeps them (a parameter's last 100 versions):
    `GetParameter` takes a version, and no condition key refuses it. After
    a leak, deleting the parameter drops them
    ([deployment.md](deployment.md#replacing-a-generated-secret)). With the
    bot token it can point the bot's webhook elsewhere, until the next
    deploy sets it back. Keeping the secrets from CI would mean writing them
    outside Terraform.
  - Function permissions: IAM can't check which CloudFront distribution or
    API Gateway API a permission names (AddPermission has no condition key
    for the source), nor tell a permission for calls through a function's
    URL from one for any direct invoke. So it could let another account's
    distribution invoke `api`, another account's API invoke `ws`, or anyone
    invoke `api` or `bot` directly with any event. Each deploy reads the
    functions' resource policies after applying and fails on any such
    statement, so one lasts until the next deploy, which shows it.
  - The WebSocket API: IAM can't limit which routes, integrations or whole
    APIs it adds, and nothing checks them, so it could add one that no plan
    shows, such as a route that sends each closing socket's IP address
    elsewhere.
  - Cost: it can raise a table's capacity (provisioned capacity, or a
    higher on-demand cap), since `UpdateTable` has no condition keys, or
    change a function's memory and reservations. These show in the next
    plan, which undoes them, but cost until then.
  - Other settings Terraform manages (the media bucket's policy, a function
    URL's auth type): a change shows in the next plan, which undoes it.
  - Unseen changes: it can't touch the audit trail, and its IAM changes are
    emailed, but its other changes aren't, since deploys make them as their
    job. A deploy's public log shows its plan, but a compromised job can
    lie in its own log; the trail records each call it makes, for a year,
    for an admin who looks.
- **Users can't verify the backend directly.** Its builds are reproducible
  and attested, and each deploy's public log shows the hashes of what it
  deployed, which anyone can compare with their own rebuild
  ([verifying.md](verifying.md#the-backend)). Lambda runs only code signed
  through the deploy role, but that role signs whatever it uploads, so a
  signature shows that code came through that role, not that it was built
  from this repository. The deploy's check of the running code runs inside
  the deploy it checks, and covers the code and how it runs (package,
  runtime, layers), not the rest of the functions' settings (their
  environment variables, say). Users can't look into AWS,
  and whoever controls the AWS account could switch signing off. The design
  doesn't depend on it: a malicious backend can drop or delay messages and
  watch timing, but can't read content or forge messages, because apps check
  keys themselves.
- **The record of changes is in the account it watches.** The account
  records its management calls (an audit trail kept a year) and emails
  changes to permissions, functions, secrets, buckets' settings and the
  trail itself ([deployment.md](deployment.md#audit-trail-and-change-alerts)).
  That holds against the deploy role, which can't touch the trail, not
  against an account admin, or whoever has an admin's access: they can stop
  the trail, change its bucket's policy and delete records, turn off the
  rules, or unsubscribe the email address. Each of those sends an alert
  while the alerts still work, but one done first can silence the rest
  (the rule that watches the rules can't report its own removal), and
  AWS's own 90-day event history is all that stays. Nothing outside the
  account holds a copy.

## How the remaining gaps could close

- Native apps with reproducible builds, whose code is identical for everyone
  and can be checked, with keys in the phone's security chip.
- An independent relay that hides IP addresses, random notice delays, and a
  setting to turn "seen" receipts off.
- The audit trail and its alerts held by an independent party: an
  organization trail into a locked bucket in another account, which an
  admin of this one can't stop or empty.
- Signing in a separate role, used only by a job of its own, that signs only
  the bundle hashes CI attested, so the deploy role can no longer sign
  whatever it uploads.
- The backend in an attested enclave (such as AWS Nitro Enclaves), so the app
  can check that the server runs this repository's code before talking to
  it. The operator could then no longer learn which Telegram user owns which
  account or mailbox, or match a sender's IP address to an account. Timing
  and IP addresses would still leak, and users would trust AWS's attestation.
- Unforgeable sender tags (anonymous credentials), so blocks hold against
  modified apps.
- A per-message ratchet (Double Ratchet or MLS) and post-quantum key exchange.
- Moving an account to a new phone, and optional multi-device.
