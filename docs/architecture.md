# How it works

An overview of the parts and how a message travels. The exact formats are in
[protocol.md](protocol.md); what this protects and where it stops is in
[security.md](security.md).

## Parts

```mermaid
flowchart LR
  subgraph device["The user's device"]
    app["App<br/>(Telegram Mini App)"]
  end
  subgraph github["GitHub"]
    pages["Pages: the app's files,<br/>built and attested<br/>from this repository"]
  end
  subgraph telegram["Telegram"]
    tg["Telegram's servers"]
  end
  subgraph aws["AWS"]
    bot["bot<br/>/start, the open-app button"]
    api["api<br/>register, sessions, links,<br/>invitations, mailboxes, send,<br/>inbox, tokens, media"]
    ws["ws<br/>WebSocket"]
    notify["notify"]
    s3[("S3<br/>encrypted attachments")]
    db[("DynamoDB<br/>directory, messages,<br/>ephemeral")]
    ssm[("SSM<br/>secrets")]
  end

  pages -- "app files" --> app
  app -- "HTTPS" --> api
  ws -- "sync hint" --> app
  app -- "upload, download" --> s3
  api -- "push" --> ws
  api -- "invoke" --> notify
  api --- db
  api --- ssm
  tg -- "webhook" --> bot
  notify -- "New message" --> tg
```

- **The app** is one static web app (TypeScript, Preact, Vite) that runs as a
  Telegram Mini App. All encryption happens in it, with the browser's own
  WebCrypto. It loads no third-party code at runtime: not even Telegram's
  `telegram-web-app.js`, which changes in place and can't be pinned; a small
  bridge of its own speaks Telegram's documented web-events protocol instead.
- **The backend** is four Go functions on AWS Lambda, one per trust boundary,
  three DynamoDB tables and one S3 bucket. Only `bot` and `notify` can read the
  bot token.
- **The bot** only welcomes people, opens the app, and sends generic notices.
  It never sees content.
- **Hosting:** the app is served by GitHub Pages from a hosting repository in a
  GitHub organization of its own, which builds, attests and deploys it
  ([verifying.md](verifying.md), [hosting/](../hosting/README.md)).

## Accounts

- **Accounts are keys, not Telegram users.** An account is an account key and
  a device key, made on the device. The server knows the account by a random
  ID.
- **Registration happens inside Telegram only**, which gives phone-backed
  anti-spam for free. The app reopens itself through its own link with a code
  derived from the new account key, so Telegram's signed launch data (checked
  with Telegram's Ed25519 key, not the bot token) carries that code. The
  server stores only a keyed hash of the Telegram user ID, to keep one account
  per Telegram user.
- **One device per account.** History lives only on that device. Setting up
  on another device replaces the account, after a typed confirmation: the old
  account's links and mailboxes end at once, and the old device says so, and
  that it may mean tampering. A second device that finds an account elsewhere
  says "your account is on another device" instead of offering setup.
- **Nothing is deleted on the server's word.** A device the server says was
  replaced, or no longer accepts, keeps its chats, readable (nothing can be
  sent), and asks again at every launch and on Try again; if the server lets
  it in, it carries on. Setting up again there deletes everything on the
  device, so it takes a typed confirmation too.
- **Deleting an account** (in the app, after a typed confirmation) removes
  everything the server holds for it at once, keeping no marker, and then
  everything on the device. Nobody is told; messages to its old link and
  mailboxes go nowhere.
- **Several Telegram accounts in one Telegram app** share one storage area, so
  each gets its own local profile on the device, named after a hash of its
  Telegram user ID.
- **Sessions:** the device signs a login with its device key and gets a
  15-minute token. Sensitive actions (links, invitations, admin) also carry a
  fresh signature. Both are timed by the server's clock: if the device's own
  is off, the server says so with its time, and the app corrects for it and
  asks again, without the user seeing an error. Only within two days, though:
  further off, the app asks the user to set the device's date and time. Each
  request reads the device and its account once, so a replaced or deleted
  account is refused at once; logins and registrations check what they can
  before reading anything, and registrations count every attempt that gets
  past the signature checks, per Telegram user.

## Links

A link is `https://t.me/<bot>/<app>?startapp=<payload>`, where the payload
holds a random link ID and the **fingerprint** of the link's signing key. The
server keeps the link's **bundle**: the signing key, its current encryption
key (signed by it), and the link's intro mailbox.

