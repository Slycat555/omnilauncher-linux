#!/usr/bin/env python3
"""OmniLauncher's own controller layer - what Steam Input does, without Steam.

Takes over every physical controller (EVIOCGRAB, so the game never sees the raw device) and
re-presents it as a standard Xbox 360 pad through uinput - the one layout every PC game and
every SDL/Wine version understands. Or, in "kbm" mode, as a keyboard and mouse for games with
no controller support.

  * Generic gamepads (8BitDo, DualShock in DInput mode, ...): read through evdev and remapped
    with the same SDL mapping strings Steam stores (config.vdf SDL_GamepadBind), falling back
    to the kernel's own button meanings.
  * Steam Controller (2026 model, 28de:1302 and its 1304/1305 dongles) and the original
    Steam Controller (28de:1102/1142): driven directly over hidraw - lizard mode (its built-in
    keyboard/mouse emulation) is switched off and the raw state reports are decoded, the
    same way SDL's HIDAPI drivers do it. Trackpads become a mouse.
  * Rumble from the game is passed back to whichever controller it was meant for.

Run by the launcher for the duration of a game:
    python3 -I -u omni_input.py --mode gamepad|kbm [--steam-root DIR]
Prints one JSON line {"ready": true, "ignore": "0xVVVV/0xPPPP,..."} once the controllers are
taken over - the launcher hands "ignore" to the game as SDL_GAMECONTROLLER_IGNORE_DEVICES so
it can't open the physical devices behind our back. Exits (restoring every controller) on
SIGTERM/SIGINT or when stdin closes, so it never outlives the launcher.
"""

import argparse
import fcntl
import json
import os
import re
import selectors
import signal
import struct
import sys
import time

import evdev
from evdev import AbsInfo, InputDevice, UInput, ecodes as e, ff

VIRTUAL_PHYS = 'omni-input/virtual'
VALVE = 0x28DE
# New Steam Controller (wired / "Proteus" and "Nereid" dongles) and the original one.
TRITON_IDS = {0x1302, 0x1304, 0x1305}
TRITON_DONGLES = {0x1304, 0x1305}
LEGACY_SC_IDS = {0x1102, 0x1142}

BUTTONS = ('a', 'b', 'x', 'y', 'back', 'guide', 'start', 'leftstick', 'rightstick',
           'leftshoulder', 'rightshoulder', 'dpup', 'dpdown', 'dpleft', 'dpright')
STICKS = ('leftx', 'lefty', 'rightx', 'righty')
TRIGGERS = ('lefttrigger', 'righttrigger')


def log(*args):
    print('[omni-input]', *args, file=sys.stderr, flush=True)


def blank_state():
    s = {b: False for b in BUTTONS}
    s.update({a: 0.0 for a in STICKS + TRIGGERS})
    return s


def deadzone(x, y, dz=0.08):
    """Radial deadzone with rescale, so small resting drift reads as exactly centered."""
    mag = (x * x + y * y) ** 0.5
    if mag < dz:
        return 0.0, 0.0
    scale = min(1.0, (mag - dz) / (1 - dz)) / mag
    return x * scale, y * scale


# ---------------------------------------------------------------- outputs

