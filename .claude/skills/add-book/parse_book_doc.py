"""Parse the plain-text export of a vocalized Google Doc book into data/books/<slug>.json.

Usage:  python3 -I parse_book_doc.py <exported.txt> data/books/<slug>.json

Written for "Regey Moharash" and meant as a starting point: it expects
  - a line starting with "הַקְדָּמָה" (first introduction) and a second introduction heading
    starting with "מָה אָשִׁיב" (adapt these markers to the new book),
  - section markers on their own line: "סעיף א." ... (the section number in Hebrew letters),
  - a table of contents after a line starting with "תּכֶֹם"/"תֹּכֶן" whose lines look like "א. כותרת",
  - footnotes as lines "[הערה א] text" with "[א]" markers inside the paragraphs,
  - a closing block that starts with "תִּקּוּן הַכְּלָלִי".
Check the markers against the real document first, then run the verification steps in SKILL.md.

fix_holam() repairs a Google Docs export bug: the holam is attached to the wrong letter
(לאֹ -> לֹא, מְאדֹ -> מְאֹד, אֱלהִֹים -> אֱלֹהִים). Always review the list of distinct changed words.
"""
import re, json, sys, unicodedata
src, out = sys.argv[1], sys.argv[2]
t = open(src, encoding='utf8').read().replace('\r', '').lstrip('﻿')
L = [l.strip() for l in t.split('\n')]
HOLAM = 'ֹ'
LET = re.compile(r'[א-ת]')
VOW = set('ְֱֲֳִֵֶַָֻ')  # vowels other than holam
FINAL = set('םןךףץ')
fixes = 0
def fix_holam(word):
    """Move a holam that the export put on the wrong letter back to the letter before it."""
    global fixes
    cl = []  # clusters: [letter, marks]
    for ch in word:
        if LET.match(ch): cl.append([ch, ''])
        elif cl and unicodedata.combining(ch): cl[-1][1] += ch
        else: cl.append([ch, ''])
    for i, (ch, mk) in enumerate(cl):
        if HOLAM not in mk or ch == 'ו' or i == 0 or not LET.match(cl[i-1][0]): continue
        last = i == len(cl) - 1 or not LET.match(cl[i+1][0])
        two_vowels = any(v in mk for v in VOW)
        prev_has_vowel = any(v in cl[i-1][1] for v in VOW | {HOLAM})
        if two_vowels or (last and (ch in FINAL or ch in 'אד' or ch == 'ז') and not prev_has_vowel):
            cl[i][1] = mk.replace(HOLAM, '', 1); cl[i-1][1] += HOLAM; fixes += 1
    return ''.join(c + m for c, m in cl)
fix = lambda s: re.sub(r'\S+', lambda m: fix_holam(m.group()), s)

def find(pred, start=0):
    return next(i for i in range(start, len(L)) if pred(L[i]))
i_intro1 = find(lambda s: s.startswith('הַקְדָּמָה'))
i_ded = find(lambda s: s.startswith('הספר הקדוש הזה נדפס'), i_intro1)
i_intro2 = find(lambda s: s.startswith('מָה אָשִׁיב'))
i_toc = find(lambda s: s.startswith('תּכֶֹם') or s.startswith('תֹּכֶן'))
i_ded2 = find(lambda s: s.startswith('הספר הקדוש הזה נדפס'), i_intro2)
i_tik = find(lambda s: s.startswith('תִּקּוּן הַכְּלָלִי'))

NOTE = re.compile(r'^\[הערה\s*([^\]]*)\]\s*(.*)$')
def block(lines):
    paras, notes = [], []
    for s in lines:
        if not s: continue
        m = NOTE.match(s)
        if m: notes.append([m.group(1).strip(), fix(m.group(2))])
        else: paras.append(fix(s))
    return paras, notes

intro_paras, intro_notes = block(L[i_intro1+1:i_ded] + [L[i_intro2]] + L[i_intro2+1:find(lambda s: s.startswith('סעיף'), i_intro2)])
# The second introduction opens with a verse heading; keep it as a heading line.
sec_idx = [i for i in range(i_intro2, i_ded2) if re.match(r'^סעיף\s+\S+\.?$', L[i])]
toc = [fix(re.sub(r'^\S+\.\s*', '', L[i])) for i in range(i_toc+1, i_tik) if L[i] and re.match(r'^\S+\.\s', L[i])]
sections = []
for k, i in enumerate(sec_idx):
    j = sec_idx[k+1] if k+1 < len(sec_idx) else i_ded2
    paras, notes = block(L[i+1:j])
    sections.append({'n': k+1, 'label': L[i].replace('סעיף', '').strip(' .'), 'title': toc[k] if k < len(toc) else '', 'paras': paras, 'notes': notes})
tik_paras = [fix(x) for x in L[i_tik+1:] if x]; tik_notes = []
data = {
  'slug': 'regey-moharash', 'title': 'רגעי מוהרא״ש',
  'intro': {'title': 'הקדמה', 'heading': fix(L[i_intro1]), 'heading2': fix(L[i_intro2]), 'paras': intro_paras, 'notes': intro_notes},
  'sections': sections,
  'tikkun': {'title': 'תיקון הכללי', 'paras': tik_paras, 'notes': tik_notes},
}
json.dump(data, open(out, 'w', encoding='utf8'), ensure_ascii=False, indent=1)
print('sections', len(sections), 'toc', len(toc), 'intro paras', len(intro_paras), 'tikkun paras', len(tik_paras), 'notes', sum(len(s['notes']) for s in sections), 'holam fixes', fixes)
print('second intro heading:', L[i_intro2])
for s in sections[:3] + sections[-2:]: print(s['n'], s['label'], '|', s['title'][:60], '|', len(s['paras']), 'paras', len(s['notes']), 'notes')
