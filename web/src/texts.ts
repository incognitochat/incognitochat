// What each screen's notice or error says: the key of its string in every
// language (i18n), by the kind the app's state gives it (state/app.ts).

import type { Key } from './i18n/en';
import type { AdminNotice, ErrorKind, HomeNotice, InvitationsNotice, SendError } from './state/app';

export const ERROR_TEXT: Record<ErrorKind, Key> = {
  network: 'errorNetwork',
  expired: 'errorExpired',
  'rate-limited': 'errorRateLimited',
  'device-limit': 'errorDeviceLimit',
  'device-limit-later': 'errorDeviceLimitLater',
  clock: 'errorClock',
  generic: 'errorGeneric',
};

export const NOTICE_TEXT: Record<HomeNotice, Key> = {
  blocked: 'noticeBlocked',
  deleted: 'noticeDeleted',
  'deleted-many': 'noticeDeletedMany',
  'deleted-many-both': 'noticeDeletedManyBoth',
  unblocked: 'noticeUnblocked',
  replaced: 'noticeReplaced',
  created: 'noticeCreated',
  revoked: 'noticeRevoked',
  limit: 'noticeLimit',
  invitation: 'needInvitation',
  joined: 'noticeJoined',
  'invalid-invitation': 'noticeInvalidInvitation',
  'already-member': 'noticeAlreadyMember',
  'own-invitation': 'noticeOwnInvitation',
  'rate-limited': 'noticeRateLimited',
  'device-limit': 'errorDeviceLimit',
  'device-limit-later': 'errorDeviceLimitLater',
  'new-signing-key': 'noticeNewSigningKey',
  network: 'errorNetwork',
  generic: 'errorGeneric',
};

export const INVITATIONS_NOTICE_TEXT: Record<InvitationsNotice, Key> = {
  created: 'noticeInvitationCreated',
  'none-left': 'noticeNoneLeft',
  'device-limit': 'errorDeviceLimit',
  'device-limit-later': 'errorDeviceLimitLater',
  network: 'errorNetwork',
  generic: 'errorGeneric',
};

export const SEND_ERROR_TEXT: Record<Extract<SendError, string>, Key> = {
  'no-tokens': 'errorNoTokens',
  'no-mailboxes': 'errorNoMailboxes',
  'mailbox-limit': 'errorMailboxLimit',
  'rate-limited': 'errorTooFast',
  'device-limit': 'errorDeviceLimit',
  'device-limit-later': 'errorDeviceLimitLater',
  // The firewall's block lasts until this address's count over 5 minutes
  // falls: "Too many tries. Try again later."
  'turned-away': 'errorDeviceLimitLater',
  'media-paused': 'errorMediaPaused',
  outdated: 'errorOutdated',
  network: 'errorNetwork',
  'too-big': 'errorTooBig',
  unreadable: 'errorUnreadable',
  generic: 'errorGeneric',
};

export const ADMIN_NOTICE_TEXT: Record<AdminNotice, Key> = {
  saved: 'noticeSaved',
  granted: 'noticeGranted',
  switched: 'noticeSwitched',
  'not-member': 'noticeNotMember',
  'not-found': 'noticeLinkUnknown',
  'bad-link': 'noticeLinkUnknown',
  'device-limit': 'errorDeviceLimit',
  'device-limit-later': 'errorDeviceLimitLater',
  network: 'errorNetwork',
  generic: 'errorGeneric',
};