class X360Sink:
    """A virtual wired Xbox 360 pad - same identity and layout as the kernel's xpad driver."""

    KEYS = {'a': e.BTN_A, 'b': e.BTN_B, 'x': e.BTN_X, 'y': e.BTN_Y,
            'leftshoulder': e.BTN_TL, 'rightshoulder': e.BTN_TR, 'back': e.BTN_SELECT,
            'start': e.BTN_START, 'guide': e.BTN_MODE, 'leftstick': e.BTN_THUMBL,
            'rightstick': e.BTN_THUMBR}

    def __init__(self, on_rumble):
        stick = AbsInfo(0, -32768, 32767, 16, 128, 0)
        trig = AbsInfo(0, 0, 255, 0, 0, 0)
        hat = AbsInfo(0, -1, 1, 0, 0, 0)
        caps = {
            e.EV_KEY: list(self.KEYS.values()),
            e.EV_ABS: [(e.ABS_X, stick), (e.ABS_Y, stick), (e.ABS_Z, trig), (e.ABS_RX, stick),
                       (e.ABS_RY, stick), (e.ABS_RZ, trig), (e.ABS_HAT0X, hat), (e.ABS_HAT0Y, hat)],
            e.EV_FF: [e.FF_RUMBLE, e.FF_PERIODIC, e.FF_SQUARE, e.FF_TRIANGLE, e.FF_SINE, e.FF_GAIN],
        }
        self.ui = UInput(caps, name='Microsoft X-Box 360 pad', vendor=0x045E, product=0x028E,
                         version=0x0114, bustype=e.BUS_USB, phys=VIRTUAL_PHYS, max_effects=16)
        self.on_rumble = on_rumble  # (strong 0..65535, weak 0..65535, length_ms) -> None
        self.effects = {}
        self.last = {}

    def fileno(self):
        return self.ui.fd

    def update(self, s):
        out = {}
        for name, code in self.KEYS.items():
            out[(e.EV_KEY, code)] = 1 if s[name] else 0
        lx, ly = deadzone(s['leftx'], s['lefty'])
        rx, ry = deadzone(s['rightx'], s['righty'])
        for code, v in ((e.ABS_X, lx), (e.ABS_Y, ly), (e.ABS_RX, rx), (e.ABS_RY, ry)):
            out[(e.EV_ABS, code)] = max(-32768, min(32767, int(round(v * 32767))))
        out[(e.EV_ABS, e.ABS_Z)] = int(round(max(0.0, min(1.0, s['lefttrigger'])) * 255))
        out[(e.EV_ABS, e.ABS_RZ)] = int(round(max(0.0, min(1.0, s['righttrigger'])) * 255))
        out[(e.EV_ABS, e.ABS_HAT0X)] = int(s['dpright']) - int(s['dpleft'])
        out[(e.EV_ABS, e.ABS_HAT0Y)] = int(s['dpdown']) - int(s['dpup'])
        changed = False
        for key, v in out.items():
            if self.last.get(key) != v:
                self.ui.write(key[0], key[1], v)
                self.last[key] = v
                changed = True
        if changed:
            self.ui.syn()

    def handle_ff(self):
        """Force feedback requests from the game: uploads, erases and play/stop."""
        for ev in self.ui.read():
            if ev.type == e.EV_UINPUT and ev.code == e.UI_FF_UPLOAD:
                up = self.ui.begin_upload(ev.value)
                up.retval = 0
                eff = up.effect
                if eff.type == e.FF_RUMBLE:
                    r = eff.u.ff_rumble_effect
                    self.effects[eff.id] = (r.strong_magnitude, r.weak_magnitude, eff.ff_replay.length)
                elif eff.type == e.FF_PERIODIC:
                    mag = abs(eff.u.ff_periodic_effect.magnitude) * 2
                    self.effects[eff.id] = (min(mag, 65535), min(mag, 65535), eff.ff_replay.length)
                self.ui.end_upload(up)
            elif ev.type == e.EV_UINPUT and ev.code == e.UI_FF_ERASE:
                er = self.ui.begin_erase(ev.value)
                er.retval = 0
                self.effects.pop(er.effect_id, None)
                self.ui.end_erase(er)
            elif ev.type == e.EV_FF and ev.code in self.effects:
                strong, weak, length = self.effects[ev.code]
                if ev.value:
                    self.on_rumble(strong, weak, length)
                else:
                    self.on_rumble(0, 0, 0)

    def close(self):
        try:
            self.ui.close()
        except OSError:
            pass


class KbmSink:
    """Keyboard + mouse for games with no controller support - Steam's "Keyboard (WASD) and
    Mouse" template: left stick WASD, right stick aims the mouse, triggers click."""

    KEYS = {'a': e.KEY_SPACE, 'b': e.KEY_E, 'x': e.KEY_R, 'y': e.KEY_F,
            'leftshoulder': e.KEY_Q, 'rightshoulder': e.KEY_G, 'back': e.KEY_TAB,
            'start': e.KEY_ESC, 'leftstick': e.KEY_LEFTSHIFT, 'rightstick': e.KEY_LEFTCTRL,
            'dpup': e.KEY_1, 'dpright': e.KEY_2, 'dpdown': e.KEY_3, 'dpleft': e.KEY_4,
            'guide': e.KEY_ENTER}

    def __init__(self, pointer):
        self.pointer = pointer
        self.state = blank_state()
        self.last = {}

    def fileno(self):
        return None

    def update(self, s):
        self.state = dict(s)
        p = self.pointer
        for name, code in self.KEYS.items():
            p.key(code, s[name])
        lx, ly = deadzone(s['leftx'], s['lefty'], 0.2)
        p.key(e.KEY_W, ly < -0.45)
        p.key(e.KEY_S, ly > 0.45)
        p.key(e.KEY_A, lx < -0.45)
        p.key(e.KEY_D, lx > 0.45)
        p.key(e.BTN_LEFT, s['righttrigger'] > 0.3)
        p.key(e.BTN_RIGHT, s['lefttrigger'] > 0.3)
        p.syn()

    def tick(self, dt):
        """Right stick moves the mouse continuously while held - called from the main loop."""
        rx, ry = deadzone(self.state['rightx'], self.state['righty'], 0.12)
        if rx or ry:
            # Squared response curve: precise near the center, fast at full tilt.
            speed = 1800.0 * dt
            self.pointer.move(rx * abs(rx) * speed, ry * abs(ry) * speed)
            return True
        return False

    def handle_ff(self):
        pass

    def close(self):
        pass


