# Changelog

## [2.6.0](https://github.com/incognitochat/incognitochat/compare/v2.5.0...v2.6.0) (2026-11-20)


### Features

* delete accounts nobody has used for a year ([#194](https://github.com/incognitochat/incognitochat/issues/194)) ([da65d1b](https://github.com/incognitochat/incognitochat/commit/da65d1b8a58422a4d4278037f8bcfb071bf13069))
* delete attachments in batches ([#188](https://github.com/incognitochat/incognitochat/issues/188)) ([03282b6](https://github.com/incognitochat/incognitochat/commit/03282b6a1ef48a9806e3e9108f139d3cce3e6603))
* **infra:** an audit trail of account changes, with alerts ([#187](https://github.com/incognitochat/incognitochat/issues/187)) ([b407948](https://github.com/incognitochat/incognitochat/commit/b4079482856b888658b8dac30602aaa3dad39ad4))
* keep deleted link IDs, forget notice data when off, and clearer refusals ([#189](https://github.com/incognitochat/incognitochat/issues/189)) ([919ce08](https://github.com/incognitochat/incognitochat/commit/919ce08d82400d0a16ec7718714dcdada0b0ab00))
* keep the admins' Telegram IDs in encrypted storage ([#191](https://github.com/incognitochat/incognitochat/issues/191)) ([fe3a61a](https://github.com/incognitochat/incognitochat/commit/fe3a61adbba66f041f80cdf4012eed235cab1d16))
* **web:** correct English counts, and a language switch ([#196](https://github.com/incognitochat/incognitochat/issues/196)) ([bbcb4cc](https://github.com/incognitochat/incognitochat/commit/bbcb4cc57b413b15ee655ead62dcce47cc2e1d47))
* **web:** keep the draft during an edit, and resend messages that didn't go ([#195](https://github.com/incognitochat/incognitochat/issues/195)) ([6a1b203](https://github.com/incognitochat/incognitochat/commit/6a1b2038c204045f449644d4927b46968a8768e7))
* **web:** readable colours, and keyboard and screen-reader use ([#193](https://github.com/incognitochat/incognitochat/issues/193)) ([e364600](https://github.com/incognitochat/incognitochat/commit/e364600869aa51ce6173141ce2fc829b9a619649))


### Bug Fixes

* **ci:** stop the version check failing when grep stops early ([#197](https://github.com/incognitochat/incognitochat/issues/197)) ([0feed58](https://github.com/incognitochat/incognitochat/commit/0feed58ee474d90f131d523a13978aa7221c0757))
* **media:** attachments don't hint which phone sent them ([#192](https://github.com/incognitochat/incognitochat/issues/192)) ([167dd17](https://github.com/incognitochat/incognitochat/commit/167dd175b9f8dbed4c971694a2a0ce68112cea59))

## [2.5.0](https://github.com/incognitochat/incognitochat/compare/v2.4.0...v2.5.0) (2026-11-19)


### Features

* **infra:** alarms for the functions, sockets, tables and edge ([#176](https://github.com/incognitochat/incognitochat/issues/176)) ([f0d4923](https://github.com/incognitochat/incognitochat/commit/f0d49232d2d6af6a5ef5c9377486bf46da7bbea0))
* **infra:** forward only what the API needs, and an IP block list for incidents ([#179](https://github.com/incognitochat/incognitochat/issues/179)) ([3568a27](https://github.com/incognitochat/incognitochat/commit/3568a278fc40771b1f441e3c3ac35285f1428fdb))


### Bug Fixes

* **api:** backend hardening from the low audit findings ([#172](https://github.com/incognitochat/incognitochat/issues/172)) ([38512a2](https://github.com/incognitochat/incognitochat/commit/38512a2f4255197a4ab7173c7371e67a1ae0011d))
* **crypto:** uniform blinding factor, and fixed test vectors on both sides ([#180](https://github.com/incognitochat/incognitochat/issues/180)) ([0db4ceb](https://github.com/incognitochat/incognitochat/commit/0db4cebe8ac755d64e7c0b806074c785c24af4b7))
* **hosting:** build the site only for the commit CI names ([#166](https://github.com/incognitochat/incognitochat/issues/166)) ([e760dd8](https://github.com/incognitochat/incognitochat/commit/e760dd85af463b561f4a083462474c06b93fb4ac))
* **hosting:** deploy the site only forward unless a rollback is asked for ([#169](https://github.com/incognitochat/incognitochat/issues/169)) ([2abae4b](https://github.com/incognitochat/incognitochat/commit/2abae4bbcda2b1e0114fc322c89852117d5668f8))
* **media:** strip more video metadata and bound the MP4 parser ([#182](https://github.com/incognitochat/incognitochat/issues/182)) ([5d7fa02](https://github.com/incognitochat/incognitochat/commit/5d7fa0243292ab41fbc89c033b1a2efb9f6a1d94))
* **web:** clean what peers send before showing or saving it ([#183](https://github.com/incognitochat/incognitochat/issues/183)) ([e5503c4](https://github.com/incognitochat/incognitochat/commit/e5503c4a5e455935b7dbe1587179cddb581bf74a))
* **web:** lock fallback and timing-safe refills ([#170](https://github.com/incognitochat/incognitochat/issues/170)) ([64bc69d](https://github.com/incognitochat/incognitochat/commit/64bc69d29ffdc8e8831c83906cc5376114a05da7))
* **web:** no orphaned records, and fewer uploads left after deletion ([#178](https://github.com/incognitochat/incognitochat/issues/178)) ([b01b491](https://github.com/incognitochat/incognitochat/commit/b01b491fa3c894c98d65cfa110696a90be65fa55))
* **web:** sturdier error paths, upload watchdog and reload handling ([#185](https://github.com/incognitochat/incognitochat/issues/185)) ([66ccb26](https://github.com/incognitochat/incognitochat/commit/66ccb26414fece2fea1a76f19d8ab809fb067062))

## [2.4.0](https://github.com/incognitochat/incognitochat/compare/v2.3.0...v2.4.0) (2026-11-18)


### Features

* **api:** count limit hits and abuse signals, without identifiers ([#162](https://github.com/incognitochat/incognitochat/issues/162)) ([0f7013e](https://github.com/incognitochat/incognitochat/commit/0f7013e2017701b7dd112aa4fe417b911152e6aa))
* rotate token issuer keys without breaking open apps ([#164](https://github.com/incognitochat/incognitochat/issues/164)) ([b0a0fbf](https://github.com/incognitochat/incognitochat/commit/b0a0fbf311cfcef1b3f8201b1e4809d1aa0d45bf))


### Bug Fixes

* **api:** end replaced and deleted accounts at once, then clean up in steps ([#150](https://github.com/incognitochat/incognitochat/issues/150)) ([7b83a06](https://github.com/incognitochat/incognitochat/commit/7b83a0630e4678cd71008000d7bcebc9abe9d930))
* **api:** one account per link signing key ([#159](https://github.com/incognitochat/incognitochat/issues/159)) ([b222af6](https://github.com/incognitochat/incognitochat/commit/b222af6fe111e365db6fa5bb9f4ddf7a30120c19))
* **api:** sign tokens with CRT and fail fast under throttling ([#151](https://github.com/incognitochat/incognitochat/issues/151)) ([68c1c1f](https://github.com/incognitochat/incognitochat/commit/68c1c1fab5de5cc7bcd5a361db33af243321e0e3))
* **infra:** rotate each generated secret on its own ([#155](https://github.com/incognitochat/incognitochat/issues/155)) ([cc0ee01](https://github.com/incognitochat/incognitochat/commit/cc0ee014c619448422d4a68ee6c2a89e69c4121b))
* **init:** deny the deploy role data reads and lasting access ([#163](https://github.com/incognitochat/incognitochat/issues/163)) ([15f78aa](https://github.com/incognitochat/incognitochat/commit/15f78aac595f3ba193b193064ef38f9f81c6ca9b))
* **init:** let functions only post to sockets ([#154](https://github.com/incognitochat/incognitochat/issues/154)) ([4df3177](https://github.com/incognitochat/incognitochat/commit/4df31775a538d73d6071413f37b5cdee83824813))
* **web:** bound what a flooding sender can store, and open big chats quickly ([#160](https://github.com/incognitochat/incognitochat/issues/160)) ([1ddaaef](https://github.com/incognitochat/incognitochat/commit/1ddaaef34ce40e0dbb1f4f7df0e07953948fd26b))
* **web:** cap automatic downloads, and cancel deleted sends ([#157](https://github.com/incognitochat/incognitochat/issues/157)) ([432028f](https://github.com/incognitochat/incognitochat/commit/432028f1a61b96df5b497e617cda2b8469e4c5c2))
* **web:** keep attachments out of the cache, and say plainly what a wipe leaves ([#156](https://github.com/incognitochat/incognitochat/issues/156)) ([bdeb636](https://github.com/incognitochat/incognitochat/commit/bdeb63659f040462633d16a0ba421bb53123c2b3))
* **web:** keep link keys after a lost answer, and never reuse a shown token ([#149](https://github.com/incognitochat/incognitochat/issues/149)) ([e9156fd](https://github.com/incognitochat/incognitochat/commit/e9156fdeceaeb60963d7040b3ca22e1071051d38))
* **web:** send message times in server seconds ([#161](https://github.com/incognitochat/incognitochat/issues/161)) ([d63ccd0](https://github.com/incognitochat/incognitochat/commit/d63ccd0ee58e59610c1a1e5c8093ca6e66c849eb))
* **web:** show new messages in an open chat, in order, when clocks differ ([#165](https://github.com/incognitochat/incognitochat/issues/165)) ([6b7ab4b](https://github.com/incognitochat/incognitochat/commit/6b7ab4b641caac6880b3252ca849bb05198fede7))

## [2.3.0](https://github.com/incognitochat/incognitochat/compare/v2.2.0...v2.3.0) (2026-11-18)


### Features

* 500 MB of uploads a day, 4,000 chats in all, clearer Usage screen ([#128](https://github.com/incognitochat/incognitochat/issues/128)) ([348a100](https://github.com/incognitochat/incognitochat/commit/348a1006f9657902ef524d4f9dc2ab7000c753cc))
* a Usage screen and a low-balance notice ([#127](https://github.com/incognitochat/incognitochat/issues/127)) ([a869390](https://github.com/incognitochat/incognitochat/commit/a869390a6f90c5a2ab417223f3b6f0636eea68be))
* **api:** 1,000 send tokens a day, 5 notice setups ([#117](https://github.com/incognitochat/incognitochat/issues/117)) ([bbeef16](https://github.com/incognitochat/incognitochat/commit/bbeef16d26e4220c46a731610bfa6de77bb6f245))
* **api:** count daily limits per Telegram user ([#126](https://github.com/incognitochat/incognitochat/issues/126)) ([8ef45ad](https://github.com/incognitochat/incognitochat/commit/8ef45adb78373fdc93e52575e0fd473f35a68ebe))
* **api:** create or replace a link at most 5 times a day ([#118](https://github.com/incognitochat/incognitochat/issues/118)) ([715ea07](https://github.com/incognitochat/incognitochat/commit/715ea07971cb2708565b12517a0bec711ca08eb9))
* delete accounts in steps, and allow 2,000 mailboxes ([#121](https://github.com/incognitochat/incognitochat/issues/121)) ([9bded73](https://github.com/incognitochat/incognitochat/commit/9bded73ff4fc38f357aa8d2060bf196aac94d2e0))
* files up to 50 MB ([#123](https://github.com/incognitochat/incognitochat/issues/123)) ([4b42803](https://github.com/incognitochat/incognitochat/commit/4b4280313a7a41b414fda60158a8aad15456e512))
* media tokens pay for uploads, from their own daily budget ([#116](https://github.com/incognitochat/incognitochat/issues/116)) ([5d5689c](https://github.com/incognitochat/incognitochat/commit/5d5689c515d02c9e59a532834b0b6e96ed756aab))
* **media:** emergency switches to pause uploads or downloads without a release ([#141](https://github.com/incognitochat/incognitochat/issues/141)) ([718cd6f](https://github.com/incognitochat/incognitochat/commit/718cd6f4531d02cdfc065b12b374336cf169d081))
* tighter limits: 3 setups a day, 5 downloads per file, 30-day uploads, 2,000 requests per IP ([#122](https://github.com/incognitochat/incognitochat/issues/122)) ([d6f36de](https://github.com/incognitochat/incognitochat/commit/d6f36de2887e9440b5deb494284e34a809afa4c4))
* **web:** a chat started through your link takes a mailbox only when you reply ([#120](https://github.com/incognitochat/incognitochat/issues/120)) ([8bba023](https://github.com/incognitochat/incognitochat/commit/8bba0237fcc0e1de37972f1178283c1ed7932366))
* **web:** edit a message only within 24 hours of sending ([#124](https://github.com/incognitochat/incognitochat/issues/124)) ([a8efa4c](https://github.com/incognitochat/incognitochat/commit/a8efa4c3aa6c457631d08f481b49177eca031e79))
* **web:** show who started each chat ([#119](https://github.com/incognitochat/incognitochat/issues/119)) ([5cf1162](https://github.com/incognitochat/incognitochat/commit/5cf1162f355907c3c5dc9844c257bd9a745f0cc5))


### Bug Fixes

* **api:** answer sends without waiting for the push; key short-lived rows by HMAC ([#145](https://github.com/incognitochat/incognitochat/issues/145)) ([1e881f7](https://github.com/incognitochat/incognitochat/commit/1e881f7a94fd1772b590825a3b49fd473adf666e))
* **api:** charge send tokens by envelope size ([#144](https://github.com/incognitochat/incognitochat/issues/144)) ([f9aa0da](https://github.com/incognitochat/incognitochat/commit/f9aa0dacc850714010f169d8237aca698941cfc6))
* **api:** count new mailboxes, not requests: 100 a day ([#125](https://github.com/incognitochat/incognitochat/issues/125)) ([f57adfe](https://github.com/incognitochat/incognitochat/commit/f57adfe81758689f5c8ec8ae04fd901b44df3264))
* **api:** make inbox fetches and confirmations cheap and limited ([#133](https://github.com/incognitochat/incognitochat/issues/133)) ([0c32f67](https://github.com/incognitochat/incognitochat/commit/0c32f67c7ad97d5962ed6abd25d0891bb29ab73b))
* **api:** read less from the directory before limits and on every request ([#135](https://github.com/incognitochat/incognitochat/issues/135)) ([2719659](https://github.com/incognitochat/incognitochat/commit/27196591cd9dd26c98f417e37f8434d14d91ef58))
* **ci:** the site builds the release tag, never a branch of the same name ([#138](https://github.com/incognitochat/incognitochat/issues/138)) ([0aae82a](https://github.com/incognitochat/incognitochat/commit/0aae82aca9fcf0fe54cdd14db77911f415f0cccc))
* handle wrong device clocks and never wipe on the server's word ([#136](https://github.com/incognitochat/incognitochat/issues/136)) ([2fd813c](https://github.com/incognitochat/incognitochat/commit/2fd813cac64f176e5f7316a336befd9816c50abd))
* **infra:** rate-limit the routes that need no login and raise production's table caps ([#143](https://github.com/incognitochat/incognitochat/issues/143)) ([98f2c93](https://github.com/incognitochat/incognitochat/commit/98f2c932b3ad76dfc7f341d22cb16a2f7374589d))
* **media:** download links last one minute ([#114](https://github.com/incognitochat/incognitochat/issues/114)) ([6f8f000](https://github.com/incognitochat/incognitochat/commit/6f8f0005e8684f5f1019eb73a1e7009cf14c9c1b))
* **media:** upload links write once and start within a minute ([#139](https://github.com/incognitochat/incognitochat/issues/139)) ([d9640fb](https://github.com/incognitochat/incognitochat/commit/d9640fbdf1cd8e18c10500e4640ff25bfebcd3ae))
* **notices:** send before deleting, honour retry_after, narrow notify's access ([#148](https://github.com/incognitochat/incognitochat/issues/148)) ([fdbef9f](https://github.com/incognitochat/incognitochat/commit/fdbef9f2cb205ad6b5c32e1b594af23cf7c78f80))
* **verify:** check the site's manifest, repository, commit and signing workflow ([#147](https://github.com/incognitochat/incognitochat/issues/147)) ([784f01e](https://github.com/incognitochat/incognitochat/commit/784f01e1aa3ab7e029dd561076695c7261c5a71c))
* **web:** a link opened from Telegram waits for a tap ([#132](https://github.com/incognitochat/incognitochat/issues/132)) ([e3c474e](https://github.com/incognitochat/incognitochat/commit/e3c474e6a478a2ad72a92d2d92da805583d62c1e))
* **web:** accept envelopes only through the mailbox they belong to ([#140](https://github.com/incognitochat/incognitochat/issues/140)) ([914c440](https://github.com/incognitochat/incognitochat/commit/914c4406aae8c2b3ccde60815aafae196d1afbd0))
* **web:** envelopes that come again or late undo nothing ([#142](https://github.com/incognitochat/incognitochat/issues/142)) ([7d6023c](https://github.com/incognitochat/incognitochat/commit/7d6023c8ac63650781410db6f70ec00d10e7de2e))
* **web:** keep message and conversation IDs within their conversation ([#134](https://github.com/incognitochat/incognitochat/issues/134)) ([0d9f746](https://github.com/incognitochat/incognitochat/commit/0d9f746b5373d274c5ea2632c2376ef3bab1010e))
* **web:** plain links are grey, only destructive ones red ([#129](https://github.com/incognitochat/incognitochat/issues/129)) ([2a3b24b](https://github.com/incognitochat/incognitochat/commit/2a3b24bd75be30c21c0b8ab0dc8f4f8b0b6dcbf2))
* **ws:** one write per socket connect, bounded records, no disconnect route ([#137](https://github.com/incognitochat/incognitochat/issues/137)) ([16a0b28](https://github.com/incognitochat/incognitochat/commit/16a0b2836f87d974add7d5d0a3c24834b8fb6b68))

## [2.2.0](https://github.com/incognitochat/incognitochat/compare/v2.1.0...v2.2.0) (2026-11-14)


### Features

* **infra:** a monthly budget and alarms for each account ([#108](https://github.com/incognitochat/incognitochat/issues/108)) ([e05cdee](https://github.com/incognitochat/incognitochat/commit/e05cdee0b9b70df56f18e1332319689b3e3ca80e))
* **infra:** CloudFront in front of the API, with an optional firewall ([#111](https://github.com/incognitochat/incognitochat/issues/111)) ([0c88215](https://github.com/incognitochat/incognitochat/commit/0c88215947c907ee4cfe26e06245a67b97e6ac2f))
* **infra:** optional reserved concurrency per function ([#107](https://github.com/incognitochat/incognitochat/issues/107)) ([44c22f6](https://github.com/incognitochat/incognitochat/commit/44c22f6914632c4ec0272e63ec499046d07b2f08))
* prepare the API for CloudFront in front of it ([#110](https://github.com/incognitochat/incognitochat/issues/110)) ([a1522b9](https://github.com/incognitochat/incognitochat/commit/a1522b90dbbfbba9493edeb4b6782d842d72c315))
* **ws:** push to an account's five newest sockets only ([#109](https://github.com/incognitochat/incognitochat/issues/109)) ([7600cac](https://github.com/incognitochat/incognitochat/commit/7600cac2f608972c15f26df3c7cf9bb3e83b0992))


### Bug Fixes

* **api:** a replayed send token no longer uses up a mailbox's limit ([#106](https://github.com/incognitochat/incognitochat/issues/106)) ([b2af4ca](https://github.com/incognitochat/incognitochat/commit/b2af4ca7971614c3731584a75bcf1d3f3c935dd6))
* **infra:** a firewall description AWS accepts ([#112](https://github.com/incognitochat/incognitochat/issues/112)) ([0a994ff](https://github.com/incognitochat/incognitochat/commit/0a994ff5d3ecab7541a6399790ab51c66719a63c))
* **infra:** detach the firewall before deleting it ([#113](https://github.com/incognitochat/incognitochat/issues/113)) ([1dd1e3a](https://github.com/incognitochat/incognitochat/commit/1dd1e3aec25a9192ee7ea4adcf8bcf522a08759a))


### Performance Improvements

* **web:** delete uploads in the background, a few at a time ([#103](https://github.com/incognitochat/incognitochat/issues/103)) ([527919b](https://github.com/incognitochat/incognitochat/commit/527919b8910b95d351653ba170bec98809f946d2))

## [2.1.0](https://github.com/incognitochat/incognitochat/compare/v2.0.0...v2.1.0) (2026-11-14)


### Features

* delete a whole conversation for both sides ([#101](https://github.com/incognitochat/incognitochat/issues/101)) ([afaa83d](https://github.com/incognitochat/incognitochat/commit/afaa83d076a9e20ef551e1b4164bf47554272c0e))
* delete your own messages for both sides ([#100](https://github.com/incognitochat/incognitochat/issues/100)) ([f4d89d9](https://github.com/incognitochat/incognitochat/commit/f4d89d9f3bc2de6c08a9953bdb67ee711ebc5eb4))
* edit your own messages ([#102](https://github.com/incognitochat/incognitochat/issues/102)) ([2cbf687](https://github.com/incognitochat/incognitochat/commit/2cbf687ed9a9e0aa56af6abeff146ea0f2aab9d2))
* reactions to messages, end-to-end encrypted ([#91](https://github.com/incognitochat/incognitochat/issues/91)) ([033572b](https://github.com/incognitochat/incognitochat/commit/033572baf4dbad43abfc3ffe6dce41f2056f2542))
* **web:** a message's whole row takes its gestures ([#98](https://github.com/incognitochat/incognitochat/issues/98)) ([0771c22](https://github.com/incognitochat/incognitochat/commit/0771c22a9dff7ea615db9e131b9ebe90b2abd6cf))
* **web:** an emoji panel next to the stickers, as in Telegram ([#90](https://github.com/incognitochat/incognitochat/issues/90)) ([7be1579](https://github.com/incognitochat/incognitochat/commit/7be1579c41dfb4117a92e9d650453e27109be082))
* **web:** data and storage settings for attachments ([#88](https://github.com/incognitochat/incognitochat/issues/88)) ([db1f3b1](https://github.com/incognitochat/incognitochat/commit/db1f3b1856a86f7165ff66d15419a86390f03230))
* **web:** double-tap a message to react with a red heart ([#92](https://github.com/incognitochat/incognitochat/issues/92)) ([be44b87](https://github.com/incognitochat/incognitochat/commit/be44b87de859f29f8860eb2606011ac992253bd5))
* **web:** the time on the text's last line, or on the reaction row ([#94](https://github.com/incognitochat/incognitochat/issues/94)) ([4f731f1](https://github.com/incognitochat/incognitochat/commit/4f731f1db8f3f41b6f5e1bf2654415b96e9b763f))


### Bug Fixes

* **web:** a long press never starts a text selection ([#96](https://github.com/incognitochat/incognitochat/issues/96)) ([aa9afc0](https://github.com/incognitochat/incognitochat/commit/aa9afc01e40f58e90eacd0bde8a0f3bbf6071657))
* **web:** a message grows upward when its reactions change ([#93](https://github.com/incognitochat/incognitochat/issues/93)) ([bb6fde7](https://github.com/incognitochat/incognitochat/commit/bb6fde7f1eeac540b6e908d6290a3afab08909cd))
* **web:** saving an attachment keeps its server copy ([#99](https://github.com/incognitochat/incognitochat/issues/99)) ([a2fe605](https://github.com/incognitochat/incognitochat/commit/a2fe60580f817201b3b00611e5aed67ca993a0e5))
* **web:** taking a reaction back at the end of a chat keeps the message in place ([#95](https://github.com/incognitochat/incognitochat/issues/95)) ([f809b10](https://github.com/incognitochat/incognitochat/commit/f809b1007867e431a7a67f733a001068f6950b13))
* **web:** the back button closes what's open on top first ([#97](https://github.com/incognitochat/incognitochat/issues/97)) ([3bf257c](https://github.com/incognitochat/incognitochat/commit/3bf257cbc43f690a46ba91494156d7145cc0b973))

## [2.0.0](https://github.com/incognitochat/incognitochat/compare/v1...v2.0.0) (2026-11-13)


### ⚠ BREAKING CHANGES

* v2, end-to-end encrypted messaging in a Mini App ([#58](https://github.com/incognitochat/incognitochat/issues/58))

### Features

* anonymous send tokens (blind RSA) ([#41](https://github.com/incognitochat/incognitochat/issues/41)) ([9d31445](https://github.com/incognitochat/incognitochat/commit/9d3144568ec59f44cc7a8022f6aa8d63b99b1ec0))
* **backend:** auth core for v2 ([#26](https://github.com/incognitochat/incognitochat/issues/26)) ([b30c199](https://github.com/incognitochat/incognitochat/commit/b30c1991539fcf9a39809503b12dd334ed1a0150))
* **backend:** invitations with levels, allowances and admin grants ([#34](https://github.com/incognitochat/incognitochat/issues/34)) ([1a46e1e](https://github.com/incognitochat/incognitochat/commit/1a46e1ea5c5056b49e5de818bf4e14a1fd472394))
* **backend:** links with signed bundles, create, rotate and revoke ([#32](https://github.com/incognitochat/incognitochat/issues/32)) ([744af7e](https://github.com/incognitochat/incognitochat/commit/744af7ed02809a910f93b573df2c2b4651e9df9a))
* **backend:** mailboxes and delivery ([#40](https://github.com/incognitochat/incognitochat/issues/40)) ([3089dee](https://github.com/incognitochat/incognitochat/commit/3089deeec0781848e82c53026c82d258ee53d026))
* **backend:** registration and device login ([#29](https://github.com/incognitochat/incognitochat/issues/29)) ([bdef371](https://github.com/incognitochat/incognitochat/commit/bdef3719b0dbefec9e434848dfc7462e58fb97e6))
* **bot:** open-app replies, tidy service messages, self-registered webhook ([#36](https://github.com/incognitochat/incognitochat/issues/36)) ([73feeab](https://github.com/incognitochat/incognitochat/commit/73feeab6091aba130df45f9ff7c3ea061ba41eb4))
* **ci:** build, attest and deploy the client from the hosting repository ([#37](https://github.com/incognitochat/incognitochat/issues/37)) ([2e4ad97](https://github.com/incognitochat/incognitochat/commit/2e4ad970f6e74672fce9c74ecffebf10c6b823df))
* **ci:** release with release-please and deploy releases to production ([#84](https://github.com/incognitochat/incognitochat/issues/84)) ([45b660c](https://github.com/incognitochat/incognitochat/commit/45b660ca4b09042a4345f9239d14311444ae12ff))
* delete an account ([#81](https://github.com/incognitochat/incognitochat/issues/81)) ([43a392c](https://github.com/incognitochat/incognitochat/commit/43a392c67b60be610ef6f09949912edd046bdca8))
* encrypted media uploads (server side) ([#62](https://github.com/incognitochat/incognitochat/issues/62)) ([fb75ad2](https://github.com/incognitochat/incognitochat/commit/fb75ad2ce9e18731c0403e6a35091ad9b4cede1b))
* **infra:** run only CI-signed Lambda code, and attest and check each deploy ([#83](https://github.com/incognitochat/incognitochat/issues/83)) ([d2292fd](https://github.com/incognitochat/incognitochat/commit/d2292fd8f17a97a7caae1c46648b3994a8e16b9f))
* **infra:** v2 infrastructure and dev deploys ([#27](https://github.com/incognitochat/incognitochat/issues/27)) ([16e7c77](https://github.com/incognitochat/incognitochat/commit/16e7c773f2b84b5fcc2c089d3dd28f718b12c146))
* one link per account, replaceable ([#49](https://github.com/incognitochat/incognitochat/issues/49)) ([a7dcb91](https://github.com/incognitochat/incognitochat/commit/a7dcb91cc37a13f21033c27a4714a71d740f65b8))
* push to open apps over WebSocket ([#53](https://github.com/incognitochat/incognitochat/issues/53)) ([03118b2](https://github.com/incognitochat/incognitochat/commit/03118b29dded473f2e4c97ef4a6123762b320e06))
* say when the account is on another device ([#52](https://github.com/incognitochat/incognitochat/issues/52)) ([9317da8](https://github.com/incognitochat/incognitochat/commit/9317da8c14d92be7e071a1d8f19454f3833db8d5))
* Telegram notices for new messages ([#47](https://github.com/incognitochat/incognitochat/issues/47)) ([b699bf7](https://github.com/incognitochat/incognitochat/commit/b699bf71007131b12a9a147a0d9315f447a11b68))
* v2 skeleton with reproducible builds ([#25](https://github.com/incognitochat/incognitochat/issues/25)) ([030b30d](https://github.com/incognitochat/incognitochat/commit/030b30d894f8db0c5f9ace5991f678ac1c187600))
* v2, end-to-end encrypted messaging in a Mini App ([#58](https://github.com/incognitochat/incognitochat/issues/58)) ([f1b6bb1](https://github.com/incognitochat/incognitochat/commit/f1b6bb120133cefbf88e6c4d9686a3e7ae44aab6))
* **web:** a message bar like Telegram's ([#77](https://github.com/incognitochat/incognitochat/issues/77)) ([9d0725b](https://github.com/incognitochat/incognitochat/commit/9d0725b7c44cc68c8e0a84b898d8f613cc5e64bb))
* **web:** attachments core (encryption, upload, download) ([#63](https://github.com/incognitochat/incognitochat/issues/63)) ([dd9fa71](https://github.com/incognitochat/incognitochat/commit/dd9fa71ddb0a4dfda51bdda9fd063f979e0b68c4))
* **web:** chats, conversations and writing to links ([#43](https://github.com/incognitochat/incognitochat/issues/43)) ([740f14a](https://github.com/incognitochat/incognitochat/commit/740f14a810ad148bb8ded8bc4cf4da1adf3d543e))
* **web:** check marks, and deleting conversations ([#48](https://github.com/incognitochat/incognitochat/issues/48)) ([c07adb5](https://github.com/incognitochat/incognitochat/commit/c07adb50d6a59a36e34f7f6015f0dd0fc345f129))
* **web:** client core for v2 ([#28](https://github.com/incognitochat/incognitochat/issues/28)) ([696a737](https://github.com/incognitochat/incognitochat/commit/696a7373ba4ab6894fe2e882a6cb6aeafe06b29e))
* **web:** create, share and revoke links, and check links others share ([#33](https://github.com/incognitochat/incognitochat/issues/33)) ([7d4d409](https://github.com/incognitochat/incognitochat/commit/7d4d4096d14b3f627c4a3e17ce5c35ceeccd59d9))
* **web:** join with an invitation, invite others, and admin settings ([#35](https://github.com/incognitochat/incognitochat/issues/35)) ([1447ca7](https://github.com/incognitochat/incognitochat/commit/1447ca7e4ef30ed251150035d026d708c753e500))
* **web:** live delivery over the push socket ([#54](https://github.com/incognitochat/incognitochat/issues/54)) ([59b89ac](https://github.com/incognitochat/incognitochat/commit/59b89ac0c55290292fd68a2909d1febc764cb716))
* **web:** message crypto, HPKE, envelopes and authenticated messages ([#39](https://github.com/incognitochat/incognitochat/issues/39)) ([226b5f4](https://github.com/incognitochat/incognitochat/commit/226b5f49e492a0621944093286535694aa83bd85))
* **web:** messaging engine, conversations and history on the device ([#42](https://github.com/incognitochat/incognitochat/issues/42)) ([0ba0c9a](https://github.com/incognitochat/incognitochat/commit/0ba0c9a4d1e047082829ce43abc455dd2b9da981))
* **web:** photos and files in conversations ([#65](https://github.com/incognitochat/incognitochat/issues/65)) ([0c17efe](https://github.com/incognitochat/incognitochat/commit/0c17efeb6c0c3f250d22b48fa57826add3cd1099))
* **web:** replies, and a message menu ([#61](https://github.com/incognitochat/incognitochat/issues/61)) ([eeb23ff](https://github.com/incognitochat/incognitochat/commit/eeb23ff81694b96bc40432955592d43941a0080f))
* **web:** round video messages, and hold to record ([#72](https://github.com/incognitochat/incognitochat/issues/72)) ([22f0210](https://github.com/incognitochat/incognitochat/commit/22f021024a6bfc66d1514cd26364ed5c7632fd2b))
* **web:** save photos and files through the device's browser ([#67](https://github.com/incognitochat/incognitochat/issues/67)) ([f9aeb1f](https://github.com/incognitochat/incognitochat/commit/f9aeb1f6ccca3c883a057318eb495e305b21815c))
* **web:** seen receipts and silent blocks ([#46](https://github.com/incognitochat/incognitochat/issues/46)) ([9fb5bc4](https://github.com/incognitochat/incognitochat/commit/9fb5bc426b6af8fdaa30e11c46ece7659d6f86c5))
* **web:** set up an account from Telegram ([#30](https://github.com/incognitochat/incognitochat/issues/30)) ([2a7e8ff](https://github.com/incognitochat/incognitochat/commit/2a7e8ffcb44b64d3747e5c7e9d60e10996df6e52))
* **web:** stickers ([#73](https://github.com/incognitochat/incognitochat/issues/73)) ([9555f8e](https://github.com/incognitochat/incognitochat/commit/9555f8e8bd844bec4b3912d5fa655e20e21fbe0a))
* **web:** Telegram-style chat scrolling, and seen only when in view ([#50](https://github.com/incognitochat/incognitochat/issues/50)) ([34831ce](https://github.com/incognitochat/incognitochat/commit/34831ce1383546f61fe37e9ff66206bd500b86a3))
* **web:** unblock, and blocking only when asked for ([#55](https://github.com/incognitochat/incognitochat/issues/55)) ([b5b156f](https://github.com/incognitochat/incognitochat/commit/b5b156fe105cc684858a93e44ec9c5172c691e2c))
* **web:** videos and GIFs in conversations ([#68](https://github.com/incognitochat/incognitochat/issues/68)) ([5aa5333](https://github.com/incognitochat/incognitochat/commit/5aa53334721bca37e96df643a3e85dbe265d840f))
* **web:** voice messages and music ([#71](https://github.com/incognitochat/incognitochat/issues/71)) ([d6738f5](https://github.com/incognitochat/incognitochat/commit/d6738f5e7412aa0261771eb9132fbc18af6d976b))
* **web:** weekly key rotation, and deleting old keys ([#51](https://github.com/incognitochat/incognitochat/issues/51)) ([9aaf0eb](https://github.com/incognitochat/incognitochat/commit/9aaf0eb11e30402826c5b865d65c6210cad35bc2))


### Bug Fixes

* admins and code owners can't redeem invitations ([#56](https://github.com/incognitochat/incognitochat/issues/56)) ([eb32bbb](https://github.com/incognitochat/incognitochat/commit/eb32bbb9d2a3b1f69b9361a8807ca13e9ec8eb4f))
* **infra:** restart functions when their parameters are rewritten ([#31](https://github.com/incognitochat/incognitochat/issues/31)) ([a59a497](https://github.com/incognitochat/incognitochat/commit/a59a497bfcded3b294e6de55fa8ba5850c5d9b5c))
* **infra:** size the api function from measurements, and log slow requests ([#45](https://github.com/incognitochat/incognitochat/issues/45)) ([7329581](https://github.com/incognitochat/incognitochat/commit/7329581604000a4046caea43d28f6ede69ccc1c8))
* send without waiting, and continue a conversation when its link reopens ([#44](https://github.com/incognitochat/incognitochat/issues/44)) ([794e448](https://github.com/incognitochat/incognitochat/commit/794e4486d3069ca83deadeb9987975edf9dabe9b))
* start clean after an account replacement, and replace dead mailboxes ([#57](https://github.com/incognitochat/incognitochat/issues/57)) ([fc25626](https://github.com/incognitochat/incognitochat/commit/fc25626f4dfaf35bce9f743210ef68573d45a0b8))
* **web:** keep a recording when a permission prompt takes the press ([#74](https://github.com/incognitochat/incognitochat/issues/74)) ([b183001](https://github.com/incognitochat/incognitochat/commit/b183001b3bc9ce4a3d5fe04517b07680fb72fc1c))
* **web:** keep each Telegram account's data apart on a shared Telegram app ([#38](https://github.com/incognitochat/incognitochat/issues/38)) ([659c563](https://github.com/incognitochat/incognitochat/commit/659c5634e5d7f22557ae2946d80124fef144ee43))
* **web:** keep the full-screen viewer out of its message ([#69](https://github.com/incognitochat/incognitochat/issues/69)) ([4d0b944](https://github.com/incognitochat/incognitochat/commit/4d0b944bea7f3df50e03fb1a5ee386b85baf4c61))
* **web:** keep the keyboard up after sending, and grow the message box ([#76](https://github.com/incognitochat/incognitochat/issues/76)) ([05e4d4d](https://github.com/incognitochat/incognitochat/commit/05e4d4da001913e8d28ea122cbd3aad89bb78664))
* **web:** make the viewer's buttons visible on light photos and videos ([#70](https://github.com/incognitochat/incognitochat/issues/70)) ([7ae1a21](https://github.com/incognitochat/incognitochat/commit/7ae1a21d27e0e2b41127ffeb672d88b0a6bf0f4b))
* **web:** show a photo or file the moment it's sent ([#66](https://github.com/incognitochat/incognitochat/issues/66)) ([ba9f064](https://github.com/incognitochat/incognitochat/commit/ba9f06431564242677c5d5f244a441a374be2576))
* **web:** show a video message in the chat as soon as it's sent ([#75](https://github.com/incognitochat/incognitochat/issues/75)) ([378c408](https://github.com/incognitochat/incognitochat/commit/378c40893844feee1e7b31b097cce9a318750634))
* **web:** sit the message bar low, as in Telegram ([#78](https://github.com/incognitochat/incognitochat/issues/78)) ([c09edbd](https://github.com/incognitochat/incognitochat/commit/c09edbd58ba5ad2f2ea286cbfe46c027a64abdd3))
