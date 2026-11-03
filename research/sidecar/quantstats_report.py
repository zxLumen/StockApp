#!/usr/bin/env python3
"""读 returns.csv（date,strategy,ret）→ 每个策略一份 QuantStats HTML。"""
import argparse, pathlib
import pandas as pd
import quantstats as qs

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--in', dest='inp', required=True)
    ap.add_argument('--out', default='tearsheets')
    a = ap.parse_args()
    df = pd.read_csv(a.inp, parse_dates=['date'])
    out = pathlib.Path(a.out); out.mkdir(parents=True, exist_ok=True)
    for strat, g in df.groupby('strategy'):
        s = g.set_index('date')['ret'].sort_index()
        qs.reports.html(s, output=str(out / f'{strat}.html'), title=strat)
        print('wrote', out / f'{strat}.html')

if __name__ == '__main__':
    main()