class Pointer:
    """One shared virtual keyboard+mouse - for trackpads, and for kbm mode."""

    def __init__(self):
        keys = [c for c in range(e.KEY_ESC, e.KEY_MICMUTE + 1)]
        keys += [e.BTN_LEFT, e.BTN_RIGHT, e.BTN_MIDDLE]
        caps = {e.EV_KEY: keys, e.EV_REL: [e.REL_X, e.REL_Y, e.REL_WHEEL, e.REL_HWHEEL]}
        self.ui = UInput(caps, name='OmniLauncher Input Mouse', phys=VIRTUAL_PHYS)
        self.held = {}
        self.fx = self.fy = 0.0
        self.dirty = False

    def key(self, code, down):
        down = 1 if down else 0
        if self.held.get(code, 0) != down:
            self.held[code] = down
            self.ui.write(e.EV_KEY, code, down)
            self.dirty = True

    def move(self, dx, dy):
        self.fx += dx
        self.fy += dy
        ix, iy = int(self.fx), int(self.fy)
        self.fx -= ix
        self.fy -= iy
        if ix:
            self.ui.write(e.EV_REL, e.REL_X, ix)
        if iy:
            self.ui.write(e.EV_REL, e.REL_Y, iy)
        if ix or iy:
            self.dirty = True
        self.syn()

    def wheel(self, notches):
        if notches:
            self.ui.write(e.EV_REL, e.REL_WHEEL, notches)
            self.dirty = True
            self.syn()

    def syn(self):
        if self.dirty:
            self.ui.syn()
            self.dirty = False

    def release_all(self):
        for code, down in list(self.held.items()):
            if down:
                self.key(code, False)
        self.syn()

    def close(self):
        self.release_all()
        self.ui.close()


class TrackpadMouse:
    """Relative "trackball" mouse from a trackpad: finger movement moves the cursor."""

    def __init__(self, pointer, sens=0.018):
        self.pointer = pointer
        self.sens = sens
        self.last = None

    def update(self, touching, x, y):
        if not touching:
            self.last = None
            return
        if self.last is not None:
            self.pointer.move((x - self.last[0]) * self.sens, -(y - self.last[1]) * self.sens)
        self.last = (x, y)


class TrackpadScroll:
    def __init__(self, pointer):
        self.pointer = pointer
        self.last = None
        self.acc = 0.0

    def update(self, touching, y):
        if not touching:
            self.last, self.acc = None, 0.0
            return
        if self.last is not None:
            self.acc += y - self.last
            notches = int(self.acc / 2500)
            if notches:
                self.acc -= notches * 2500
                self.pointer.wheel(notches)
        self.last = y


# ---------------------------------------------------------------- SDL mappings

def sdl_guid(info):
    """SDL's Linux joystick GUID (bus, vendor, product, version; CRC field zeroed)."""
    raw = struct.pack('<HHHHHHHH', info.bustype, 0, info.vendor, 0, info.product, 0,
                      info.version, 0)
    return raw.hex()


def load_mappings(steam_root):
    """GUID -> mapping string, from Steam's stored bindings and SDL_GAMECONTROLLERCONFIG."""
    lines = []
    if steam_root:
        try:
            with open(os.path.join(steam_root, 'config', 'config.vdf'), encoding='utf-8',
                      errors='replace') as f:
                m = re.search(r'"SDL_GamepadBind"\s+"([^"]*)"', f.read())
            if m:
                lines += m.group(1).split('\n')
        except OSError:
            pass
    lines += os.environ.get('SDL_GAMECONTROLLERCONFIG', '').split('\n')
    out = {}
    for line in lines:
        parts = line.strip().split(',')
        if len(parts) > 2 and len(parts[0]) == 32:
            guid = parts[0][:4] + '0000' + parts[0][8:]  # ignore SDL3's name CRC
            out[guid.lower()] = {k: v for k, _, v in (p.partition(':') for p in parts[2:]) if v}
    return out


def ids_from_mappings(mappings):
    """vendor/product of every controller Steam has ever stored a binding for."""
    ids = set()
    for guid in mappings:
        try:
            vendor = int(guid[10:12] + guid[8:10], 16)
            product = int(guid[18:20] + guid[16:18], 16)
            if vendor and product:
                ids.add((vendor, product))
        except ValueError:
            pass
    return ids


class Mapper:
    """Evaluates an SDL mapping string against raw device state, the way SDL does."""

    def __init__(self, mapping):
        self.rules = []  # (target, target_half, source_kind, index, extra, src_half, invert)
        for target, src in mapping.items():
            if target in ('platform', 'crc', 'hint', 'type'):
                continue
            t_half = None
            if target[0] in '+-':
                t_half, target = target[0], target[1:]
            if target not in BUTTONS and target not in STICKS and target not in TRIGGERS:
                continue
            s_half = None
            invert = src.endswith('~')
            src = src.rstrip('~')
            if src and src[0] in '+-':
                s_half, src = src[0], src[1:]
            try:
                if src.startswith('b'):
                    self.rules.append((target, t_half, 'b', int(src[1:]), 0, s_half, invert))
                elif src.startswith('a'):
                    self.rules.append((target, t_half, 'a', int(src[1:]), 0, s_half, invert))
                elif src.startswith('h'):
                    hat, mask = src[1:].split('.')
                    self.rules.append((target, t_half, 'h', int(hat), int(mask), s_half, invert))
            except ValueError:
                continue

    def evaluate(self, buttons, axes, hats):
        s = blank_state()
        for target, t_half, kind, idx, extra, s_half, invert in self.rules:
            if kind == 'b':
                v = 1.0 if (idx < len(buttons) and buttons[idx]) else 0.0
            elif kind == 'h':
                v = 1.0 if (idx < len(hats) and hats[idx] & extra) else 0.0
            else:
                v = axes[idx] if idx < len(axes) else 0.0
                if invert:
                    v = -v
                if s_half == '+':
                    v = max(0.0, v)
                elif s_half == '-':
                    v = max(0.0, -v)
            if target in BUTTONS:
                if kind == 'a':
                    pressed = (v > 0.5) if s_half else (abs(v) > 0.5 if target.startswith('dp') else v > 0.0)
                    s[target] = s[target] or pressed
                else:
                    s[target] = s[target] or v > 0.5
            elif target in TRIGGERS:
                if kind == 'a' and not s_half:
                    v = (v + 1.0) / 2.0  # a full-range axis used as a trigger
                s[target] = max(s[target], v)
            else:  # stick axis
                if kind != 'a' or t_half:
                    v = abs(v) * (-1.0 if t_half == '-' else 1.0)
                if abs(v) > abs(s[target]):
                    s[target] = v
        return s


