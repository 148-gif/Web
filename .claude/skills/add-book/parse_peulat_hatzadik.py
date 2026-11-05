"""Parse the two exported Google Docs of "Peulat HaTzadik" into data/books/peulat-hatzadik.json.
Usage: python3 -I parse_peulat.py part1.txt part2.txt out.json
"""
import re, json, sys, unicodedata
p1, p2, out = sys.argv[1:4]
rd = lambda f: open(f, encoding='utf8').read().replace('\r', '').lstrip('﻿').split('\n')
L1 = [l.strip() for l in rd(p1)]
L2 = [l.strip() for l in rd(p2)]

# ---------- holam repair (same logic as the add-book skill) ----------
HOLAM = 'ֹ'
LET = re.compile(r'[א-ת]')
VOW = set('ְֱֲֳִֵֶַָֻ')
FINAL = set('םןךףץ')
changed = {}
def fix_word(word):
    cl = []
    for ch in word:
        if LET.match(ch): cl.append([ch, ''])
        elif cl and unicodedata.combining(ch): cl[-1][1] += ch
        else: cl.append([ch, ''])
    for i, (ch, mk) in enumerate(cl):
        if HOLAM not in mk or ch == 'ו' or i == 0 or not LET.match(cl[i-1][0]): continue
        last = i == len(cl) - 1 or not LET.match(cl[i+1][0])
        two = any(v in mk for v in VOW)
        prev_v = any(v in cl[i-1][1] for v in VOW | {HOLAM})
        if two or (last and (ch in FINAL or ch in 'אדז') and not prev_v):
            cl[i][1] = mk.replace(HOLAM, '', 1); cl[i-1][1] += HOLAM
    new = ''.join(c + m for c, m in cl)
    if new != word: changed[word] = new
    return new
fix = lambda s: re.sub(r'\S+', lambda m: fix_word(m.group()), s)

G = {'א':1,'ב':2,'ג':3,'ד':4,'ה':5,'ו':6,'ז':7,'ח':8,'ט':9,'י':10,'כ':20,'ל':30,'מ':40,'נ':50,'ס':60,'ע':70,'פ':80,'צ':90,'ק':100,'ר':200,'ש':300,'ת':400}
num = lambda s: sum(G.get(c, 0) for c in s)
NUMRE = r'ת{0,2}[קרש]?(?:טו|טז|[יכלמנסעפצ]?[א-ט]?)'
SEC = re.compile(r'^(' + NUMRE + r')\.$')
YEAR = re.compile(r'^תק[א-ת]?"?[א-ת]?$|^תק"[א-ת]$|^תק[א-ת]"[א-ת]$')
NOTE = re.compile(r'^\[הערה\s*([^\)\]]{1,3})\)\s*(.*)\]$')
NOTE0 = re.compile(r'^\[הערה\s+(.*)\]$')

def is_year(l): return bool(re.fullmatch(r'תק[א-ת]?"[א-ת]|תק[א-ת]"[א-ת]|תק"[א-ת]', l))

STRAY = re.compile(r'([םןךףץ][\u05b0-\u05bd\u05bf-\u05c7]*)([א-ת])(?=[\s.,:;!?)\]"\']|$)')
SEQ = list('אבגדהוזחט') + list('יכלמנסעפצקרשת')
def items_of(lines):
    it = []
    for s in lines:
        if not s: continue
        m = NOTE.match(s); m0 = None if m else NOTE0.match(s)
        if m: it.append(('n', m.group(1).strip(), m.group(2)))
        elif m0: it.append(('n', None, m0.group(1)))
        else: it.append(('t', STRAY.sub(lambda m: m.group(1) + '[' + m.group(2) + ']', s)))
    return it

