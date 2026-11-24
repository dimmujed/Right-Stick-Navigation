import asyncio
import fcntl
import json
import os
import select
import selectors
import struct
import threading
import time
from pathlib import Path

import decky


EV_SYN = 0x00
EV_KEY = 0x01
EV_ABS = 0x03
SYN_REPORT = 0
SYN_DROPPED = 3
KEY_UP = "up"
KEY_DOWN = "down"
KEY_LEFT = "left"
KEY_RIGHT = "right"
ABS_RX = 0x03
ABS_RY = 0x04
BTN_SOUTH = 0x130
STEAM_VENDOR_ID = 0x28DE
STEAM_DECK_PRODUCT_ID = 0x1205
STEAM_INPUT_PRODUCT_ID = 0x11FF
INPUT_EVENT = struct.Struct("@llHHi")
ABS_INFO = struct.Struct("@iiiiii")
INPUT_ID = struct.Struct("=HHHH")
DIRECTION_THRESHOLD = 0.58
POLL_INTERVAL = 0.016
DEVICE_FLAGS = os.O_RDONLY | os.O_NONBLOCK | os.O_CLOEXEC


def _read_input(fd, number, size):
    buffer = bytearray(size)
    request = (2 << 30) | (size << 16) | (ord("E") << 8) | number
    fcntl.ioctl(fd, request, buffer, True)
    return buffer


