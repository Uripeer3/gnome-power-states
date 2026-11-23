#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Verify relative JS imports ('./...' and '../...') exist on disk, ignoring comments and non-import strings."""

import pathlib
import re
import sys

TOKEN_RE = re.compile(
    r"//[^\n]*"
    r"|/\*[\s\S]*?\*/"
    r"|(\"(?:\\.|[^\"\\\n])*\"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)"
    r"|([A-Za-z_$][A-Za-z0-9_$]*|\(|\S)"
)


def check_file(path: pathlib.Path) -> list[str]:
    text = path.read_text(encoding="utf-8")
    prev2 = ""
    prev1 = ""
    missing: list[str] = []

    for match in TOKEN_RE.finditer(text):
        string_tok, code_tok = match.group(1), match.group(2)
        if code_tok:
            prev2, prev1 = prev1, code_tok
        elif string_tok:
            is_import_specifier = prev1 in ("from", "import") or (
                prev2 == "import" and prev1 == "("
            )
            if is_import_specifier and string_tok[0] != "`":
                spec = string_tok[1:-1]
                if spec.startswith(("./", "../")):
                    target = (path.parent / spec).resolve()
                    if not target.is_file():
                        missing.append(spec)
            prev2, prev1 = prev1, ""

    return missing


def main(argv: list[str]) -> int:
    failed = False
    for arg in argv:
        src = pathlib.Path(arg)
        missing = check_file(src)
        if missing:
            print(f"MISSING LOCAL IMPORT in {arg}: {', '.join(missing)}", file=sys.stderr)
            failed = True
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