def kernel_mapping(btn_codes, abs_codes, hat_count):
    """A mapping from the kernel's own key/axis meanings, for controllers Steam never saw."""
    m = {}
    names = {e.BTN_SOUTH: 'a', e.BTN_EAST: 'b', e.BTN_NORTH: 'x', e.BTN_WEST: 'y',
             e.BTN_TL: 'leftshoulder', e.BTN_TR: 'rightshoulder', e.BTN_SELECT: 'back',
             e.BTN_START: 'start', e.BTN_MODE: 'guide', e.BTN_THUMBL: 'leftstick',
             e.BTN_THUMBR: 'rightstick', e.BTN_DPAD_UP: 'dpup', e.BTN_DPAD_DOWN: 'dpdown',
             e.BTN_DPAD_LEFT: 'dpleft', e.BTN_DPAD_RIGHT: 'dpright',
             e.BTN_TL2: 'lefttrigger', e.BTN_TR2: 'righttrigger'}
    for i, code in enumerate(btn_codes):
        if code in names:
            m[names[code]] = 'b%d' % i
    ax = {code: 'a%d' % i for i, code in enumerate(abs_codes)}
    for code, name in ((e.ABS_X, 'leftx'), (e.ABS_Y, 'lefty')):
        if code in ax:
            m[name] = ax[code]
    if e.ABS_RX in ax:
        m['rightx'], m['righty'] = ax[e.ABS_RX], ax.get(e.ABS_RY, ax[e.ABS_RX])
        for code, name in ((e.ABS_Z, 'lefttrigger'), (e.ABS_RZ, 'righttrigger')):
            if code in ax:
                m[name] = ax[code]
    elif e.ABS_Z in ax and e.ABS_RZ in ax:  # DInput-style: Z/RZ is the right stick
        m['rightx'], m['righty'] = ax[e.ABS_Z], ax[e.ABS_RZ]
        for code, name in ((e.ABS_BRAKE, 'lefttrigger'), (e.ABS_GAS, 'righttrigger')):
            if code in ax:
                m[name] = ax[code]
    if hat_count:
        m.update({'dpup': 'h0.1', 'dpright': 'h0.2', 'dpdown': 'h0.4', 'dpleft': 'h0.8'})
    return m


# ---------------------------------------------------------------- generic evdev gamepad

def is_gamepad(dev):
    caps = dev.capabilities()
    keys = set(caps.get(e.EV_KEY, []))
    absc = {c if isinstance(c, int) else c[0] for c in caps.get(e.EV_ABS, [])}
    has_pad_buttons = any(0x120 <= k <= 0x13F for k in keys)  # BTN_JOYSTICK..BTN_THUMBR range
    return e.ABS_X in absc and has_pad_buttons


