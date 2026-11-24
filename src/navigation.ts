import { callable } from "@decky/api";
import { GamepadButton } from "@decky/ui";

const buttons = {
  up: GamepadButton.DIR_UP, down: GamepadButton.DIR_DOWN,
  left: GamepadButton.DIR_LEFT, right: GamepadButton.DIR_RIGHT,
};
type Direction = keyof typeof buttons;
type Snapshot = { revision: number; direction: Direction | null };
type SessionMode = "desktop" | "gamescope" | null;
const getSessionMode = callable<[], SessionMode>("get_session_mode");
const watchDirection = callable<[session: string, revision: number], Snapshot>("watch_direction");
const endFocus = callable<[session: string], void>("end_focus");

type Handler = (...args: number[]) => void;
interface Source {
  SetSourceType(type: number): void;
  SetRepeatAllowed(check: () => boolean): void;
  OnButtonDown(button: number, index: number): void;
  OnButtonUp(button: number, index: number): void;
  RegisterForGamepadButtonDown(fn: Handler): unknown;
  RegisterForGamepadButtonUp(fn: Handler): unknown;
  HandleControllerInputMessages?: unknown;
}
interface Nav {
  m_rgGamepadInputSources: Source[];
  FindAnActiveContext?(): unknown;
  GetActiveContext(): {
    BIsGamepadInputSuppressed(): boolean;
    BIsActive(): boolean;
    ActiveWindow?: Window;
    m_activeBrowserView?: unknown;
  } | undefined;
  OnButtonDown: Handler;
  OnButtonUp: Handler;
}
interface SteamWindow {
  BrowserWindow?: Window;
  IsGamepadUIWindow(): boolean;
  IsMainGamepadUIWindow(): boolean;
  IsGamepadUIOverlayWindow(): boolean;
  LocationPathName: string;
  MenuStore: { IsSideMenuInteractable(): boolean };
  GetShowingGlobalModal(): boolean;
  BIsOverlayPath(): boolean;
  CompositionStateStore: {
    GetCompositionState(): number;
    GetCurrentlyFocusedAppidSubscribableValue(): { Value: number };
  };
}
type UI = {
  ActiveWindowInstance?: SteamWindow;
  GetFocusedWindowInstance?(): SteamWindow | null;
  WindowStore?: { BHasGamepadUIMainWindow(): boolean };
  NavigationManager?: Nav;
  ActiveControllerIndex: number;
};
const steam = () => window.SteamUIStore as unknown as UI | undefined;

export function focusedWindow(ui: UI | undefined, mode: SessionMode): SteamWindow | undefined {
  const win = ui?.ActiveWindowInstance;
  if (!win?.IsGamepadUIWindow?.()) return;
  if (mode === "desktop") {
    const ctx = ui?.NavigationManager?.GetActiveContext();
    if (ctx) {
      if (ui?.GetFocusedWindowInstance?.() !== win || !ctx.BIsActive?.() ||
          !ctx.ActiveWindow || ctx.ActiveWindow.document.hidden ||
          !(ctx.ActiveWindow.document.hasFocus() || ctx.m_activeBrowserView)) return;
    } else {
      const doc = win.BrowserWindow?.document;
      if (!doc || doc.hidden || !doc.hasFocus()) return;
    }
    const bigPicture = win.IsMainGamepadUIWindow?.() ||
      (win.IsGamepadUIOverlayWindow?.() && ui?.WindowStore?.BHasGamepadUIMainWindow?.());
    if (!bigPicture) return;
    if (/^\/apprunning(?:\/|$)/.test(win.LocationPathName) &&
        !win.MenuStore?.IsSideMenuInteractable?.() && !win.GetShowingGlobalModal?.()) return;
    return win;
  }
  if (mode !== "gamescope") return;
  const state = win.CompositionStateStore?.GetCompositionState?.();
  if (state !== 2 && state !== 3 && state !== 4) return;
  if (win.MenuStore?.IsSideMenuInteractable?.() || win.GetShowingGlobalModal?.()) return win;
  if (state === 3 && win.CompositionStateStore.GetCurrentlyFocusedAppidSubscribableValue?.()?.Value === 769) return win;
  if ((state === 2 || state === 4) && win.BIsOverlayPath?.() &&
      win.LocationPathName && !/^\/apprunning(?:\/|$)/.test(win.LocationPathName)) return win;
}

