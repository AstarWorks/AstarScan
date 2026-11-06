"""Markdown table of a book-e2e results file (run-books.mjs's JSON lines),
one row per run and a total, in the form docs/book4-eval.md uses.

    python3 -I jsonl-table.py <results.jsonl> [--runs b5-]

--runs keeps the runs whose name contains the text (b5- : book 5 only).
"""
import json
import sys

LABEL = {
    'b1-f-': ('1冊目', '720×960'), 'b2-f-': ('2冊目', '720×960'), 'b3-f-': ('3冊目', '720×960'),
    'b4-f-': ('4冊目', '720×960'), 'b5-f-': ('5冊目', '720×960'), 'b6-f-': ('6冊目', '720×960'),
    'b2-o-': ('2冊目', '元の解像度'), 'b3-o-': ('3冊目', '元の解像度'), 'b4-o-': ('4冊目', '元の解像度'),
    'b5-o-': ('5冊目', '元の解像度'), 'b6-o-': ('6冊目', '元の解像度'),
}


def f1(x, d=1):
    return '—' if x is None else f'{x:.{d}f}'


def pair(a, b, d=1):
    return f'{f1(a, d)}/{f1(b, d)}'


def row_name(run):
    for k, (book, size) in LABEL.items():
        if run.startswith(k):
            return f'{book} {size} {run[len(k):]}'
    return run


def main():
    args = sys.argv[1:]
    only = None
    if '--runs' in args:
        i = args.index('--runs')
        only = args[i + 1]
        del args[i:i + 2]
    rows = [json.loads(l) for l in open(args[0], encoding='utf-8') if l.strip()]
    if only:
        rows = [r for r in rows if only in r['run']]
    print('| run | 対象 | ✓ | 赤 | 無表示 | 偽の赤 | 番号 正/誤/読めず | 誤り | 保留のまま / 後で出た | 枠 中央値/最大 | 綴じ目 中央値/最大 | fps | ✓まで 中央値/最大 | 番号まで 中央値/最大 | めくり中 | 曲がり補正 |')
    print('|' + '---|' * 16)
    tot = dict(targets=0, check=0, red=0, silent=0, falseRed=0, right=0, wrong=0, unread=0)
    for r in rows:
        s = r['summary']
        red = f"{s['red']}" + (f" ({','.join(str(p['page']) for p in r['pageRows'] if p['state'] == 'red')})" if s['red'] else '')
        silent = f"{s['silent']}" + (f" ({','.join(map(str, s['silentPages']))})" if s['silent'] else '')
        held = ' / '.join('・'.join(str(n) for n in h['numbers'] if n is not None) for h in s.get('numbersHeldBack', []))
        late = ' / '.join('・'.join(str(n) for n in h['numbers']) for h in s.get('numbersShownLate', []))
        heldlate = (held or '—') + ((' → 後で ' + late) if late else '')
        print(f"| {row_name(r['run'])} | {s['targets']} | {s['check']} | {red} | {silent} | {s['falseRed']} | "
              f"{s['numbersRight']}/{s['numbersWrong']}/{s['numbersUnread']} | {' '.join(s['wrongPages'])} | {heldlate} | "
              f"{pair(s['cornerMedian'], s['cornerMax'])} | {pair(s['gutterMedian'], s['gutterMax'])} | {f1(s['fps'])} | "
              f"{pair(s['checkSMedian'], s['checkSMax'], 2)} | {pair(s['numberSMedian'], s['numberSMax'], 2)} | "
              f"{s['capturesInTurn']} | {s['flattened']} |")
        tot['targets'] += s['targets']; tot['check'] += s['check']; tot['red'] += s['red']; tot['silent'] += s['silent']
        tot['falseRed'] += s['falseRed']; tot['right'] += s['numbersRight']; tot['wrong'] += s['numbersWrong']; tot['unread'] += s['numbersUnread']
    print(f"| **合計** | {tot['targets']} | {tot['check']} | {tot['red']} | {tot['silent']} | {tot['falseRed']} | "
          f"{tot['right']}/{tot['wrong']}/{tot['unread']} | | | | | | | | | |")


if __name__ == '__main__':
    main()
