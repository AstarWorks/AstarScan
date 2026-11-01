"""Tiny uiautomator helper for scripts/android/emulator-check.sh.

    python3 ui.py find <dump.xml> <regex> [package-regex]
        Print "x y" (centre) of the first node whose text or content-desc
        matches <regex> (case-insensitive); exit 1 when none.
    python3 ui.py list <dump.xml>
        Print every node with text / content-desc / resource-id, for logs.
"""

import re
import sys
import xml.etree.ElementTree as ET


def nodes(path):
    try:
        root = ET.parse(path).getroot()
    except (ET.ParseError, FileNotFoundError):
        return []
    return list(root.iter("node"))


def centre(bounds):
    m = re.match(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", bounds or "")
    if not m:
        return None
    x1, y1, x2, y2 = map(int, m.groups())
    return (x1 + x2) // 2, (y1 + y2) // 2


def main():
    cmd, path = sys.argv[1], sys.argv[2]
    if cmd == "list":
        for n in nodes(path):
            label = n.get("text") or n.get("content-desc") or ""
            rid = n.get("resource-id") or ""
            if label or rid:
                print(f"{n.get('package')}\t{rid}\t{label!r}\t{n.get('bounds')}\tclickable={n.get('clickable')}")
        return 0
    pattern = re.compile(sys.argv[3], re.I)
    pkg = re.compile(sys.argv[4]) if len(sys.argv) > 4 else None
    for n in nodes(path):
        if pkg and not pkg.search(n.get("package") or ""):
            continue
        for key in ("text", "content-desc", "resource-id"):
            if pattern.search(n.get(key) or ""):
                c = centre(n.get("bounds"))
                if c:
                    print(c[0], c[1])
                    return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())
