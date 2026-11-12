/** 分时纯计算的类型声明；实现见 intraday.js（刻意用 .js 以便 node --test 直接 import）。 */

export declare const SESSION_SLOTS: number

export declare function barDay(time: string): string
export declare function sessionSlot(time: string): number | null
export declare function slotLabel(slot: number): string
export declare function dayStartTs(day: string): number
export declare function slotTs(day: string, slot: number): number
export declare function tsToSlot(day: string, ts: number): number
export declare function avgPrices(
  bars: Array<{ close?: number | null; volume?: number | null }>,
): Array<number | null>
export declare function lastDayBars<T extends { time: string }>(bars: T[]): T[]
