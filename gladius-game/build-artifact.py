#!/usr/bin/env python3
"""Builds a single-file page (sprites inlined, html/head/body wrapper stripped) for the Artifact tool.
usage: build-artifact.py OUT.html"""
import re, sys, pathlib
here = pathlib.Path(__file__).parent
s = (here / 'index.html').read_text()
sp = (here / 'sprites.js').read_text()
s = s.replace('<script src="sprites.js"></script>', '<script>' + sp + '</script>')
s = s.replace('<!doctype html>\n<html lang="en">\n<head>\n', '')
s = re.sub(r'<meta charset[^>]*>\n<meta name="viewport"[^>]*>\n', '', s)
s = s.replace('</head>\n<body>\n', '').replace('</body>\n</html>', '')
s = s.replace(':root{\n  --ink', ':root{ color-scheme:dark;\n  --ink', 1)
pathlib.Path(sys.argv[1]).write_text(s)
