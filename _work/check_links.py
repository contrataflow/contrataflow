# Verifica links relativos quebrados em docs/ (ignora URLs externas e âncoras).
import io, re, glob, os
bad = {}
for f in glob.glob('docs/**/*.md', recursive=True):
    s = io.open(f, encoding='utf-8').read()
    s = re.sub(r'```.*?```', '', s, flags=re.S)
    for m in re.finditer(r'\]\(([^)\s]+)\)', s):
        tgt = m.group(1)
        if re.match(r'^[a-z]+:', tgt) or tgt.startswith('#'):
            continue
        path = tgt.split('#')[0]
        if not path:
            continue
        full = os.path.normpath(os.path.join(os.path.dirname(f), path))
        if not os.path.exists(full):
            bad.setdefault(f, set()).add(tgt)
n = sum(len(v) for v in bad.values())
for f, v in sorted(bad.items()):
    print(f, '→', ', '.join(sorted(v))[:300])
print('links quebrados:', n)
