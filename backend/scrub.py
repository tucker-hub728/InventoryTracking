import re, pathlib, sys

root = pathlib.Path("/app/tests")
changed = []

# EMAIL/PASSWORD assignment pairs, with or without env fallback.
pat_email = re.compile(r'^(EMAIL|SMOKE_EMAIL)\s*=\s*(os\.environ\.get\([^)]*\)|"[^"]*"|\'[^\']*\')\s*$', re.M)
pat_pass  = re.compile(r'^(PASSWORD|SMOKE_PASSWORD)\s*=\s*(os\.environ\.get\([^)]*\)|"[^"]*"|\'[^\']*\')\s*$', re.M)

for p in sorted(root.glob("smoke_*.py")):
    s = orig = p.read_text(encoding="utf-8")
    has_email = bool(pat_email.search(s))
    has_pass = bool(pat_pass.search(s))
    if has_email and has_pass:
        # Replace the EMAIL line with the tuple unpack; drop the PASSWORD line.
        s = pat_email.sub("EMAIL, PASSWORD = require_credentials()", s, count=1)
        s = pat_pass.sub("", s, count=1)
        # Collapse the blank line the removal leaves behind.
        s = s.replace("EMAIL, PASSWORD = require_credentials()\n\n\n", "EMAIL, PASSWORD = require_credentials()\n\n")
        # Ensure the import exists, placed after the last stdlib import block.
        if "_smoke_creds" not in s:
            m = list(re.finditer(r'^(?:import|from)\s+\S+.*$', s, re.M))
            if m:
                last = m[-1]
                s = s[:last.end()] + "\n\nfrom _smoke_creds import require_credentials" + s[last.end():]
    # Scrub credentials out of docstring usage examples.
    s = re.sub(r'SMOKE_EMAIL=\S+', 'SMOKE_EMAIL=you@example', s)
    s = re.sub(r'SMOKE_PASSWORD=(?:\'[^\']*\'|"[^"]*"|\S+)', "SMOKE_PASSWORD='…'", s)
    s = re.sub(r'SMOKE_SA_EMAIL=\S+', 'SMOKE_SA_EMAIL=super@example', s)
    s = re.sub(r'SMOKE_SA_PASSWORD=(?:\'[^\']*\'|"[^"]*"|\S+)', "SMOKE_SA_PASSWORD='…'", s)
    if s != orig:
        p.write_text(s, encoding="utf-8")
        changed.append(p.name)

print(f"rewrote {len(changed)} file(s)")
for c in changed: print("  ", c)