- Opening a link, the app fetches the bundle without logging in and checks
  the fingerprint and signatures before encrypting anything. A server that
  swaps keys is caught. It does so for every link, your own and ones you
  already write to included, so the server can't tell them apart.
- A link opened from Telegram never acts by itself, since anyone can send
  one. If you already write to that person, the app says so and opens the
  chat only when you tap Open. An invitation link asks first and joins only
  when you tap Join.
- An account has one link at a time, and can replace it: the old link stops
  working at once, the new one keeps the same fingerprint, so blocks and labels
  carry over.
- While the service is invite-only, owning a link needs an invitation.
  Anyone with Telegram can set up an account to write to a link.

## Conversations and mailboxes

The server routes by **mailbox**, never by account. A mailbox is a random
128-bit ID owned by one account; the server knows its owner, to deliver, but
never who writes to it. Mailbox IDs only travel inside encrypted messages.

1. A sender opens a link and checks its bundle.
2. Their app makes a conversation ID and a fresh **conversation key** for this
   one conversation, and takes a reply mailbox from a pool it keeps (refilled
   at random times, so taking one doesn't happen right before a send).
3. The first message goes to the link's intro mailbox. Inside the encryption:
   the conversation key, the reply mailbox, a **sender tag** and the text.
4. The owner's app shows a new conversation. When the owner replies, their app
   takes a mailbox of its own for it; from then on each side writes to the
   other's mailbox, and to the other's conversation key. Only reading or
   deleting it takes no mailbox, so a flood of first messages can't use up
   the owner's.

An envelope counts only through the mailbox it belongs to: one written for
the link's key through the link's intro mailbox; one written for a
conversation key through that conversation's own mailbox. The link's intro
mailbox counts for the conversation too until 31 days after the sender first
writes through the owner's mailbox, and so does a mailbox the conversation
moved on from (a new one after unblocking, say), until 31 days after they
first write through the new one. Anything else is dropped as if it couldn't
be opened, so someone who knows a key can't leave envelopes in suspects'
mailboxes and watch whose app answers. The server says which mailbox an
envelope came through.

Each side only ever sees the other as that conversation's key. Two people the
same sender wrote to see unrelated keys and mailboxes, so they can't compare
notes. If the owner also writes to the sender's own link, that's a separate
conversation with nothing shared.

**Labels** like `🦊 K3F9` are computed on the device from the account's own
secret: one person keeps the same label through the same link.

## Messages

- **Encryption:** each message gets a random content key; the body is
  AES-256-GCM, and the content key is wrapped for the recipient's current key
  with HPKE (RFC 9180, P-256, single shot), written against WebCrypto and
  checked with the RFC's test vectors.
- **Authentication:** an HMAC tag with a key both sides can compute. The
  recipient knows who wrote, but can't prove it to anyone else (deniable). The
  server holds neither key, so it can't forge one.
- **Padding:** inner messages are padded to a few fixed sizes.
- **Replies, reactions, edits, "seen", deletes and blocks** are encrypted
  messages too. "Seen"
  is sent the moment a message is read: in a chat opened with a tap in the
  app, while it's in view. After the app was hidden or minimised, "seen"
  waits for the next touch, since bringing it back can be someone else's
  doing (a link). A reaction is one emoji per side per
  message, from a quick row in the long-press menu or the full emoji picker;
  a double-tap reacts with ❤️, as in Telegram.
  Deleting one of your own messages deletes it on both sides by default (the
  other side's app is asked to; see the limits in the security model). A
  whole conversation can be deleted on both sides too, if chosen.
  Your own messages' text and captions can be edited; they show as edited. Blocks are silent: the blocked side's sends
  still look accepted, and new conversations from the same person through the
  same link are dropped by their sender tag.
- **Repeats and order:** envelopes arrive in any order, and the same one can
  come more than once (an out-of-date inbox read, two copies of the app, a
  server that delivers it again). Each conversation remembers, as keyed
  hashes with only the day, which envelopes it took in and which messages
  were deleted, for the 31 days an envelope can still be taken in, so
  nothing that comes again or late undoes what came after it. Even without
  that record each kind is harmless the second time: edits and reactions
  keep the newest, receipts only mark. Only the newest envelope (by the
  sender's clock) changes the key and mailbox used to write back. Deleting
  a whole conversation for both sides takes only what was written before
  it, comparing each side's messages with that side's own clock
  ([protocol.md](protocol.md#inner-message), Replays and order).
- **Key rotation:** conversation and link encryption keys are replaced every
  6 to 9 days, each on its own random schedule, and old private keys are
  deleted 35 days later.

## Sending, delivery and notices

- **Send tokens:** every send spends anonymous tokens, without logging in:
  one per started 2.5 KiB of envelope, so one for anything but a long text
  ([protocol.md](protocol.md#send-tokens-and-media-tokens)). The daily
  budget then bounds what a person's sends cost the database (each token
  buys at most three write units), not just how many there are. Tokens are
  RSA blind signatures (RFC 9474, in Privacy Pass's shape): the app fetches
  a batch while logged in (at most 1,000 a day), and the server can't link
  a spent token to the account it signed it for. The issuer's public key is
  published in [`web/issuer-keys.json`](../web/issuer-keys.json), and the
  app accepts no other, so the server can't tell users apart by key.
- **Media tokens** pay for uploads the same way, one per started MiB, from a
  budget of their own (at most 500 a day, so 500 MiB), signed by a second
  issuer key.
- **Caps:** at most 30 messages a minute to one mailbox, and 60 first messages
  an hour through one link.
- **Delivery:** the server stores each envelope for the mailbox owner's device
  until it confirms it, at most 30 days. Unknown, ended and blocked mailboxes
  get the same answer, and nothing is stored. The device fetches a page at a
  time, capped by size, and confirms by IDs the server signed for it, which
  stay good for one to two hours. What its fetches read is limited per
  minute and per person and day, and confirming messages that are already
  gone per person and day, so no one account can use up the capacity
  everyone shares.
- **Push:** an open app keeps a WebSocket while it's visible. After a delivery,
  the server sends it a content-free "sync" hint, and the app fetches.
- **Notices:** if no app took the push, the bot sends a generic "New message"
  in the user's language: no names, no counts, at most one every 3 minutes,
  replacing the previous one. "Seen" receipts and reactions never trigger one.

## Attachments

Photos, videos, GIFs, files, music, voice messages and round video messages
are encrypted on the device with a fresh key for each file, padded, and
uploaded straight to an S3 bucket with a presigned URL whose exact size is
part of its signature. The upload is paid with media tokens (one per started
MiB, files up to 50 MB), not a login. The message carries the file's key;
the server never sees a key, name or type.

- **Cost guards.** S3 bills every request, and these go past the API. The
  server accepts only the padded sizes the app makes (16 KiB at least). An
  upload URL must start its upload within a minute and writes only once, so
  it can't be replayed for long or overwrite an upload; the bucket refuses
  any PUT that could overwrite, and any presigned request signed over two
  minutes before. A failed upload is tried again (four tries in all, over
  about 40 seconds) without new tokens: each try asks the server, with the
  upload's delete secret, for a fresh URL, which it gives only while nothing
  is stored, three times at most and only in the first three hours after
  payment; once the upload is stored it says so. The app runs two uploads at
  a time and asks for a URL only when one can start. Request metrics on the
  bucket feed alarms on uploads, downloads and the data downloaded.
- **Emergency switches.** If those costs run away, the operator can pause
  uploads or downloads for everyone, with the AWS CLI or from the app's
  admin screen, and no release. They are one settings item in the directory
  table, which each `api` instance reads at most every 30 seconds (keeping
  the last value if a read fails, and counting both as paused until its
  first read). While paused, the API gives out no new upload or download
  URLs, answering before any token is spent or download counted; messages
  keep working. The app says attachments are paused,
  keeps an unsent one to send again, and stops fetching by itself for two
  minutes at a time ([deployment.md](deployment.md#emergency-switches)).
- **Downloads.** A download URL also starts within a minute, and S3 answers
  it uncompressed whatever the upload claimed. The app reads only the padded
  size the message says and stops at once otherwise, so an upload can't
  unpack into something huge on the recipient's device.
- Photos are redrawn on the device (up to 1280 px), which drops their
  metadata; videos keep their pictures but lose location and time metadata;
  voice and video messages are recorded in the app and carry none. Files are
  sent untouched.
- The recipient fetches the upload by its unguessable ID, decrypts it and
  keeps it on the device, encrypted under the device's storage key. Photos,
  voice and video messages and GIFs up to 10 MB download as soon as their
  conversation is open (each kind can be turned off); the rest on a tap.
- **Data and storage** shows the space attachments take, and clears them from
  the device after a month or a week, or on request, keeping their messages.
  A cleared attachment downloads again on a tap while its upload exists.
- **Saving to the device:** a Mini App can't hand a file to the phone, so the
  app uses the share sheet where there is one, and otherwise opens a save page
  in the device's own browser. The file's key travels after the `#` in that
  address, which is never sent to a server.
- The upload is deleted when the recipient deletes the message or the
  conversation, and in any case after 30 days. Deleting is done in the
  background, a few at a time, so a chat with many attachments disappears at
  once; the app keeps a list (sealed under its storage key) and finishes it
  on the next start if it closed halfway. Downloading or saving it
  doesn't, so a cleared attachment can be fetched again meanwhile. The bucket
  keeps no versions and no access logs.

## Emoji and stickers

The panel under the message box has emoji and stickers, as in Telegram.

- **Emoji** are the phone's own, typed into the message: the app ships only the
  list, by category, from Unicode's data (up to Emoji 14.0, so older phones
  show them all; `web/src/emoji/make-data.mjs`). Recently used ones are kept
  in memory only.
- **Stickers:** three packs are part of the app's build (Microsoft's Fluent
  Emoji, MIT licensed). Sending one sends only its name, and nothing is
  uploaded. The app fetches all the images at once when a conversation
  opens, never per sticker, so the host learns nothing about which are used.

## The app on the device

- **Storage:** IndexedDB only. Private keys are non-extractable WebCrypto keys
  where possible; keys that must stay copyable are sealed under a
  non-extractable vault key. History and attachments are encrypted under a
  non-extractable storage key.
- **Several copies at once** (a reopened app, several windows) share storage,
  so they coordinate with Web Locks and announce changes over a
  BroadcastChannel.
- **Lockdown:** a strict Content Security Policy (only the app's own scripts;
  connections only to the API, the socket and the bucket), Trusted Types, one
  deterministic JavaScript file, and no code or settings loaded from the
  backend.
- **Languages:** English and Persian, right-to-left included, with Telegram's
  theme mapped onto the app's own colours.

## The backend

| Function | Entry | Can read |
|---|---|---|
| `bot` | Telegram webhook (function URL, checked with a random webhook secret) | the bot token |
| `api` | all HTTPS routes (function URL, optionally behind CloudFront and a firewall; see [deployment.md](deployment.md#cloudfront-in-front-of-the-api)) | the session key, the Telegram-ID pepper, the send-token and media-token issuer keys; the tables; the bucket |
| `ws` | WebSocket connect (one record each, about 5 a minute per account; closing isn't routed) | the session key; socket records only |
| `notify` | invoked by `api` | the bot token and the key that opens chat IDs |

| Table | Holds | Expires |
|---|---|---|
| `directory` | accounts (keyed Telegram-ID hash, sealed chat ID, public keys, invitation level), links and bundles, mailbox owners, invitations; the operator's settings (allowance per invitation level, the emergency switches) | mailboxes expire |
| `messages` | one item per undelivered envelope: the device, the mailbox, the ciphertext. No sender, no account | 30 days |
| `ephemeral` | socket connections, rate counters, login nonces, spent send and media tokens, upload records (size, the hash of a delete secret, and how many fresh upload URLs it was given) | minutes to 30 days |

- No precise timestamps: keys are random IDs, and times are rounded.
- Point-in-time recovery stays off, so deleted data can't be restored.
- Limits: each table takes at most 400 read and 200 write units a second
  and refuses the rest, which caps the bill (about $51 a day with all three
  at their caps). In production a firewall in front of the API's CloudFront
  limits requests per IP address (2,000 in 5 minutes), and on the routes
  that need no login (logins, registrations, sends, and lookups of
  accounts, links and attachments) both per address (500 in 5 minutes) and
  for everyone together (12,000 a minute, below what the directory can
  serve), so a flood there can't use up what logged-in requests need. The
  API answers over IPv4 only, since the firewall would count each IPv6
  address on its own ([deployment.md](deployment.md#the-firewall)).
- Secrets live in SSM, written through Terraform's write-only arguments, so they
  never land in Terraform state. Each function's role reads only its own.
- Logs: warnings and errors only, kept 7 days. IDs, IP addresses, user agents
  and bodies are never logged, and there are no API access logs.
- Code signing: the functions run only code signed by CI's AWS Signer
  profile, and each deploy checks that the running code is the attested build
  ([verifying.md](verifying.md#the-backend)).