def resolve(chs):
    """chs: list of {'label', 'items'}; sets paras/notes. Notes whose [x] marker is in the source text stay out of the text flow
    (and move to the chapter holding the marker); notes without a marker get one inserted where they interrupt the text."""
    report = {'moved': [], 'unlabeled': [], 'dups': []}
    marks = [set(re.findall(r'\[([א-ת])\]', ' '.join(i[1] for i in c['items'] if i[0] == 't'))) for c in chs]
    owned = [dict() for _ in chs]      # label -> text, notes that belong to chapter k via a source marker
    for k, c in enumerate(chs):
        last = None
        flow = []
        for it in c['items']:
            if it[0] == 'n':
                lab, txt = it[1], it[2]
                if lab is None:
                    nxt = SEQ[(SEQ.index(last) + 1) % len(SEQ)] if last else '?'
                    report['unlabeled'].append((c['label'], nxt, txt[:40])); lab = nxt
                last = lab
                tgt = None
                for j in range(k, max(-1, k - 4), -1):
                    if lab in marks[j] and lab not in owned[j]: tgt = j; break
                if tgt is not None:
                    owned[tgt][lab] = fix(txt)
                    if tgt != k: report['moved'].append((c['label'], chs[tgt]['label'], lab))
                    continue
                flow.append(('n', lab, txt))
            else: flow.append(it)
        c['flow'] = flow
    for k, c in enumerate(chs):
        paras, notes, join = [], [], False
        for it in c['flow']:
            if it[0] == 'n':
                lab, txt = it[1], fix(it[2])
                if lab in [n[0] for n in notes] or lab in owned[k]:
                    nl = lab
                    while nl in [n[0] for n in notes] or nl in owned[k] or nl in marks[k]:
                        nl = SEQ[(SEQ.index(nl) + 1) % len(SEQ)]
                    report['dups'].append((c['label'], lab, nl)); lab = nl
                notes.append([lab, txt])
                if paras and f'[{lab}]' not in paras[-1]: paras[-1] += f'[{lab}]'
                join = True
                continue
            s = fix(it[1])
            if join and paras:
                prev = re.sub(r'(\[[א-ת?]\])+$', '', paras[-1])
                if s[:1] in '.,:;!?)' or (prev and prev[-1] not in '.:!?"”)]׃' and not s.startswith('*')):
                    s2 = s.lstrip('.,:;').lstrip() if (s[:1] in '.,:;' and prev[-1:] in '.:;') else s
                    paras[-1] = paras[-1] + (' ' if s2 and s2[0] not in '.,:;!?)' else '') + s2
                    join = False
                    continue
            join = False
            paras.append(s)
        paras = [fix(p) if False else p for p in paras]
        for lab, txt in owned[k].items(): notes.append([lab, txt])
        # order notes by position of their marker
        text = ' '.join(paras)
        notes.sort(key=lambda n: text.find(f'[{n[0]}]') if f'[{n[0]}]' in text else 10**9)
        c['paras'], c['notes'] = paras, notes
    return report