def _read_bitmap(fd, event_type, max_code):
    bits = _read_input(fd, 0x20 + event_type, (max_code + 8) // 8)
    return int.from_bytes(bits, "little")


def _read_axis(fd, code):
    return ABS_INFO.unpack(_read_input(fd, 0x40 + code, ABS_INFO.size))[:3]


def _normalize_axis(value, minimum, maximum):
    span = maximum - minimum
    if span <= 0:
        return 0.0
    return ((value - minimum) / span) * 2.0 - 1.0


def _direction_for(controller, previous=None):
    x_axis = _normalize_axis(*controller["rx"])
    y_axis = _normalize_axis(*controller["ry"])
    sides = {KEY_RIGHT: x_axis, KEY_LEFT: -x_axis, KEY_DOWN: y_axis, KEY_UP: -y_axis}
    peak = max(abs(x_axis), abs(y_axis))
    if previous is not None and sides[previous] >= 0.40 and peak - sides[previous] < 0.15:
        return previous
    if peak < DIRECTION_THRESHOLD:
        return None
    if abs(x_axis) > abs(y_axis):
        return KEY_RIGHT if x_axis > 0 else KEY_LEFT
    return KEY_DOWN if y_axis > 0 else KEY_UP


def _read_proc_text(path):
    try:
        return Path(path).read_bytes()
    except OSError:
        return b""


def _steam_session_mode():
    for proc in Path("/proc").glob("[0-9]*"):
        try:
            executable = (proc / "exe").readlink().name
        except OSError:
            continue
        if executable.lower() != "steam":
            continue
        entries = _read_proc_text(proc / "environ").split(b"\0")
        env = dict(entry.split(b"=", 1) for entry in entries if b"=" in entry)
        if env.get(b"XDG_CURRENT_DESKTOP") == b"gamescope" or env.get(b"GAMESCOPE_WAYLAND_DISPLAY"):
            return "gamescope"
        if env.get(b"DISPLAY") or env.get(b"WAYLAND_DISPLAY"):
            return "desktop"
    return None


def _deck_report_axes(report):
    if len(report) == 64 and report[:3] == b"\x01\x00\x09":
        x, y = struct.unpack_from("<hh", report, 52)
        return (x, -32768, 32767), (-y, -32767, 32768)
    return None


def _open_deck_reports():
    for node in sorted(Path("/sys/class/hidraw").glob("hidraw*")):
        fields = _read_proc_text(node / "device/uevent").upper().splitlines()
        if b"HID_ID=0003:000028DE:00001205" not in fields:
            continue
        fd = None
        try:
            fd = os.open("/dev/" + node.name, DEVICE_FLAGS)
            deadline = time.monotonic() + 0.08
            while (remaining := deadline - time.monotonic()) > 0:
                if not select.select([fd], [], [], remaining)[0]:
                    break
                report = os.read(fd, 65)
                if not report:
                    break
                axes = _deck_report_axes(report)
                if axes:
                    device = {
                        "fd": fd, "raw": True,
                        "rx": axes[0], "ry": axes[1], "last_report": time.monotonic(),
                    }
                    fd = None
                    return device
        except OSError:
            pass
        finally:
            if fd is not None:
                os.close(fd)
    return None


def _evdev_controller(fd, path):
    try:
        _, vendor, product, _ = INPUT_ID.unpack(_read_input(fd, 0x02, INPUT_ID.size))
    except OSError:
        vendor = product = 0

    virtual = (vendor, product) == (STEAM_VENDOR_ID, STEAM_INPUT_PRODUCT_ID)
    if not virtual and (vendor, product) != (STEAM_VENDOR_ID, STEAM_DECK_PRODUCT_ID):
        try:
            name = _read_input(fd, 0x06, 256).split(b"\0", 1)[0]
        except OSError:
            name = b""
        if not name:
            name = _read_proc_text(Path("/sys/class/input") / path.name / "device/name")
        name = name.lower()
        if b"steamdeck" not in name and b"steam deck" not in name:
            return None

    axes = _read_bitmap(fd, EV_ABS, 0x3F)
    stick = (1 << ABS_RX) | (1 << ABS_RY)
    if (axes & stick) != stick:
        return None
    if not (_read_bitmap(fd, EV_KEY, BTN_SOUTH) & (1 << BTN_SOUTH)):
        return None
    return {
        "fd": fd, "virtual": virtual,
        "rx": _read_axis(fd, ABS_RX), "ry": _read_axis(fd, ABS_RY),
    }


def _discover_controllers():
    builtin = []
    virtual = []
    for path in sorted(Path("/dev/input").glob("event*")):
        fd = None
        try:
            fd = os.open(path, DEVICE_FLAGS)
            controller = _evdev_controller(fd, path)
            if controller:
                devices = virtual if controller["virtual"] else builtin
                devices.append(controller)
                fd = None
        except OSError:
            pass
        finally:
            if fd is not None:
                os.close(fd)

    if not builtin:
        raw = _open_deck_reports()
        if not raw:
            return virtual
        builtin.append(raw)
    for controller in virtual:
        os.close(controller["fd"])
    return builtin


def _update_axes(controller):
    fd = controller["fd"]
    if controller.get("raw"):
        for _ in range(64):
            try:
                report = os.read(fd, 65)
            except BlockingIOError:
                break
            if not report:
                return False
            axes = _deck_report_axes(report)
            if axes:
                controller["rx"], controller["ry"] = axes
                controller["last_report"] = time.monotonic()
        return True

    events = os.read(fd, INPUT_EVENT.size * 64)
    if not events:
        return False
    for _, _, event_type, code, value in INPUT_EVENT.iter_unpack(events):
        if event_type == EV_SYN and code == SYN_DROPPED:
            controller["resync"] = True
        elif controller.get("resync"):
            if event_type == EV_SYN and code == SYN_REPORT:
                controller["rx"] = _read_axis(fd, ABS_RX)
                controller["ry"] = _read_axis(fd, ABS_RY)
                controller["resync"] = False
        elif event_type == EV_ABS and code in (ABS_RX, ABS_RY):
            axis = "rx" if code == ABS_RX else "ry"
            controller[axis] = (value, *controller[axis][1:])
    return True


class Plugin:
    def __init__(self):
        self._settings_path = Path(decky.DECKY_PLUGIN_SETTINGS_DIR) / "settings.json"
        self.enabled = self._load_settings()
        self._stop = threading.Event()
        self._worker = None
        self._session = None
        self._generation = 0
        self._expires = 0.0
        self._direction = None
        self._revision = 0
        self._state_lock = threading.Lock()

    def _load_settings(self):
        if self._settings_path.exists():
            settings = json.loads(self._settings_path.read_text(encoding="utf-8"))
            return settings.get("enabled", True) is True
        return True

    def _save_settings(self, enabled):
        self._settings_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self._settings_path.with_suffix(".json.tmp")
        temporary.write_text(json.dumps({"enabled": enabled}), encoding="utf-8")
        temporary.replace(self._settings_path)

    async def get_status(self):
        return {"enabled": self.enabled}

    async def get_session_mode(self):
        return await asyncio.to_thread(_steam_session_mode)

    async def set_enabled(self, enabled):
        enabled = bool(enabled)
        self._save_settings(enabled)
        with self._state_lock:
            self.enabled = enabled
            self._generation += 1
            self._direction = None
            self._revision += 1
        self._changed.set()
        return await self.get_status()

    def _publish_direction(self, lease, direction):
        with self._state_lock:
            if lease != (self._session, self._generation) or self._direction == direction:
                return
            self._direction = direction
            self._revision += 1
        self._loop.call_soon_threadsafe(self._changed.set)

    async def end_focus(self, session):
        with self._state_lock:
            if session != self._session:
                return
            self._expires = 0.0
            self._generation += 1
            self._direction = None
            self._revision += 1
        self._changed.set()

    async def watch_direction(self, session, revision):
        with self._state_lock:
            now = time.clock_gettime(time.CLOCK_BOOTTIME)
            owns_lease = self._session == session or now >= self._expires
            if owns_lease:
                self._changed.clear()
                if now >= self._expires:
                    self._session = session
                    self._generation += 1
                    self._direction = None
                    self._revision += 1
                self._expires = now + 0.9
                wait = revision == self._revision
        if not owns_lease:
            await asyncio.sleep(0.25)
            return {"revision": -1, "direction": None}
        if wait:
            try:
                await asyncio.wait_for(self._changed.wait(), timeout=0.25)
            except asyncio.TimeoutError:
                pass
        with self._state_lock:
            return {"revision": self._revision,
                    "direction": self._direction if self.enabled and session == self._session else None}

    def _active_session(self):
        with self._state_lock:
            if self.enabled and time.clock_gettime(time.CLOCK_BOOTTIME) < self._expires:
                return self._session, self._generation
        return None

    def _run_session(self, controllers, lease):
        current = None
        centered = False
        next_mode_check = time.monotonic() + 1
        try:
            with selectors.DefaultSelector() as selector:
                for controller in controllers:
                    selector.register(controller["fd"], selectors.EVENT_READ, controller)
                while not self._stop.is_set() and self._active_session() == lease:
                    if time.monotonic() >= next_mode_check:
                        if not _steam_session_mode():
                            return
                        next_mode_check = time.monotonic() + 1
                    for key, _ in selector.select(timeout=POLL_INTERVAL):
                        if not _update_axes(key.data):
                            return
                    direction = None
                    for controller in controllers:
                        if controller.get("raw") and time.monotonic() - controller["last_report"] > 1:
                            return
                        direction = _direction_for(controller, current)
                        if direction is not None:
                            break
                    if direction is None:
                        centered = True
                    if centered and direction != current:
                        self._publish_direction(lease, direction)
                        current = direction
        finally:
            self._publish_direction(lease, None)
            for controller in controllers:
                os.close(controller["fd"])

    def _run_worker(self):
        while not self._stop.is_set():
            lease = self._active_session()
            if not lease:
                self._stop.wait(0.05)
                continue
            try:
                if _steam_session_mode():
                    controllers = _discover_controllers()
                    if controllers:
                        self._run_session(controllers, lease)
            except OSError:
                pass
            self._stop.wait(0.05 if self._active_session() != lease else 0.5)

    async def _main(self):
        self._loop = asyncio.get_running_loop()
        self._changed = asyncio.Event()
        self._stop.clear()
        self._worker = threading.Thread(
            target=self._run_worker, name="right-stick-navigation", daemon=True
        )
        self._worker.start()

    async def _unload(self):
        self._stop.set()
        if self._worker is not None:
            await asyncio.to_thread(self._worker.join, 3.0)