export function startNavigation() {
  let alive = true;
  let mode: SessionMode = null;
  let modeRequest: { started: number } | undefined;
  let owner: SteamWindow | undefined;
  let controller: Nav | undefined;
  let source: Source | undefined;
  let held: number | undefined;
  let heldIndex = -1;
  let session = "";
  let revision = -1;
  let lastReply = 0;
  let readingSince: number | undefined;
  let lastTick = Date.now();
  let retryAt = 0;
  const instance = Array.from(crypto.getRandomValues(new Uint32Array(2))).join("-");
  let generation = 0;

  const valid = () => !!owner && alive && focusedWindow(steam(), mode) === owner &&
    controller === steam()?.NavigationManager && !!controller?.GetActiveContext() &&
    !controller.GetActiveContext()?.BIsGamepadInputSuppressed() && Date.now() - lastReply < 650;

  function release() {
    const button = held;
    held = undefined;
    if (button !== undefined) source?.OnButtonUp(button, heldIndex);
  }
  function reset() {
    release();
    if (session) void endFocus(session).catch(() => {});
    owner = undefined;
    session = "";
    revision = -1;
    readingSince = undefined;
  }
  function resume() {
    if (!alive) return;
    reset();
    controller = undefined;
    source = undefined;
    modeRequest = undefined;
    retryAt = 0;
    lastTick = Date.now();
  }
  function retry() {
    reset();
    retryAt = performance.now() + 1000;
  }
  function connect(nav: Nav) {
    const physical = nav.m_rgGamepadInputSources.find(s => typeof s.HandleControllerInputMessages === "function");
    if (!physical) return false;
    const Base = Object.getPrototypeOf(Object.getPrototypeOf(physical)).constructor as new () => Source;
    const input = new Base();
    input.SetSourceType(1);
    input.SetRepeatAllowed(valid);
    input.RegisterForGamepadButtonDown((...args) => { if (valid()) nav.OnButtonDown(...args); });
    input.RegisterForGamepadButtonUp((...args) => { if (valid()) nav.OnButtonUp(...args); });
    source = input;
    controller = nav;
    return true;
  }

  async function read(token: string) {
    const started = Date.now();
    readingSince = started;
    try {
      const sample = await watchDirection(token, revision);
      if (!alive || session !== token || focusedWindow(steam(), mode) !== owner) return;
      if (Date.now() - started > 650) { reset(); return; }
      lastReply = Date.now();
      revision = sample.revision;
      const button = sample.direction === null ? undefined : buttons[sample.direction];
      if (held !== button) {
        release();
        if (button !== undefined && !controller?.GetActiveContext()) {
          controller?.FindAnActiveContext?.();
        }
        if (button !== undefined && valid()) {
          heldIndex = steam()?.ActiveControllerIndex ?? -1;
          held = button;
          source!.OnButtonDown(button, heldIndex);
        }
      }
    } catch {
      if (alive && session === token) retry();
    } finally {
      if (alive && session === token) {
        readingSince = undefined;
        queueMicrotask(tick);
      }
    }
  }
  function tick() {
    if (!alive) return;
    try {
      const now = Date.now();
      const requestStart = readingSince ?? modeRequest?.started;
      if (now - lastTick > 1500 || now < lastTick ||
          (requestStart !== undefined && now - requestStart > 1500)) resume();
      lastTick = now;
      if (!mode) {
        if (!modeRequest && performance.now() >= retryAt) {
          const request = modeRequest = { started: now };
          void getSessionMode().then(result => { if (modeRequest === request) mode = result; })
            .catch(() => { if (alive && modeRequest === request) retry(); })
            .finally(() => {
              if (modeRequest !== request) return;
              modeRequest = undefined;
              retryAt = mode ? 0 : performance.now() + 1000;
            });
        }
        return;
      }
      const ui = steam();
      const win = focusedWindow(ui, mode);
      const nav = ui?.NavigationManager;
      if (!win || !nav || win !== owner || nav !== controller || (held !== undefined && !valid())) reset();
      if (!win || !nav || performance.now() < retryAt) return;
      if (nav !== controller && !connect(nav)) { retry(); return; }
      if (!owner) {
        owner = win;
        session = instance + "-" + ++generation;
        revision = -1;
      }
      if (readingSince === undefined) void read(session);
    } catch { retry(); }
  }
  const timer = window.setInterval(tick, 40);
  let wake: { unregister(): void } | undefined;
  try {
    wake = window.SteamClient?.System?.RegisterForOnResumeFromSuspend?.(resume);
  } catch {
  }
  tick();
  return () => {
    window.clearInterval(timer);
    wake?.unregister();
    reset();
    alive = false;
  };
}