class EvdevPad:
    def __init__(self, dev, mappings, make_sink):
        self.dev = dev
        self.name = dev.name
        caps = dev.capabilities(absinfo=True)
        keys = set(caps.get(e.EV_KEY, []))
        # SDL's button numbering: BTN_JOYSTICK..KEY_MAX first, then everything below it.
        self.btn_codes = sorted(k for k in keys if k >= e.BTN_JOYSTICK) + \
            sorted(k for k in keys if k < e.BTN_JOYSTICK)
        absinfo = dict(caps.get(e.EV_ABS, []))
        self.abs_codes = sorted(c for c in absinfo if not (e.ABS_HAT0X <= c <= e.ABS_HAT3Y))
        self.hat_codes = sorted(c for c in absinfo if e.ABS_HAT0X <= c <= e.ABS_HAT3Y)
        self.hat_index = {}
        for c in self.hat_codes:
            self.hat_index.setdefault((c - e.ABS_HAT0X) // 2, len(self.hat_index))
        self.absinfo = absinfo
        self.btn_idx = {c: i for i, c in enumerate(self.btn_codes)}
        self.abs_idx = {c: i for i, c in enumerate(self.abs_codes)}
        self.buttons = [False] * len(self.btn_codes)
        self.axes = [0.0] * len(self.abs_codes)
        self.hats = [0] * max(1, len(self.hat_index))
        self.hat_xy = {}
        for c, i in self.abs_idx.items():
            self.axes[i] = self.norm(c, absinfo[c].value)
        mapping = mappings.get(sdl_guid(dev.info))
        if mapping:
            log('%s: using Steam/SDL mapping' % dev.name)
        else:
            mapping = kernel_mapping(self.btn_codes, self.abs_codes, len(self.hat_index))
            log('%s: using kernel button layout' % dev.name)
        self.mapper = Mapper(mapping)
        self.ff_ids = {}
        dev.grab()
        self.sink = make_sink(self.rumble)

    def norm(self, code, value):
        info = self.absinfo[code]
        if info.max == info.min:
            return 0.0
        return 2.0 * (value - info.min) / (info.max - info.min) - 1.0

    def fileno(self):
        return self.dev.fd

    def handle(self):
        for ev in self.dev.read():
            if ev.type == e.EV_KEY and ev.code in self.btn_idx:
                self.buttons[self.btn_idx[ev.code]] = ev.value != 0
            elif ev.type == e.EV_ABS and ev.code in self.abs_idx:
                self.axes[self.abs_idx[ev.code]] = self.norm(ev.code, ev.value)
            elif ev.type == e.EV_ABS and ev.code in self.hat_codes:
                hat = self.hat_index[(ev.code - e.ABS_HAT0X) // 2]
                axis = (ev.code - e.ABS_HAT0X) % 2
                self.hat_xy[(hat, axis)] = ev.value
                x, y = self.hat_xy.get((hat, 0), 0), self.hat_xy.get((hat, 1), 0)
                self.hats[hat] = (1 if y < 0 else 0) | (2 if x > 0 else 0) | \
                    (4 if y > 0 else 0) | (8 if x < 0 else 0)
            elif ev.type == e.EV_SYN and ev.code == e.SYN_REPORT:
                self.sink.update(self.mapper.evaluate(self.buttons, self.axes, self.hats))

    def rumble(self, strong, weak, length):
        if e.EV_FF not in self.dev.capabilities():
            return
        try:
            effect = ff.Effect(e.FF_RUMBLE, self.ff_ids.get('r', -1), 0, ff.Trigger(0, 0),
                               ff.Replay(length or 0xFFFF, 0),
                               ff.EffectType(ff_rumble_effect=ff.Rumble(strong, weak)))
            self.ff_ids['r'] = self.dev.upload_effect(effect)
            self.dev.write(e.EV_FF, self.ff_ids['r'], 1 if (strong or weak) else 0)
        except OSError:
            pass

    def ids(self):
        return {(self.dev.info.vendor, self.dev.info.product)}

    def close(self):
        try:
            self.dev.ungrab()
        except OSError:
            pass
        self.sink.close()
        self.dev.close()


# ---------------------------------------------------------------- Steam Controllers (hidraw)

def HIDIOCSFEATURE(length):
    return (3 << 30) | (length << 16) | (ord('H') << 8) | 0x06


def hidraw_devices():
    """(path, vendor, product, interface number, usb device sysfs path) for every hidraw."""
    out = []
    for name in sorted(os.listdir('/sys/class/hidraw')):
        try:
            with open('/sys/class/hidraw/%s/device/uevent' % name) as f:
                uevent = f.read()
            m = re.search(r'HID_ID=\w+:0*([0-9A-Fa-f]+):0*([0-9A-Fa-f]+)', uevent)
            if not m:
                continue
            iface = -1
            phys = re.search(r'HID_PHYS=\S*/input(\d+)', uevent)
            if phys:
                iface = int(phys.group(1))
            out.append(('/dev/' + name, int(m.group(1), 16), int(m.group(2), 16), iface))
        except OSError:
            continue
    return out


TRITON = {  # button bits of the new Steam Controller (SDL_hidapi_steam_triton.c)
    'a': 0x1, 'b': 0x2, 'x': 0x4, 'y': 0x8, 'rightstick': 0x20, 'start': 0x40,
    'rightshoulder': 0x200, 'dpdown': 0x400, 'dpright': 0x800, 'dpleft': 0x1000,
    'dpup': 0x2000, 'back': 0x4000, 'leftstick': 0x8000, 'guide': 0x10000,
    'leftshoulder': 0x80000,
}
TRITON_R_PAD_TOUCH, TRITON_R_PAD_CLICK = 0x200000, 0x400000
TRITON_L_PAD_TOUCH, TRITON_L_PAD_CLICK = 0x2000000, 0x4000000


class TritonPad:
    """The 2026 Steam Controller, over hidraw. Lizard mode has to be switched off every few
    seconds or the controller falls back to it (SDL does the same)."""

    def __init__(self, path, product, pointer, make_sink):
        self.path = path
        self.product = product
        self.name = 'Steam Controller'
        self.fd = os.open(path, os.O_RDWR | os.O_NONBLOCK)
        self.pointer = pointer
        self.make_sink = make_sink
        self.sink = None if product in TRITON_DONGLES else make_sink(self.rumble)
        self.mouse = TrackpadMouse(pointer)
        self.scroll = TrackpadScroll(pointer)
        self.last_lizard = 0.0
        self.rumble_state = (0, 0, 0.0)  # left, right, stop-at (0 = until told)
        self.last_rumble = 0.0
        self.pad_clicks = (False, False)
        self.set_lizard(False)

    def fileno(self):
        return self.fd

    def set_lizard(self, on):
        buf = bytearray(64)
        buf[0], buf[1], buf[2] = 1, 0x87, 3          # report 1: SET_SETTINGS_VALUES, 1 setting
        buf[3], buf[4], buf[5] = 9, 1 if on else 0, 0  # SETTING_LIZARD_MODE = on/off
        try:
            fcntl.ioctl(self.fd, HIDIOCSFEATURE(len(buf)), bytes(buf))
        except OSError:
            pass
        self.last_lizard = time.monotonic()

    def handle(self):
        while True:
            try:
                data = os.read(self.fd, 128)
            except BlockingIOError:
                return
            if not data:
                return
            rid = data[0]
            if rid == 0x79 and len(data) > 1:  # dongle: controller connected / disconnected
                if data[1] == 2 and not self.sink:
                    self.sink = self.make_sink(self.rumble)
                elif data[1] == 1 and self.sink:
                    self.sink.close()
                    self.sink = None
            elif rid in (0x42, 0x45, 0x47) and len(data) >= 30:
                if not self.sink:
                    self.sink = self.make_sink(self.rumble)
                self.state(data, rid == 0x47)

    def state(self, d, timestamped):
        buttons = struct.unpack_from('<I', d, 2)[0]
        lt, rt, lx, ly, rx, ry = struct.unpack_from('<hhhhhh', d, 6)
        pads = 20 if timestamped else 18
        lpx, lpy, _lp, rpx, rpy = struct.unpack_from('<hhHhh', d, pads)
        s = blank_state()
        for name, bit in TRITON.items():
            s[name] = bool(buttons & bit)
        s['leftx'], s['lefty'] = lx / 32768.0, -ly / 32768.0
        s['rightx'], s['righty'] = rx / 32768.0, -ry / 32768.0
        s['lefttrigger'], s['righttrigger'] = max(0, lt) / 32767.0, max(0, rt) / 32767.0
        self.sink.update(s)
        # Trackpads are a mouse in both modes: right pad moves, left pad scrolls.
        self.mouse.update(bool(buttons & TRITON_R_PAD_TOUCH), rpx, rpy)
        self.scroll.update(bool(buttons & TRITON_L_PAD_TOUCH), lpy)
        clicks = (bool(buttons & TRITON_R_PAD_CLICK), bool(buttons & TRITON_L_PAD_CLICK))
        if clicks != self.pad_clicks:
            self.pointer.key(e.BTN_LEFT, clicks[0])
            self.pointer.key(e.BTN_RIGHT, clicks[1])
            self.pointer.syn()
            self.pad_clicks = clicks

    def rumble(self, strong, weak, length):
        stop = time.monotonic() + length / 1000.0 if (length and (strong or weak)) else 0.0
        self.rumble_state = (strong, weak, stop)
        self.send_rumble(strong, weak)

    def send_rumble(self, left, right):
        msg = struct.pack('<BBHHbHb', 0x80, 0, 0, left, 0, right, 0)
        try:
            os.write(self.fd, msg)
        except OSError:
            pass
        self.last_rumble = time.monotonic()

    def tick(self, now):
        if now - self.last_lizard >= 2.5:
            self.set_lizard(False)
        left, right, stop = self.rumble_state
        if left or right:
            if stop and now >= stop:
                self.rumble_state = (0, 0, 0.0)
                self.send_rumble(0, 0)
            elif now - self.last_rumble >= 0.04:
                self.send_rumble(left, right)

    def ids(self):
        return {(VALVE, self.product)}

    def close(self):
        if self.rumble_state[0] or self.rumble_state[1]:
            self.send_rumble(0, 0)
        self.set_lizard(True)
        if self.sink:
            self.sink.close()
        os.close(self.fd)


LEGACY = {  # button bits of the original Steam Controller (SDL_hidapi_steam.c)
    'rightshoulder': 0x4, 'leftshoulder': 0x8, 'y': 0x10, 'b': 0x20, 'x': 0x40, 'a': 0x80,
    'dpup': 0x100, 'dpright': 0x200, 'dpleft': 0x400, 'dpdown': 0x800, 'back': 0x1000,
    'guide': 0x2000, 'start': 0x4000, 'rightstick': 0x40000, 'leftstick': 0x400000,
}
LEGACY_L_FINGER, LEGACY_LEFT_AND_STICK, LEGACY_L_CLICK = 0x80000, 0x800000, 0x20000
LEGACY_R_FINGER = 0x100000


class LegacySteamPad:
    """The original (2015) Steam Controller over hidraw. Its one stick and left pad share
    the same report fields - a flag says which one a packet carries."""

    def __init__(self, path, product, pointer, make_sink):
        self.path = path
        self.product = product
        self.name = 'Steam Controller (2015)'
        self.fd = os.open(path, os.O_RDWR | os.O_NONBLOCK)
        self.make_sink = make_sink
        self.sink = None if product == 0x1142 else make_sink(self.rumble)
        self.scroll = TrackpadScroll(pointer)
        self.stick = (0, 0)
        self.pad = (0, 0)
        self.disable_lizard()

    def fileno(self):
        return self.fd

    def feature(self, payload):
        buf = bytearray(65)
        buf[1:1 + len(payload)] = payload
        try:
            fcntl.ioctl(self.fd, HIDIOCSFEATURE(len(buf)), bytes(buf))
        except OSError:
            pass

    def disable_lizard(self):
        self.feature(bytes([0x81]))  # ID_CLEAR_DIGITAL_MAPPINGS - no more keyboard keys
        # ID_SET_SETTINGS_VALUES: both trackpads to TRACKPAD_NONE, no mouse smoothing.
        self.feature(bytes([0x87, 9, 7, 7, 0, 8, 7, 0, 24, 0, 0]))

    def handle(self):
        while True:
            try:
                data = os.read(self.fd, 128)
            except BlockingIOError:
                return
            if not data or len(data) < 4:
                return
            if data[2] == 3 and len(data) > 4:  # wireless connect/disconnect event
                if data[4] == 2 and not self.sink:
                    self.sink = self.make_sink(self.rumble)
                elif data[4] == 1 and self.sink:
                    self.sink.close()
                    self.sink = None
            elif data[2] == 1 and len(data) >= 24:
                if not self.sink:
                    self.sink = self.make_sink(self.rumble)
                self.state(data)

    def state(self, d):
        buttons = struct.unpack_from('<Q', d, 8)[0]
        lt, rt = d[11], d[12]
        lx, ly, rx, ry = struct.unpack_from('<hhhh', d, 16)
        if buttons & LEGACY_L_FINGER:
            self.pad = (lx, ly)
            if not buttons & LEGACY_LEFT_AND_STICK:
                self.stick = (0, 0)
        else:
            self.stick = (lx, ly)
            if not buttons & LEGACY_LEFT_AND_STICK:
                self.pad = (0, 0)
                if buttons & LEGACY_L_CLICK:  # old firmware: stick click arrives as pad click
                    buttons = (buttons & ~LEGACY_L_CLICK) | LEGACY['leftstick']
        s = blank_state()
        for name, bit in LEGACY.items():
            s[name] = bool(buttons & bit)
        s['leftx'], s['lefty'] = self.stick[0] / 32768.0, -self.stick[1] / 32768.0
        # No right stick on this model: the right pad stands in for it, like SDL does.
        s['rightx'], s['righty'] = rx / 32768.0, -ry / 32768.0
        s['lefttrigger'], s['righttrigger'] = lt / 255.0, rt / 255.0
        self.sink.update(s)
        self.scroll.update(bool(buttons & LEGACY_L_FINGER), self.pad[1])

    def rumble(self, strong, weak, length):
        # ID_TRIGGER_HAPTIC_PULSE per side: on/off times in microseconds, repeat count.
        for side, mag in ((1, strong), (0, weak)):
            on = int(mag / 65535.0 * 4000)
            count = max(1, int((length or 200) * 1000 / 5000)) if on else 0
            self.feature(struct.pack('<BBBHHH', 0x8F, 7, side, on, 5000 - on, count))

    def tick(self, now):
        pass

    def ids(self):
        return {(VALVE, self.product)}

    def close(self):
        self.feature(bytes([0x85]))  # ID_SET_DEFAULT_DIGITAL_MAPPINGS
        self.feature(bytes([0x8E]))  # ID_LOAD_DEFAULT_SETTINGS
        if self.sink:
            self.sink.close()
        os.close(self.fd)


# ---------------------------------------------------------------- daemon

class Daemon:
    def __init__(self, mode, steam_root, only=None):
        self.mode = mode
        self.only = only  # set of (vendor, product) to restrict to - for testing
        self.mappings = load_mappings(steam_root)
        self.sel = selectors.DefaultSelector()
        self.pointer = Pointer()
        self.drivers = {}   # key (evdev path or hidraw path) -> driver
        self.grabbed = {}   # Steam Controller keyboard/mouse evdev nodes we silence
        self.skip = set()   # paths that failed to open - not retried every scan
        self.kbm_sinks = []
        self.running = True

    def make_sink(self, rumble):
        if self.mode == 'kbm':
            sink = KbmSink(self.pointer)
            self.kbm_sinks.append(sink)
            return sink
        sink = X360Sink(rumble)
        self.sel.register(sink.fileno(), selectors.EVENT_READ, sink)
        return sink

    def release_sink(self, sink):
        if sink in self.kbm_sinks:
            self.kbm_sinks.remove(sink)
        elif sink is not None:
            try:
                self.sel.unregister(sink.fileno())
            except (KeyError, ValueError):
                pass

    def add(self, key, driver):
        self.drivers[key] = driver
        self.sel.register(driver.fileno(), selectors.EVENT_READ, driver)
        log('took over %s (%s)' % (driver.name, key))

    def remove(self, key):
        driver = self.drivers.pop(key, None)
        if not driver:
            return
        try:
            self.sel.unregister(driver.fileno())
        except (KeyError, ValueError):
            pass
        self.release_sink(getattr(driver, 'sink', None))
        try:
            driver.close()
        except OSError:
            pass
        log('released %s' % driver.name)

    def scan(self):
        steam_controllers = set()
        for path, vendor, product, iface in hidraw_devices():
            if vendor != VALVE or path in self.drivers or path in self.skip:
                continue
            if self.only is not None and (vendor, product) not in self.only:
                continue
            try:
                if product in TRITON_IDS:
                    if product in TRITON_DONGLES and not 2 <= iface <= 5:
                        continue
                    self.add(path, TritonPad(path, product, self.pointer, self.make_sink))
                elif product == 0x1102 or (product == 0x1142 and 1 <= iface <= 4):
                    self.add(path, LegacySteamPad(path, product, self.pointer, self.make_sink))
            except OSError as err:
                self.skip.add(path)
                log('cannot open %s: %s' % (path, err))
        for d in self.drivers.values():
            if isinstance(d, (TritonPad, LegacySteamPad)):
                steam_controllers.add(d.product)

        for path in evdev.list_devices():
            if path in self.drivers or path in self.grabbed or path in self.skip:
                continue
            try:
                dev = InputDevice(path)
            except OSError:
                self.skip.add(path)
                continue
            if dev.phys == VIRTUAL_PHYS or (
                    self.only is not None and (dev.info.vendor, dev.info.product) not in self.only):
                dev.close()
                self.skip.add(path)
                continue
            if dev.info.vendor == VALVE:
                # A Steam Controller's own keyboard/mouse (lizard mode) nodes: grabbed so a
                # stray lizard keypress can't reach the game. Steam's virtual pads: left alone.
                if dev.info.product in steam_controllers:
                    try:
                        dev.grab()
                        self.grabbed[path] = dev
                        continue
                    except OSError:
                        pass
                dev.close()
                self.skip.add(path)
                continue
            if not is_gamepad(dev):
                dev.close()
                self.skip.add(path)
                continue
            try:
                self.add(path, EvdevPad(dev, self.mappings, self.make_sink))
            except OSError as err:
                log('cannot take over %s: %s' % (dev.name, err))
                dev.close()
                self.skip.add(path)

    def ignore_list(self):
        ids = {(VALVE, p) for p in TRITON_IDS | LEGACY_SC_IDS}
        ids |= ids_from_mappings(self.mappings)
        for d in self.drivers.values():
            ids |= d.ids()
        ids.discard((0x045E, 0x028E))  # that's what our virtual pads are
        return ','.join('0x%04x/0x%04x' % i for i in sorted(ids))

    def run(self):
        self.scan()
        print(json.dumps({'ready': True, 'ignore': self.ignore_list(),
                          'devices': [d.name for d in self.drivers.values()]}), flush=True)
        self.sel.register(sys.stdin.fileno(), selectors.EVENT_READ, 'stdin')
        last_scan = last_tick = time.monotonic()
        while self.running:
            moving = any(s.state['rightx'] or s.state['righty'] for s in self.kbm_sinks)
            timeout = 0.008 if moving else 0.25
            for key, _ in self.sel.select(timeout):
                obj = key.data
                if obj == 'stdin':
                    if not os.read(sys.stdin.fileno(), 4096):
                        self.running = False
                    continue
                try:
                    if isinstance(obj, X360Sink):
                        obj.handle_ff()
                    else:
                        obj.handle()
                except BlockingIOError:
                    pass
                except OSError as err:
                    log('%s: %s' % (getattr(obj, 'name', type(obj).__name__), err))
                    # Unplugged / powered off - drop it; a rescan picks it back up.
                    for k, d in list(self.drivers.items()):
                        if d is obj:
                            self.remove(k)
                            self.skip.discard(k)
            now = time.monotonic()
            for s in self.kbm_sinks:
                s.tick(now - last_tick)
            last_tick = now
            for d in self.drivers.values():
                if hasattr(d, 'tick'):
                    d.tick(now)
            if now - last_scan >= 1.5:
                last_scan = now
                self.forget_gone()
                self.scan()

    def forget_gone(self):
        present = set(evdev.list_devices()) | {p for p, *_ in hidraw_devices()}
        for k in [k for k in self.drivers if k not in present]:
            self.remove(k)
        for k in [k for k in self.grabbed if k not in present]:
            self.grabbed.pop(k).close()
        self.skip &= present

    def shutdown(self):
        for k in list(self.drivers):
            self.remove(k)
        for dev in self.grabbed.values():
            try:
                dev.ungrab()
                dev.close()
            except OSError:
                pass
        self.grabbed.clear()
        try:
            self.pointer.close()
        except OSError:
            pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--mode', choices=('gamepad', 'kbm'), default='gamepad')
    ap.add_argument('--steam-root', default=None)
    ap.add_argument('--only', default=None, help='vvvv:pppp,... - only these devices (testing)')
    args = ap.parse_args()
    only = None
    if args.only:
        only = {tuple(int(x, 16) for x in pair.split(':')) for pair in args.only.split(',')}
    daemon = Daemon(args.mode, args.steam_root, only)

    def stop(*_):
        daemon.running = False
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGHUP, stop)
    try:
        daemon.run()
    finally:
        daemon.shutdown()


if __name__ == '__main__':
    main()
