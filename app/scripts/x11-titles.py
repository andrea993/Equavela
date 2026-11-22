"""Prints the titles (WM_NAME / _NET_WM_NAME) of every window on an X display, one per line.

Used by e2e-single-instance-linux.mjs under a bare Xvfb, where no window manager keeps a client
list and xwininfo may not be installed. Only libX11 is needed (through ctypes).

    python3 -I app/scripts/x11-titles.py :97
"""

import ctypes
import ctypes.util
import sys

x11 = ctypes.cdll.LoadLibrary(ctypes.util.find_library("X11") or "libX11.so.6")
Window = ctypes.c_ulong
x11.XOpenDisplay.restype = ctypes.c_void_p
x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
x11.XDefaultRootWindow.restype = Window
x11.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
x11.XQueryTree.argtypes = [
    ctypes.c_void_p, Window, ctypes.POINTER(Window), ctypes.POINTER(Window),
    ctypes.POINTER(ctypes.POINTER(Window)), ctypes.POINTER(ctypes.c_uint),
]
x11.XInternAtom.restype = ctypes.c_ulong
x11.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
x11.XGetWindowProperty.argtypes = [
    ctypes.c_void_p, Window, ctypes.c_ulong, ctypes.c_long, ctypes.c_long, ctypes.c_int, ctypes.c_ulong,
    ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_ulong),
    ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_void_p),
]
x11.XFree.argtypes = [ctypes.c_void_p]

display = x11.XOpenDisplay(sys.argv[1].encode() if len(sys.argv) > 1 else None)
if not display:
    sys.exit(f"cannot open display {sys.argv[1:]}")
names = [x11.XInternAtom(display, name, False) for name in (b"_NET_WM_NAME", b"WM_NAME")]


def title(window):
    for atom in names:
        kind, fmt, count, after, data = ctypes.c_ulong(), ctypes.c_int(), ctypes.c_ulong(), ctypes.c_ulong(), ctypes.c_void_p()
        status = x11.XGetWindowProperty(display, window, atom, 0, 1024, False, 0,
                                        ctypes.byref(kind), ctypes.byref(fmt), ctypes.byref(count),
                                        ctypes.byref(after), ctypes.byref(data))
        if status == 0 and data.value and count.value:
            text = ctypes.string_at(data.value, count.value).decode("utf-8", "replace")
            x11.XFree(data)
            return text
    return None


def walk(window):
    root, parent = Window(), Window()
    children, count = ctypes.POINTER(Window)(), ctypes.c_uint()
    if not x11.XQueryTree(display, window, ctypes.byref(root), ctypes.byref(parent), ctypes.byref(children), ctypes.byref(count)):
        return
    ids = [children[i] for i in range(count.value)]
    if children:
        x11.XFree(children)
    for child in ids:
        name = title(child)
        if name:
            print(name)
        walk(child)


walk(x11.XDefaultRootWindow(display))
