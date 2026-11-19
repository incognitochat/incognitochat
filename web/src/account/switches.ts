// The operator's emergency switches (backend/internal/api/switches.go):
// uploads or downloads of attachments paused for everyone. Only admins see
// and change them, on the admin screen.

import { checkObject } from '../net/api';

export type Switch = 'uploads' | 'downloads';

export interface Switches {
  uploadsPaused: boolean;
  downloadsPaused: boolean;
}

export function checkSwitches(value: unknown): Switches {
  const { uploadsPaused, downloadsPaused } = checkObject(value);
  if (typeof uploadsPaused !== 'boolean' || typeof downloadsPaused !== 'boolean') throw new Error('bad switches');
  return { uploadsPaused, downloadsPaused };
}
