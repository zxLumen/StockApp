#!/usr/bin/env python3
"""把 /data/shadow/{A,B,dual} 的每日快照导出为 parquet（只读）。"""
import argparse, json, pathlib
import pandas as pd

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--data-dir', default='/data')
    ap.add_argument('--out', default='shadow.parquet')
    a = ap.parse_args()
    rows = []
    for chain in ['A', 'B', 'dual']:
        d = pathlib.Path(a.data_dir) / 'shadow' / chain
        if not d.exists():
            continue
        for f in sorted(d.glob('*.json')):
            j = json.loads(f.read_text())
            for t in j.get('top', []):
                rows.append({
                    'date': j.get('date'), 'chain': chain, 'secid': t.get('secid'),
                    'code': t.get('code'), 'name': t.get('name'),
                    'price': t.get('price'), 'ai_hold_days': t.get('aiHoldDays'),
                    'regime_tilt': (j.get('regime') or {}).get('tilt'),
                    'regime_chain': (j.get('regime') or {}).get('chain'),
                })
    df = pd.DataFrame(rows)
    pathlib.Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(a.out, index=False)
    print(f'wrote {a.out}: {len(df)} rows')

if __name__ == '__main__':
    main()
