# Captura telas do protótipo com o Chrome headless.
# Uso: python _work/prototype/shot.py pagina1 [pagina2 ...] [--w 1440] [--h 1000] [--suffix -mobile]
import subprocess, sys, os
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
ROOT = r"C:\Users\luizb\Documents\workspace\ContrataFlow"
args = sys.argv[1:]
w, h, suffix = 1440, 1000, ''
pages = []
i = 0
while i < len(args):
    if args[i] == '--w': w = int(args[i + 1]); i += 2
    elif args[i] == '--h': h = int(args[i + 1]); i += 2
    elif args[i] == '--suffix': suffix = args[i + 1]; i += 2
    else: pages.append(args[i]); i += 1
for p in pages:
    page, _, frag = p.partition('#')
    out = os.path.join(ROOT, '_work', 'prototype', 'shots', page.replace('?', '_').replace('=', '-') + (('-' + frag) if frag else '') + suffix + '.png')
    url = 'file:///' + ROOT.replace('\\', '/') + '/prototype/' + page + ('.html' if not page.endswith('.html') and '?' not in page else '') + (('#' + frag) if frag else '')
    r = subprocess.run([CHROME, '--headless=new', '--disable-gpu', '--hide-scrollbars', '--window-size=%d,%d' % (w, h),
                        '--virtual-time-budget=8000', '--screenshot=' + out, url], capture_output=True, text=True)
    print(('ok ' if os.path.exists(out) else 'FALHOU ') + out)