# ---------- locate parts ----------
def canon(n):
    h = ['', 'ק', 'ר', 'ש', 'ת', 'תק', 'תר', 'תש', 'תת', 'תתק', 'תתר'][n // 100] if n < 1100 else ''
    r = n % 100
    if r in (15, 16): return h + ('טו' if r == 15 else 'טז')
    t = ['', 'י', 'כ', 'ל', 'מ', 'נ', 'ס', 'ע', 'פ', 'צ'][r // 10]
    u = ['', 'א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ז', 'ח', 'ט'][r % 10]
    return h + t + u
i_hak = L1.index('הַקְדָּמָה')
i_key = next(i for i, l in enumerate(L1) if l.startswith('מַפְתֵּחַ לִמְצֹא'))
i_pt = L1.index('פְּתִיחָה')
i_first = next(i for i, l in enumerate(L1) if l == 'א.')
pet_end = next(i for i in range(i_pt, i_first) if L1[i] == 'סֵפֶר')
chs = [{'label': 'intro', 'items': items_of(L1[i_hak+1:i_key]) + [('t', L1[i_pt])] + items_of(L1[i_pt+1:pet_end])}]

body = L1[i_first-1:] 
i_tam = next(i for i, l in enumerate(L2) if l.startswith('תַּם וְנִשְׁלַם'))
body += L2[:i_tam]
year, cur, n = '', None, 0
for l in body:
    if not l: continue
    if is_year(l): year = l; continue
    m = re.fullmatch(r'([א-ת]{1,6})\.', l)
    if m:
        n += 1
        cur = {'n': n, 'label': m.group(1), 'year': year, 'items_raw': []}
        chs.append(cur); continue
    if cur is not None: cur.setdefault('lines', []).append(l)
for c in chs[1:]: c['items'] = items_of(c.pop('lines', []))

i_ded = next(i for i, l in enumerate(L2) if l == 'לזכות צבי בן מרים')
i_k2 = next(i for i, l in enumerate(L2) if l == 'מַפְתֵּחַ שְׁמוֹת אֲנָשִׁים')
i_k3 = next(i for i, l in enumerate(L2) if l == 'מַפְתֵּחַ שְׁמוֹת עֲיָרוֹת')
i_print = next(i for i, l in enumerate(L2) if l.startswith('הספר הקדוש הזה נדפס'))
chs.append({'label': 'letters', 'items': [('t', L2[i_tam])] + items_of(L2[i_tam+1:i_ded])})

rep = resolve(chs)

intro = chs[0]
intro_d = {'title': 'הקדמה ופתיחה', 'heading': L1[i_hak], 'heading2': L1[i_pt], 'paras': intro['paras'], 'notes': intro['notes']}
sections = []
prev_ref = 0
for c in chs[1:-1]:
    printed = c['label']
    lab = canon(c['n']) if num(printed) == c['n'] else printed
    pv = num(printed)
    ref = pv if pv in (prev_ref, prev_ref + 1) else prev_ref + 1   # number used by the indexes
    prev_ref = ref
    sections.append({'n': c['n'], 'label': lab, 'ref': ref, 'year': c['year'], 'paras': c['paras'], 'notes': c['notes'], '_printed': printed})

def snippet(p, n=55):
    t = re.sub(r'\[[א-ת?]{1,2}\]', '', p)
    t = re.sub(r'[\u0591-\u05c7]', '', t)
    out_ = ''
    for w in t.split():
        if len(out_) + len(w) > n: break
        out_ += (' ' if out_ else '') + w
    return out_.rstrip(' ,:;-־–')
for s in sections:
    bp = next((p for p in s['paras'] if len(p) > 20), s['paras'][0] if s['paras'] else '')
    s['title'] = f"{s['year']}: {snippet(bp)}" if s['year'] else snippet(bp)

def index(lines, title):
    ps = []
    for l in lines:
        l = fix(l.strip())
        if not l: continue
        ps.append(re.sub(r'^([א-ת])\.$', r'\1', l))
    return {'label': title, 'title': title, 'paras': ps, 'notes': [], 'index': True}
app = [{'label': 'סיום הספר ומכתבים מספר ״אשר בנחל״', 'title': 'מכתבים של מוהרא״ש הקשורים לספר', 'paras': chs[-1]['paras'], 'notes': chs[-1]['notes']}]
app.append(index(L2[i_ded+1:i_k2], 'מפתח מקורות'))
app.append(index(L2[i_k2+1:i_k3], 'מפתח שמות אנשים'))
app.append(index(L2[i_k3+1:i_print], 'מפתח שמות עיירות'))
for k, a in enumerate(app): a['n'] = len(sections) + 1 + k; a['unit'] = ''
data = {'slug': 'peulat-hatzadik', 'title': 'פעולת הצדיק', 'unit': 'סימן', 'unitPlural': 'סימנים', 'intro': intro_d, 'sections': [{k: v for k, v in s.items() if not k.startswith('_')} for s in sections] + app}
json.dump(data, open(out, 'w', encoding='utf8'), ensure_ascii=False, indent=1)

# ---------- report ----------
print('sections', len(sections), 'appendix', len(app), '(expected main sections 1073 = 1072 numbers + one repeated number)')
print('label differs from printed (respelled):', sum(1 for s in sections if s['label'] != s['_printed']), [(s['n'], s['_printed'], s['label']) for s in sections if s['label'] != s['_printed']][:12])
print('printed number != position (kept as printed):', [(s['n'], s['_printed'], num(s['_printed'])) for s in sections if num(s['_printed']) != s['n']][:4])
print('unlabeled notes given a label:', rep['unlabeled'])
print('duplicate labels re-lettered:', rep['dups'])
print('notes moved to the chapter holding their marker:', len(rep['moved']), rep['moved'][:8])
bad = []
for c in [{'label': 'intro', **intro_d}] + data['sections']:
    labs = [x[0] for x in c['notes']]
    mk = re.findall(r'\[([א-ת?]{1,2})\]', ' '.join(c['paras']))
    if not c.get('index') and (sorted(labs) != sorted(mk) or len(set(labs)) != len(labs)): bad.append((c['label'], labs, mk))
print('note/marker mismatches:', len(bad)); [print(' ', b) for b in bad[:15]]
print('notes total', sum(len(c['notes']) for c in data['sections']) + len(intro_d['notes']))
print('holam fixes', len(changed), json.dumps(changed, ensure_ascii=False)[:1500])
print('years', sorted({s['year'] for s in sections}, key=lambda y: (len(y), y)))
