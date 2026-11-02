"""Tiny uiautomator helper for scripts/android/emulator-check.sh.

    python3 ui.py find <dump.xml> <regex> [package-regex]
        Print "x y" (centre) of the first node whose text or content-desc
        matches <regex> (case-insensitive); exit 1 when none.
    python3 ui.py list <dump.xml>
        Print every node with text / content-desc / resource-id, for logs.
    python3 ui.py kind <dump.xml>
        Print what screen the dump shows (scanner-adjust-corners,
        app-list, ...).
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


DOCSCAN = "com.google.android.gms.optional_mlkit_docscan_ui:id/"
APP = "com.astarworks.astarscan"


def kind(path):
    """Name the screen from what the dump shows (not from the step we
    expected to be on): screenshots are named after this."""
    ns = nodes(path)
    if not ns:
        return "no-dump"  # ML Kit's live camera often cannot be dumped
    ids = {n.get("resource-id") or "" for n in ns}
    texts = [(n.get("text") or n.get("content-desc") or "") for n in ns]
    pkgs = {n.get("package") or "" for n in ns}
    joined = "\n".join(texts)
    if any("permissioncontroller" in p for p in pkgs):
        return "other-permissioncontroller"
    if "Viewing full screen" in joined:
        return "dialog-full-screen"
    if "android:id/button1" in ids and "com.google.android.gms" in pkgs:
        return "scanner-dialog"
    if DOCSCAN + "confirm_crop_button" in ids:
        return "scanner-adjust-corners"
    if DOCSCAN + "save_document_button" in ids:
        return "scanner-review"
    if DOCSCAN + "gallery_button" in ids or any(i.startswith(DOCSCAN) for i in ids):
        return "scanner-camera"
    if APP in pkgs:
        if re.search(r"^(撮れた|重複候補|抜け)$", joined, re.M):
            return "app-list"
        if re.search(r"^PDF 保存", joined, re.M):
            return "app-list-empty"
        if "もう一度スキャンを開く" in joined:
            return "app-waiting-scanner"
        if re.search(r"^スキャン$", joined, re.M):
            return "app-start"
        return "app-other"
    return "other-" + (sorted(pkgs)[0].split(".")[-1] if pkgs else "unknown")


def main():
    cmd, path = sys.argv[1], sys.argv[2]
    if cmd == "kind":
        print(kind(path))
        return 0
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
