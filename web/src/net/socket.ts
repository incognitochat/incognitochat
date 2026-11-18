// The push socket (design §12). Only a content-free hint ever comes down it
// ({"t":"sync"}: something arrived), and the app then fetches its inbox over
// HTTPS, so a dropped socket loses nothing. The session token goes as the
// second subprotocol, never in the URL. The socket is kept only while the
// app is visible: a hidden app has none, so the server sends a Telegram
// notice instead.

/** API Gateway closes sockets idle for 10 minutes. */
export const HEARTBEAT_MS = 5 * 60_000;
const FIRST_RETRY_MS = 1_000;
const MAX_RETRY_MS = 60_000;
/** A connection that lasted this long resets the backoff. */
const STABLE_MS = 60_000;
/**
 * An open socket is replaced about this often (give or take a tenth). The
 * server doesn't hear when sockets close, keeps a socket's record for 40
 * minutes, and pushes to the most recently opened ones first, so a copy
 * that stays open long must reopen to keep getting pushes while other
 * copies come and go.
 */
export const REOPEN_MS = 30 * 60_000;
/**
 * A replacement that couldn't open (refused, say) is tried again after about
 * this long, and twice as long after each refusal in a row, up to
 * MAX_REOPEN_RETRY_MS: the old socket still works meanwhile, so an
 * overloaded server isn't asked again every minute by every open app. The
 * longest keeps a replacement within the 40 minutes the server keeps the
 * old socket's record, if it gets through by the third try.
 */
export const REOPEN_RETRY_MS = 60_000;
export const MAX_REOPEN_RETRY_MS = 4 * REOPEN_RETRY_MS;

export interface PushSocketDeps {
  url: string;
  /** A current session token. */
  token: () => Promise<string>;
  /** Something arrived. */
  onHint: () => void;
  /** A socket opened: the server is reachable, and hints may have been missed meanwhile. onHint if not given. */
  onOpen?: () => void;
  /** For tests. */
  WebSocket?: typeof WebSocket;
}

export interface PushSocket {
  /** Connects now if visible, and keeps a socket while visible. */
  start(): void;
  /** The app was shown or hidden. */
  setVisible(visible: boolean): void;
  /** Whether a socket is open now. */
  readonly connected: boolean;
  stop(): void;
}

export function createPushSocket(deps: PushSocketDeps): PushSocket {
  const WS = deps.WebSocket ?? WebSocket;
  let running = false;
  let visible = true;
  /** The socket in use. */
  let socket: WebSocket | null = null;
  /** A socket opening to replace it. */
  let replacement: WebSocket | null = null;
  let connecting = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let reopenTimer: ReturnType<typeof setTimeout> | null = null;
  let backoff = FIRST_RETRY_MS;
  let reopenBackoff = REOPEN_RETRY_MS;
  let openedAt = 0;

  const wanted = () => running && visible;
  const jitter = () => 0.9 + 0.2 * Math.random();

  /** Makes ws the socket in use: its hints count, and its closing means reconnecting. */
  function adopt(ws: WebSocket): void {
    ws.onmessage = (event: MessageEvent) => {
      try {
        if ((JSON.parse(String(event.data)) as { t?: unknown }).t === 'sync') deps.onHint();
      } catch {
        // Not ours: ignore.
      }
    };
    ws.onclose = () => {
      if (socket !== ws) return;
      socket = null;
      stopTimers();
      if (openedAt && Date.now() - openedAt >= STABLE_MS) backoff = FIRST_RETRY_MS;
      openedAt = 0;
      retry();
    };
  }

  /** The socket in use is open: keep it alive, replace it in a while, and fetch what may have been missed. */
  function opened(ws: WebSocket): void {
    openedAt = Date.now();
    reopenBackoff = REOPEN_RETRY_MS;
    heartbeat = setInterval(() => ws.readyState === WS.OPEN && ws.send('{"action":"ping"}'), HEARTBEAT_MS);
    reopenTimer = setTimeout(() => void reopen(ws), REOPEN_MS * jitter());
    (deps.onOpen ?? deps.onHint)();
  }

  async function connect(): Promise<void> {
    if (!wanted() || socket || connecting) return;
    connecting = true;
    let token: string;
    try {
      token = await deps.token();
    } catch {
      connecting = false;
      retry();
      return;
    }
    connecting = false;
    if (!wanted() || socket) return;
    const ws = new WS(deps.url, ['v1', token]);
    socket = ws;
    adopt(ws);
    ws.onopen = () => opened(ws);
  }

  /**
   * Opens a new socket next to the one in use and moves over once it's
   * open, so pushes aren't missed in between. If it can't open (refused,
   * say), the old one stays, and it tries again later.
   */
  async function reopen(ws: WebSocket): Promise<void> {
    reopenTimer = null;
    if (socket !== ws || replacement) return;
    const later = () => {
      if (socket !== ws || reopenTimer) return;
      reopenTimer = setTimeout(() => void reopen(ws), reopenBackoff * jitter());
      reopenBackoff = Math.min(reopenBackoff * 2, MAX_REOPEN_RETRY_MS);
    };
    let token: string;
    try {
      token = await deps.token();
    } catch {
      later();
      return;
    }
    if (socket !== ws || !wanted() || replacement) return;
    const next = new WS(deps.url, ['v1', token]);
    replacement = next;
    next.onopen = () => {
      replacement = null;
      if (socket !== ws || !wanted()) {
        next.close();
        return;
      }
      stopTimers();
      socket = next;
      adopt(next);
      ws.close(); // no longer in use: its closing is ignored
      opened(next);
    };
    next.onclose = () => {
      if (replacement !== next) return;
      replacement = null;
      later();
    };
  }

  /** Tries again later, with growing, jittered delays. */
  function retry(): void {
    if (!wanted() || retryTimer) return;
    const delay = backoff * (0.5 + Math.random());
    backoff = Math.min(backoff * 2, MAX_RETRY_MS);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void connect();
    }, delay);
  }

  function stopTimers(): void {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    if (reopenTimer) clearTimeout(reopenTimer);
    reopenTimer = null;
  }

  function close(): void {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    stopTimers();
    const ws = socket;
    const next = replacement;
    socket = null;
    replacement = null;
    ws?.close();
    next?.close();
  }

  return {
    start() {
      running = true;
      void connect();
    },
    setVisible(v) {
      visible = v;
      if (v) {
        backoff = FIRST_RETRY_MS;
        void connect();
      } else {
        close();
      }
    },
    get connected() {
      return socket !== null && socket.readyState === WS.OPEN;
    },
    stop() {
      running = false;
      close();
    },
  };
}
