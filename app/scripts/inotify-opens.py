"""Prints a line `<file name>` each time a file in a directory is opened (Linux inotify, IN_OPEN).

Used by e2e-single-instance-linux.mjs to see that the running instance opens a forwarded file: nothing
else in the window tells which worksheet a tab holds. Runs until it is killed.

    python3 -I -u app/scripts/inotify-opens.py <directory>
"""

import ctypes
import os
import struct
import sys

IN_OPEN = 0x00000020
libc = ctypes.CDLL(None, use_errno=True)
fd = libc.inotify_init()
if fd < 0:
    sys.exit("inotify_init failed")
if libc.inotify_add_watch(fd, sys.argv[1].encode(), IN_OPEN) < 0:
    sys.exit(f"cannot watch {sys.argv[1]}")
print("ready", flush=True)
header = struct.calcsize("iIII")
while True:
    data = os.read(fd, 65536)
    at = 0
    while at < len(data):
        _wd, _mask, _cookie, length = struct.unpack_from("iIII", data, at)
        name = data[at + header: at + header + length].split(b"\0", 1)[0].decode("utf-8", "replace")
        print(name, flush=True)
        at += header + length
